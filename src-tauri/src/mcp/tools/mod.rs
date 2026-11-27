//! The tools agents get (Editroom's `MCPTools`). Reading is instant; every change goes through the
//! core edit commands on the shared document and is exactly one undo step, shared with the person's
//! own undo. In a Magic run (`?draft=`) the same tools edit the run's hidden draft instead.

mod args;
mod edit;
mod media;
mod more;

pub use args::*;
pub use media::block_on;

use super::draft::Shared;
use super::host::Host;
use super::json;
use super::presence::Presence;
use super::protocol;
use promptedit_core::edit::{Edit, Outcome};
use promptedit_core::history::Document;
use promptedit_core::{Id, Project};
use serde_json::{Value, json};

/// The built-in looks for set_grade, in menu order ("Faded" is retired but still accepted).
pub const LOOKS: [&str; 8] = ["Warm film", "Golden hour", "Film print", "Teal and orange", "Pastel", "Bleach bypass", "Mono", "Cool night"];

pub fn is_look(name: &str) -> bool {
    LOOKS.contains(&name) || name == "Faded"
}

/// A tool's failure, said to the agent as the tool's result.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolError(pub String);

impl<S: Into<String>> From<S> for ToolError {
    fn from(s: S) -> Self {
        ToolError(s.into())
    }
}

pub type Content = Vec<Value>;
pub type Out = Result<Content, ToolError>;

pub fn text(s: impl Into<String>) -> Content {
    vec![json!({"type": "text", "text": s.into()})]
}

pub fn json_text(v: Value) -> Content {
    text(json::pretty(&v))
}

/// Where an edit happened, for the agent's cursor.
#[derive(Default, Clone)]
pub struct Spot {
    pub time: Option<f64>,
    pub track: Option<Id>,
    pub clips: Vec<Id>,
}

impl Spot {
    pub fn at(time: f64, track: Id) -> Self {
        Spot { time: Some(time), track: Some(track), clips: vec![] }
    }
    pub fn clips(p: &Project, ids: &[Id]) -> Self {
        let first = ids.iter().filter_map(|i| p.clip(*i)).min_by(|a, b| a.start.total_cmp(&b.start));
        Spot { time: first.map(|c| c.start), track: first.map(|c| c.track_id), clips: ids.to_vec() }
    }
    pub fn none() -> Self {
        Spot::default()
    }
}

/// One tool call: who's calling, and whether it's a Magic run's draft.
pub struct Call<'a> {
    pub host: &'a dyn Host,
    pub name: &'a str,
    pub args: &'a Value,
    /// The agent's cursor name ("Claude", "Codex", "Agent").
    pub who: String,
    pub draft: Option<Shared>,
}

impl Call<'_> {
    /// The project as it is now: the Magic draft's while there is one.
    pub fn now(&self) -> Project {
        match &self.draft {
            Some(d) => d.lock().unwrap().doc.project.clone(),
            None => self.host.state().doc.lock().unwrap().project.clone(),
        }
    }

    pub fn title(&self) -> String {
        let file = self.host.state().file.lock().unwrap().clone();
        file.as_deref()
            .and_then(std::path::Path::file_stem)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into())
    }

    pub fn playhead(&self) -> f64 {
        match &self.draft {
            Some(d) => d.lock().unwrap().playhead,
            None => super::mcp().view.lock().unwrap().playhead,
        }
    }

    pub fn in_magic(&self) -> bool {
        self.draft.is_some()
    }

    pub fn not_in_magic(&self) -> Result<(), ToolError> {
        if self.draft.is_some() {
            return Err(format!("{} isn't available while making a Magic edit.", self.name).into());
        }
        Ok(())
    }

    /// Makes one change as one undo step: on the draft in a Magic run, otherwise on the person's
    /// project (then the UI is told, and the agent's cursor is parked where it happened). Returns
    /// the project after the change.
    pub fn perform(&self, label: &str, spot: Spot, body: impl FnOnce(&mut Project) -> Result<(), ToolError>) -> Result<Project, ToolError> {
        if let Some(d) = &self.draft {
            let mut d = d.lock().unwrap();
            let mut p = d.doc.project.clone();
            body(&mut p)?;
            if d.doc.mutate(|q| *q = p) {
                d.steps += 1;
            }
            return Ok(d.doc.project.clone());
        }
        let (after, changed) = {
            let mut doc = self.host.state().doc.lock().unwrap();
            let mut p = doc.project.clone();
            body(&mut p)?;
            let changed = doc.mutate(|q| *q = p);
            (doc.project.clone(), changed)
        };
        if changed {
            self.host.project_changed();
            let mut pr = Presence::new(&self.who, label);
            pr.time = spot.time;
            pr.track = spot.track.map(|t| json::track_name(t, &after));
            pr.clip_ids = spot.clips.iter().map(|c| c.to_string()).collect();
            self.host.emit("agent-presence", serde_json::to_value(pr).unwrap_or(Value::Null));
        }
        Ok(after)
    }
}

