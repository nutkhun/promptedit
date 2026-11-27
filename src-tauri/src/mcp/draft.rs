//! Magic's drafts (Editroom's `MCPDraft`): a hidden copy of the project that a Magic run's agent
//! edits through `/mcp?draft=<token>`. Each tool call is one step on the draft's own undo history
//! (the agent's `history` tool works on that), and nothing reaches the person's timeline until the
//! run finishes, when the finished draft is laid onto the project as it is then, as one undo step.

use promptedit_core::history::Document;
use promptedit_core::{Id, Project};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct Draft {
    pub token: String,
    /// The project when the run started.
    pub base: Project,
    pub doc: Document,
    /// Where get_frame looks by default; moved by the playback tool.
    pub playhead: f64,
    /// Tool calls made.
    pub calls: u32,
    /// Calls that changed the draft.
    pub steps: u32,
    /// What the agent is doing now ("looking at beach.mov"), for the Magic button.
    pub activity: Option<String>,
}

impl Draft {
    /// Whether the agent changed anything worth laying onto the timeline.
    pub fn changed(&self) -> bool {
        let mut a = self.base.clone();
        let mut b = self.doc.project.clone();
        // Library additions (download_media) reach the person's library at once, not with the draft.
        a.assets.clear();
        b.assets.clear();
        a.magic_history = None;
        b.magic_history = None;
        a != b
    }
}

pub type Shared = Arc<Mutex<Draft>>;

#[derive(Default)]
pub struct Drafts(Mutex<HashMap<String, Shared>>);

impl Drafts {
    pub fn open(&self, project: &Project, playhead: f64) -> Shared {
        let token = Id::new().0.simple().to_string();
        let d = Arc::new(Mutex::new(Draft {
            token: token.clone(),
            base: project.clone(),
            doc: Document::new(project.clone()),
            playhead,
            calls: 0,
            steps: 0,
            activity: None,
        }));
        self.0.lock().unwrap().insert(token, d.clone());
        d
    }

    pub fn find(&self, token: &str) -> Option<Shared> {
        self.0.lock().unwrap().get(token).cloned()
    }

    pub fn close(&self, token: &str) -> Option<Shared> {
        self.0.lock().unwrap().remove(token)
    }

    pub fn is_open(&self, token: &str) -> bool {
        self.0.lock().unwrap().contains_key(token)
    }
}

/// The draft's changes laid onto the project as it is `now` (it may have changed while the agent
/// worked: media imported, say). Clips the agent removed go, clips it added or changed come in as
/// it left them, and the sequence, tracks, markers, in/out and captions follow the draft where the
/// agent changed them. Editroom replays the agent's steps as a plan (`MCPDraft.resultPlan`) for its
/// swarm animation; the end state is the same.
pub fn merged(base: &Project, done: &Project, now: &Project) -> Project {
    let mut out = now.clone();
    let base_clips: HashMap<Id, &promptedit_core::Clip> = base.clips.iter().map(|c| (c.id, c)).collect();
    let done_ids: std::collections::HashSet<Id> = done.clips.iter().map(|c| c.id).collect();
    out.clips.retain(|c| !(base_clips.contains_key(&c.id) && !done_ids.contains(&c.id)));
    for c in &done.clips {
        let changed = base_clips.get(&c.id).is_none_or(|b| *b != c);
        if !changed {
            continue;
        }
        match out.clips.iter_mut().find(|x| x.id == c.id) {
            Some(x) => *x = c.clone(),
            None => out.clips.push(c.clone()),
        }
    }
    macro_rules! follow {
        ($($f:ident),*) => { $( if base.$f != done.$f { out.$f = done.$f.clone(); } )* };
    }
    follow!(width, height, fps, settings_locked, video_tracks, audio_tracks, markers, in_point, out_point, captions, caption_fixes, export_name);
    for a in &done.assets {
        if !out.assets.iter().any(|x| x.id == a.id) {
            out.assets.push(a.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use promptedit_core::{Clip, ClipKind};

    #[test]
    fn merge_keeps_what_happened_meanwhile() {
        let mut base = Project::default();
        let v1 = base.video_tracks[0].id;
        let keep = Clip { track_id: v1, kind: ClipKind::Solid, duration: 2.0, ..Clip::default() };
        let gone = Clip { track_id: v1, kind: ClipKind::Solid, start: 2.0, duration: 2.0, ..Clip::default() };
        base.clips = vec![keep.clone(), gone.clone()];
        let mut done = base.clone();
        done.clips.retain(|c| c.id != gone.id);
        done.clips.push(Clip { track_id: v1, kind: ClipKind::Text, start: 5.0, duration: 1.0, ..Clip::default() });
        done.width = 1080;
        let mut now = base.clone();
        now.height = 720; // changed by the person meanwhile
        let m = merged(&base, &done, &now);
        assert_eq!(m.clips.len(), 2);
        assert!(m.clip(gone.id).is_none());
        assert_eq!((m.width, m.height), (1080, 720));
    }
}
