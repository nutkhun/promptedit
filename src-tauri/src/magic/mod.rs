//! Magic (docs/spec/03-mcp-magic.md §3): one button that makes or improves the edit, with Claude,
//! ChatGPT or Local. AI runs drive the vendor CLIs over PromptEdit's MCP draft endpoint (`agent`);
//! Local runs Editroom's heuristic planners on this computer (`local`). Either way the result is one
//! undo step. The UI polls `magic_state` for progress and the note at the end.

pub mod agent;
pub mod analyzer;
pub mod brief;
pub mod commands;
pub mod improver;
pub mod local;
pub mod mentions;
pub mod plan;
pub mod planner;
pub mod recipe;

use serde::Serialize;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Claude,
    Chatgpt,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Claude => "Claude",
            Kind::Chatgpt => "ChatGPT",
        }
    }
    /// The Magic tab it's on (and what history records).
    pub fn tab(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Chatgpt => "chatgpt",
        }
    }
}

/// What a run said when it finished, shown under the Magic button; or an alert (`title`).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// claude, chatgpt, or None for Local.
    pub agent: Option<String>,
    pub text: String,
    /// It changed the timeline (so there's something to undo).
    pub changed: bool,
    /// "Opus 5.5 · Low · 54s" / "On this Mac · 3s".
    pub detail: String,
    /// Shown as an alert with this title instead of a note.
    pub title: Option<String>,
    /// The alert offers Sign In.
    pub sign_in: bool,
}

/// Magic's state, as the UI shows it.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub running: bool,
    /// claude / chatgpt / local.
    pub tab: Option<String>,
    /// "Claude is thinking", "Analyzing 2 of 5".
    pub status: Option<String>,
    /// What the agent is doing right now ("looking at beach.mov"), from its tool calls.
    pub activity: Option<String>,
    pub note: Option<Note>,
    pub seconds: f64,
}

#[derive(Default)]
pub struct Magic {
    state: Mutex<State>,
    run_id: AtomicU64,
    started: Mutex<Option<Instant>>,
    child: Mutex<Option<Child>>,
    draft: Mutex<Option<String>>,
    pub(crate) started_server: AtomicBool,
}

static MAGIC: OnceLock<Magic> = OnceLock::new();

pub fn magic() -> &'static Magic {
    MAGIC.get_or_init(Magic::default)
}

impl Magic {
    /// Starts a run (one at a time). Returns its id.
    pub fn begin(&self, tab: &str, status: &str) -> Result<u64, String> {
        let mut s = self.state.lock().unwrap();
        if s.running {
            return Err("Magic is already working.".into());
        }
        *s = State { running: true, tab: Some(tab.into()), status: Some(status.into()), ..Default::default() };
        *self.started.lock().unwrap() = Some(Instant::now());
        Ok(self.run_id.fetch_add(1, Ordering::SeqCst) + 1)
    }

    pub fn is_current(&self, id: u64) -> bool {
        self.run_id.load(Ordering::SeqCst) == id && self.state.lock().unwrap().running
    }

    pub fn elapsed(&self) -> Duration {
        self.started.lock().unwrap().map(|s| s.elapsed()).unwrap_or_default()
    }

    pub fn set_status(&self, s: &str) {
        self.state.lock().unwrap().status = Some(s.into());
    }

    pub fn clear_status(&self) {
        self.state.lock().unwrap().status = None;
    }

    pub fn set_draft(&self, token: Option<String>) {
        *self.draft.lock().unwrap() = token;
    }

    pub fn set_child(&self, c: Option<Child>) {
        *self.child.lock().unwrap() = c;
    }

    pub fn take_child(&self) -> Option<Child> {
        self.child.lock().unwrap().take()
    }

    pub fn finish(&self, note: Note) {
        let mut s = self.state.lock().unwrap();
        s.running = false;
        s.status = None;
        s.activity = None;
        s.note = (!note.text.is_empty() || note.title.is_some()).then_some(note);
    }

    /// Stops the run with nothing changed: the CLI is ended and its draft closed.
    pub fn stop(&self) {
        self.run_id.fetch_add(1, Ordering::SeqCst);
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
        if let Some(t) = self.draft.lock().unwrap().take() {
            crate::mcp::mcp().drafts.close(&t);
        }
        let mut s = self.state.lock().unwrap();
        s.running = false;
        s.status = None;
        s.activity = None;
    }

    pub fn dismiss_note(&self) {
        self.state.lock().unwrap().note = None;
    }

    pub fn snapshot(&self) -> State {
        let mut s = self.state.lock().unwrap().clone();
        s.seconds = self.elapsed().as_secs_f64();
        if let Some(t) = self.draft.lock().unwrap().as_ref()
            && let Some(d) = crate::mcp::mcp().drafts.find(t)
        {
            s.activity = d.lock().unwrap().activity.clone();
        }
        s
    }
}

/// Magic's prompt history: per project, newest first, each once, at most 20. Not undone.
pub fn add_history(p: &mut promptedit_core::Project, text: &str, tab: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    let mut list = p.magic_history.clone().unwrap_or_default();
    list.retain(|e| e.text != t);
    // Swift's reference date (2001-01-01).
    let date = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0) - 978_307_200.0;
    list.insert(0, promptedit_core::MagicHistoryEntry { text: t.into(), tab: tab.into(), date });
    list.truncate(20);
    p.magic_history = Some(list);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_unique_newest_first_and_survives_undo() {
        let mut doc = promptedit_core::history::Document::new(promptedit_core::Project::default());
        for t in ["a", "b", "a"] {
            add_history(&mut doc.project, t, "local");
        }
        let h = doc.project.magic_history.clone().unwrap();
        assert_eq!(h.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        doc.mutate(|p| p.width = 100);
        add_history(&mut doc.project, "c", "claude");
        doc.undo();
        assert_eq!(doc.project.magic_history.unwrap().len(), 3, "history isn't undone");
    }
}