/// Applies a core edit command to a project in place (inside a tool's one step).
pub fn apply_edit(p: &mut Project, e: Edit) -> Outcome {
    let mut d = Document::new(std::mem::take(p));
    let out = e.apply(&mut d);
    *p = d.project;
    out
}

/// Runs a tool and returns the `tools/call` result (`{content, isError}`).
pub fn call(host: &dyn Host, name: &str, args: &Value, who: Option<String>, draft: Option<Shared>) -> Value {
    if let Some(d) = &draft {
        let mut d = d.lock().unwrap();
        d.calls += 1;
        d.activity = describe(name, args, &d.doc.project);
    }
    let c = Call { host, name, args, who: who.unwrap_or_else(|| "Agent".into()), draft };
    let out = edit::call(&c).or_else(|| media::call(&c)).or_else(|| more::call(&c)).unwrap_or_else(|| Err(format!("No tool called {name}.").into()));
    match out {
        Ok(content) => json!({"content": content, "isError": false}),
        Err(ToolError(m)) => protocol::failure(&m),
    }
}

/// What a Magic run's tool call is doing, as the Magic button says it after "Claude is"
/// (Editroom's `MCPHandler.describe`); None keeps the stage word.
pub fn describe(name: &str, args: &Value, p: &Project) -> Option<String> {
    let short = |s: &str| {
        let base = std::path::Path::new(s).file_stem().map(|b| b.to_string_lossy().into_owned()).unwrap_or_else(|| s.to_string());
        if base.chars().count() > 24 { base.chars().take(23).collect::<String>() + "…" } else { base }
    };
    let asset = || {
        let s = args.get("asset_id")?.as_str()?;
        let id: Id = s.parse().ok()?;
        p.assets.iter().find(|a| a.id == id).map(|a| short(&a.name))
    };
    let clip = || {
        let id: Id = args.get("clip_id")?.as_str()?.parse().ok()?;
        p.clip(id).map(|c| short(&p.name_of(c)))
    };
    let quoted = |k: &str| {
        let t = args.get(k)?.as_str()?.trim().to_string();
        if t.is_empty() {
            return None;
        }
        Some(format!("“{}”", if t.chars().count() > 22 { t.chars().take(21).collect::<String>() + "…" } else { t }))
    };
    let on = |verb: &str, what: Option<String>| Some(what.map(|w| format!("{verb} {w}")).unwrap_or_else(|| verb.to_string()));
    match name {
        "list_media" => Some("going through the media".into()),
        "get_project" => Some("reading the timeline".into()),
        "list_looks" => Some("browsing looks".into()),
        "look_at_media" => on("looking at", asset()),
        "note_media" => on("taking notes on", asset()),
        "analyze_media" => on("studying", asset()),
        "get_transcript" => on("reading what’s said in", asset()),
        "get_frame" => Some(asset().map(|a| format!("checking a frame of {a}")).unwrap_or_else(|| "checking a frame".into())),
        "search_media" => match quoted("said") {
            Some(q) => Some(format!("searching for {q}")),
            None => on("searching for", Some(quoted("shows").unwrap_or_else(|| "a shot".into()))),
        },
        "add_clip" => on("placing", asset()),
        "add_title" => on("adding the title", quoted("text")),
        "add_solid" => Some("adding a solid".into()),
        "move_clip" => on("moving", clip()),
        "trim_clip" => on("trimming", clip()),
        "split_clip" => on("splitting", clip()),
        "delete_clips" => Some("removing clips".into()),
        "duplicate_clip" => on("duplicating", clip()),
        "set_speed" | "set_speed_ramp" => on("changing the speed of", clip()),
        "reverse_clip" => on("reversing", clip()),
        "freeze_frame" => on("freezing a frame of", clip()),
        "set_grade" => on("grading", clip()),
        "set_audio" => on("mixing", clip()),
        "detach_audio" => on("detaching the sound of", clip()),
        "set_transition" => Some("adding a transition".into()),
        "set_transform" => on("framing", clip()),
        "set_title_style" => Some("styling the title".into()),
        "set_sequence" => Some("setting up the sequence".into()),
        "add_track" | "set_track" => Some("arranging tracks".into()),
        "set_marker" | "delete_markers" => Some("marking moments".into()),
        "set_in_out" => Some("setting the in and out".into()),
        "download_media" => on("downloading", quoted("name")),
        "history" => Some("undoing a step".into()),
        _ => None,
    }
}

/// `%g`, as Editroom's undo labels write speeds ("Speed ×4", "Slow ×0.25").
pub fn fmt_g(v: f64) -> String {
    let s = format!("{}", (v * 1e6).round() / 1e6);
    s.trim_end_matches(".0").to_string()
}
