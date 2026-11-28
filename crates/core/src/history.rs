//! The open document and its undo history (Editroom/Model/EditorModel.swift: `mutate`, `live`,
//! `undo`, `redo`). Undo works on whole-project snapshots, up to 200 steps. The media library
//! and Magic's prompt history aren't undone: imports stay, and items a step deleted come back.

use crate::id::Id;
use crate::model::{MediaAsset, Project};
use crate::paths::folder_contains;
use std::collections::{HashMap, HashSet};

const UNDO_LIMIT: usize = 200;

#[derive(Clone, Debug, Default)]
pub struct Document {
    pub project: Project,
    undo: Vec<Project>,
    redo: Vec<Project>,
    redo_known: Vec<HashSet<Id>>,
    /// The project before a continuous change (drag, slider) began; one undo step on commit.
    live_snapshot: Option<Project>,
    pub dirty: bool,
    /// Assets whose file was deleted from a linked folder: undo doesn't bring them back.
    pub dropped_from_disk: HashSet<Id>,
    /// Linked folders being imported right now, kept even while empty.
    pub importing_folders: HashSet<Id>,
}

impl Document {
    pub fn new(project: Project) -> Self {
        Document { project, ..Default::default() }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty() || self.live_snapshot.is_some()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// One undoable change. Returns whether anything changed.
    pub fn mutate(&mut self, body: impl FnOnce(&mut Project)) -> bool {
        self.commit_live();
        let mut p = self.project.clone();
        body(&mut p);
        p.sanitize();
        if p == self.project {
            return false;
        }
        self.undo.push(std::mem::replace(&mut self.project, p));
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.redo_known.clear();
        self.dirty = true;
        true
    }

    /// A change that belongs to the last undo step; with nothing to undo, a step of its own.
    pub fn amend_last_step(&mut self, body: impl FnOnce(&mut Project)) -> bool {
        self.commit_live();
        if self.undo.is_empty() {
            return self.mutate(body);
        }
        let mut p = self.project.clone();
        body(&mut p);
        p.sanitize();
        if p == self.project {
            return false;
        }
        self.redo.clear();
        self.redo_known.clear();
        self.project = p;
        self.dirty = true;
        true
    }

    /// Continuous change (drag, slider): coalesces into one undo step at `commit_live`.
    pub fn live(&mut self, body: impl FnOnce(&mut Project)) -> bool {
        let mut p = self.project.clone();
        body(&mut p);
        if p == self.project {
            return false;
        }
        if self.live_snapshot.is_none() {
            self.live_snapshot = Some(self.project.clone());
        }
        self.project = p;
        self.dirty = true;
        true
    }

    /// Whether a continuous change (drag, slider) is under way and not yet committed.
    pub fn is_live(&self) -> bool {
        self.live_snapshot.is_some()
    }

    /// Throws away an uncommitted live change.
    pub fn discard_live(&mut self) {
        if let Some(s) = self.live_snapshot.take() {
            self.project = s;
        }
    }

    pub fn commit_live(&mut self) {
        if let Some(s) = self.live_snapshot.take()
            && s != self.project
        {
            self.undo.push(s);
            self.redo.clear();
            self.redo_known.clear();
        }
    }

    pub fn undo(&mut self) -> bool {
        self.commit_live();
        let Some(mut prev) = self.undo.pop() else { return false };
        self.redo_known.push(prev.assets.iter().map(|a| a.id).collect());
        prev.assets = restoring(&prev.assets, &self.project.assets);
        let used_then: HashSet<Id> = prev.clips.iter().filter_map(|c| c.asset_id).collect();
        prev.assets.retain(|a| !(self.dropped_from_disk.contains(&a.id) && !used_then.contains(&a.id)));
        keep_folders(&mut prev, &self.project, &self.importing_folders);
        prev.magic_history = self.project.magic_history.clone();
        self.redo.push(std::mem::replace(&mut self.project, prev));
        self.dirty = true;
        true
    }

    pub fn redo(&mut self) -> bool {
        self.commit_live();
        let Some(mut next) = self.redo.pop() else { return false };
        let known = self.redo_known.pop().unwrap_or_default();
        let now: HashSet<Id> = next.assets.iter().map(|a| a.id).collect();
        let deleted: HashSet<Id> = known.difference(&now).copied().collect();
        next.assets = self.project.assets.iter().filter(|a| !deleted.contains(&a.id)).cloned().collect();
        keep_folders(&mut next, &self.project, &self.importing_folders);
        next.magic_history = self.project.magic_history.clone();
        self.undo.push(std::mem::replace(&mut self.project, next));
        self.dirty = true;
        true
    }
}

/// The library now, with any items from `earlier` that are missing put back where they were.
fn restoring(earlier: &[MediaAsset], now: &[MediaAsset]) -> Vec<MediaAsset> {
    let mut current: HashMap<Id, &MediaAsset> = HashMap::new();
    for a in now {
        current.entry(a.id).or_insert(a);
    }
    let earlier_ids: HashSet<Id> = earlier.iter().map(|a| a.id).collect();
    earlier
        .iter()
        .map(|a| current.get(&a.id).map(|c| (*c).clone()).unwrap_or_else(|| a.clone()))
        .chain(now.iter().filter(|a| !earlier_ids.contains(&a.id)).cloned())
        .collect()
}

/// Linked folders follow the library: those of either version that still hold something stay.
fn keep_folders(p: &mut Project, now: &Project, importing: &HashSet<Id>) {
    let mut folders = now.folders.clone().unwrap_or_default();
    for f in p.folders.iter().flatten() {
        if !folders.iter().any(|x| x.id == f.id) {
            folders.push(f.clone());
        }
    }
    p.folders = (!folders.is_empty()).then_some(folders);
    let mut hidden: Vec<String> = p.hidden_media.iter().flatten().chain(now.hidden_media.iter().flatten()).cloned().collect();
    hidden.sort();
    hidden.dedup();
    p.hidden_media = (!hidden.is_empty()).then_some(hidden);
    p.prune_folders(importing);
}

impl Project {
    /// Linked folders with nothing left in the project are let go (kept while importing).
    pub fn prune_folders(&mut self, keeping: &HashSet<Id>) {
        let Some(f) = &self.folders else { return };
        let kept: Vec<_> = f
            .iter()
            .filter(|folder| keeping.contains(&folder.id) || self.assets.iter().any(|a| folder_contains(&folder.path, &a.path)))
            .cloned()
            .collect();
        if let Some(h) = self.hidden_media.as_mut() {
            h.retain(|h| kept.iter().any(|k| folder_contains(&k.path, h)));
            if h.is_empty() {
                self.hidden_media = None;
            }
        }
        self.folders = (!kept.is_empty()).then_some(kept);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Clip, ClipKind, MediaKind};

    fn asset() -> MediaAsset {
        MediaAsset {
            id: Id::new(),
            path: "/m/a.mov".into(),
            relative_path: None,
            playable_path: None,
            name: "a".into(),
            kind: MediaKind::Video,
            duration: 10.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            bookmark: None,
        }
    }

    #[test]
    fn undo_keeps_imports() {
        let mut d = Document::new(Project::default());
        let track = d.project.video_tracks[0].id;
        let a = asset();
        let aid = a.id;
        d.mutate(|p| {
            p.clips.push(Clip { track_id: track, kind: ClipKind::Video, asset_id: Some(aid), duration: 2.0, ..Clip::default() })
        });
        // Imported after the edit, outside undo.
        d.project.assets.push(a);
        assert!(d.undo());
        assert!(d.project.clips.is_empty());
        assert_eq!(d.project.assets.len(), 1, "the import survives undo");
        assert!(d.redo());
        assert_eq!(d.project.clips.len(), 1);
    }

    #[test]
    fn live_changes_are_one_step() {
        let mut d = Document::new(Project::default());
        for w in [100, 200, 300] {
            d.live(|p| p.width = w);
        }
        d.commit_live();
        d.undo();
        assert_eq!(d.project.width, 1920);
        assert!(!d.can_undo());
    }
}
