//! Linked folders (Editroom/Model/MediaFolders.swift, docs/spec/01-model.md §2.17, §3.19): a folder on
//! disk brought into the project whole, which the Media panel mirrors. Only the linked folders are
//! stored; the folders inside them are worked out from where their files are. Files taken out of a
//! linked folder by hand are listed in `hiddenMedia`, so a later look at the folder doesn't bring them
//! back.
//!
//! Everything here is pure: the scanning and watching of folders on disk lives in the app
//! (`src-tauri/src/folders.rs`).

use crate::id::Id;
use crate::model::{MediaFolder, Project};
use crate::paths::folder_contains;
use std::cmp::Ordering;
use std::collections::HashSet;

/// File extensions a folder scan brings in: what Editroom's `MediaFolder.types` accepts (movies, video,
/// audio, images) that FFmpeg reads, plus the formats Editroom converts with FFmpeg.
pub const MEDIA_EXTENSIONS: &[&str] = &[
    // Video and audio-visual containers.
    "mp4", "mov", "m4v", "qt", "mkv", "webm", "avi", "flv", "wmv", "asf", "mts", "m2ts", "ts", "mxf", "ogv", "3gp",
    "3g2", "mpg", "mpeg", "m2v", "vob", "f4v", "dv", "hevc",
    // Audio.
    "wav", "mp3", "m4a", "m4b", "aac", "aif", "aiff", "aifc", "caf", "ogg", "opus", "flac", "wma", "ac3", "amr",
    // Images.
    "jpg", "jpeg", "png", "heic", "heif", "gif", "tif", "tiff", "bmp", "webp", "avif",
];

/// The part of a path after its last `/` or `\`.
pub fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// The folder a path is in (Swift `deletingLastPathComponent`), in the path's own spelling.
pub fn parent_dir(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(0) => &trimmed[..1],
        Some(i) => &trimmed[..i],
        None => "",
    }
}

/// Whether a file is media by its extension (case-insensitive).
pub fn is_media_path(path: &str) -> bool {
    let name = file_name(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => MEDIA_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        _ => false,
    }
}

/// Finder-like name order (Swift `localizedStandardCompare`): case-insensitive, and runs of digits
/// compare by their value, so "Clip 2" comes before "Clip 10".
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(&c) = it.peek().filter(|c| c.is_ascii_digit()) {
                        s.push(c);
                        it.next();
                    }
                    s
                };
                let (m, n) = (take(&mut x), take(&mut y));
                let (mt, nt) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let o = mt.len().cmp(&nt.len()).then_with(|| mt.cmp(nt));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o != Ordering::Equal {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

impl Project {
    /// The linked folder that holds `path`, if any (the innermost, if they're nested).
    pub fn linked_folder_holding(&self, path: &str) -> Option<&MediaFolder> {
        self.folders.iter().flatten().filter(|f| folder_contains(&f.path, path)).max_by_key(|f| f.path.len())
    }

    /// Whether a file in a linked folder was taken out of the project (it, or a folder it's in, is hidden).
    pub fn is_hidden(&self, path: &str) -> bool {
        self.hidden_media.iter().flatten().any(|h| folder_contains(h, path))
    }

    /// The folder an item is shown in in the Media panel: the folder its file is in when that's inside a
    /// linked folder; None for the top of the panel (Swift `MediaTree.folder(of:)`).
    pub fn media_place<'a>(&self, asset_path: &'a str) -> Option<&'a str> {
        self.linked_folder_holding(asset_path).map(|_| parent_dir(asset_path))
    }

    /// The items in a Media panel folder and every folder inside it (Swift `MediaTree.assets(under:)`).
    pub fn assets_under(&self, folder: &str) -> Vec<Id> {
        self.assets
            .iter()
            .filter(|a| self.media_place(&a.path).is_some_and(|p| folder_contains(folder, p)))
            .map(|a| a.id)
            .collect()
    }

    /// A file brought in by hand is no longer left out of its folder (Swift `importFiles`).
    pub fn unhide(&mut self, path: &str) {
        if let Some(h) = self.hidden_media.as_mut() {
            h.retain(|h| !folder_contains(h, path));
            if h.is_empty() {
                self.hidden_media = None;
            }
        }
    }

    /// Starts following a folder brought in whole (Swift `linkFolder`). Everything left out of it comes
    /// back, since it was brought in again on purpose. Returns the new linked folder, or None when the
    /// folder is already inside a linked one (`nested`: the panel opens it instead). Linked folders
    /// inside it become part of it.
    pub fn link_folder(&mut self, path: &str) -> (Option<MediaFolder>, bool) {
        if let Some(h) = self.hidden_media.as_mut() {
            h.retain(|h| !(folder_contains(path, h) || folder_contains(h, path)));
            if h.is_empty() {
                self.hidden_media = None;
            }
        }
        if self.linked_folder_holding(path).is_some() {
            return (None, true);
        }
        let folder = MediaFolder { id: Id::new(), path: path.to_string(), relative_path: None, bookmark: None };
        let mut list: Vec<MediaFolder> =
            self.folders.take().unwrap_or_default().into_iter().filter(|f| !folder_contains(path, &f.path)).collect();
        list.push(folder.clone());
        self.folders = Some(list);
        (Some(folder), false)
    }

    /// Takes items out of the project with the clips that use them (Swift `removeAssets(_:folders:)`).
    /// `folders` are Media panel folders going too, with everything in them: a linked folder is let go,
    /// a folder inside one is hidden. Items picked on their own that sit in a linked folder are hidden
    /// so the next look at the folder doesn't bring them back. Ends with `prune_folders`.
    pub fn remove_media(&mut self, picked: &HashSet<Id>, folders: &[String], importing: &HashSet<Id>) {
        let in_folders: HashSet<Id> = folders.iter().flat_map(|f| self.assets_under(f)).collect();
        let loose: HashSet<Id> = picked.difference(&in_folders).copied().collect();
        let ids: HashSet<Id> = loose.union(&in_folders).copied().collect();
        let mut hidden = self.hidden_media.take().unwrap_or_default();
        for folder in folders {
            let is_root = self.folders.iter().flatten().any(|f| &f.path == folder);
            if is_root {
                if let Some(f) = self.folders.as_mut() {
                    f.retain(|f| &f.path != folder);
                }
            } else if self.linked_folder_holding(folder).is_some() {
                hidden.push(folder.clone());
            }
        }
        for a in self.assets.iter().filter(|a| loose.contains(&a.id)) {
            if self.linked_folder_holding(&a.path).is_some() {
                hidden.push(a.path.clone());
            }
        }
        hidden.dedup();
        self.hidden_media = (!hidden.is_empty()).then_some(hidden);
        self.clips.retain(|c| c.asset_id.is_none_or(|a| !ids.contains(&a)));
        self.assets.retain(|a| !ids.contains(&a.id));
        self.prune_folders(importing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Clip, ClipKind, MediaAsset, MediaKind};

    fn asset(path: &str) -> MediaAsset {
        MediaAsset {
            id: Id::new(),
            path: path.into(),
            relative_path: None,
            playable_path: None,
            name: file_name(path).rsplit_once('.').map_or(path, |(s, _)| s).into(),
            kind: MediaKind::Video,
            duration: 5.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            bookmark: None,
        }
    }

    fn linked(paths: &[&str]) -> Project {
        let mut p = Project::default();
        p.link_folder("/m/Shoot");
        for path in paths {
            p.assets.push(asset(path));
        }
        p
    }

    #[test]
    fn names_and_media_types() {
        assert_eq!(parent_dir("/m/Shoot/a.mov"), "/m/Shoot");
        assert_eq!(parent_dir("C:\\m\\a.mov"), "C:\\m");
        assert_eq!(parent_dir("/a.mov"), "/");
        assert_eq!(file_name("C:\\m\\a.MOV"), "a.MOV");
        assert!(is_media_path("/x/A.MOV"));
        assert!(is_media_path("/x/song.flac"));
        assert!(!is_media_path("/x/notes.txt"));
        assert!(!is_media_path("/x/.mov"));
        assert!(!is_media_path("/x/README"));
    }

    #[test]
    fn natural_order_like_finder() {
        let mut v = vec!["clip 10.mov", "Clip 2.mov", "clip 1.mov", "b.mov", "A.mov"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["A.mov", "b.mov", "clip 1.mov", "Clip 2.mov", "clip 10.mov"]);
        assert_eq!(natural_cmp("x2", "x10"), Ordering::Less);
        assert_eq!(natural_cmp("B", "a"), Ordering::Greater);
    }

    #[test]
    fn link_folder_nests_and_unhides() {
        let mut p = Project::default();
        p.hidden_media = Some(vec!["/m/Shoot/Drone/a.mov".into(), "/other/b.mov".into()]);
        let (inner, nested) = p.link_folder("/m/Shoot/Drone");
        assert!(inner.is_some() && !nested);
        // Linking the parent takes the inner folder in, and brings back what was hidden in it.
        let (outer, nested) = p.link_folder("/m/Shoot");
        assert!(outer.is_some() && !nested);
        assert_eq!(p.folders.as_ref().unwrap().len(), 1);
        assert_eq!(p.folders.as_ref().unwrap()[0].path, "/m/Shoot");
        assert_eq!(p.hidden_media, Some(vec!["/other/b.mov".into()]));
        // A folder inside a linked one isn't linked again; the panel opens it.
        let (none, nested) = p.link_folder("/m/Shoot/Drone");
        assert!(none.is_none() && nested);
        assert_eq!(p.folders.as_ref().unwrap()[0].name(), "Shoot");
    }

    #[test]
    fn places_follow_the_disk() {
        let mut p = linked(&["/m/Shoot/a.mov", "/m/Shoot/Drone/b.mov", "/m/Shoot/Drone/Low/c.mov"]);
        p.assets.push(asset("/elsewhere/d.mov"));
        assert_eq!(p.media_place("/m/Shoot/Drone/b.mov"), Some("/m/Shoot/Drone"));
        assert_eq!(p.media_place("/elsewhere/d.mov"), None);
        assert_eq!(p.assets_under("/m/Shoot/Drone").len(), 2);
        assert_eq!(p.assets_under("/m/Shoot").len(), 3);
    }

    #[test]
    fn removing_hides_files_and_sub_folders() {
        let mut p = linked(&["/m/Shoot/a.mov", "/m/Shoot/Drone/b.mov", "/m/Shoot/Drone/c.mov", "/m/Shoot/d.mov"]);
        let a = p.assets[0].id;
        let track = p.video_tracks[0].id;
        p.clips.push(Clip { track_id: track, kind: ClipKind::Video, asset_id: Some(a), duration: 1.0, ..Clip::default() });
        p.remove_media(&HashSet::from([a]), &["/m/Shoot/Drone".into()], &HashSet::new());
        assert_eq!(p.assets.len(), 1, "a, b and c went");
        assert!(p.clips.is_empty(), "the clip using a went too");
        let hidden = p.hidden_media.clone().unwrap();
        assert!(hidden.contains(&"/m/Shoot/a.mov".to_string()));
        assert!(hidden.contains(&"/m/Shoot/Drone".to_string()));
        assert!(p.is_hidden("/m/Shoot/Drone/b.mov"));
        assert!(!p.is_hidden("/m/Shoot/d.mov"));
        // Brought in by hand again: no longer hidden.
        p.unhide("/m/Shoot/a.mov");
        assert!(!p.is_hidden("/m/Shoot/a.mov"));
    }

    #[test]
    fn removing_a_linked_folder_lets_it_go() {
        let mut p = linked(&["/m/Shoot/a.mov", "/m/Shoot/Drone/b.mov"]);
        p.assets.push(asset("/elsewhere/d.mov"));
        p.hidden_media = Some(vec!["/m/Shoot/x.mov".into()]);
        p.remove_media(&HashSet::new(), &["/m/Shoot".into()], &HashSet::new());
        assert_eq!(p.assets.len(), 1);
        assert!(p.folders.is_none());
        assert!(p.hidden_media.is_none(), "hidden entries outside every folder are dropped");
    }

    #[test]
    fn removing_the_last_item_lets_the_folder_go_unless_importing() {
        let mut p = linked(&["/m/Shoot/a.mov"]);
        let a = p.assets[0].id;
        let fid = p.folders.as_ref().unwrap()[0].id;
        let mut q = p.clone();
        q.remove_media(&HashSet::from([a]), &[], &HashSet::from([fid]));
        assert!(q.folders.is_some(), "kept while still importing");
        p.remove_media(&HashSet::from([a]), &[], &HashSet::new());
        assert!(p.folders.is_none());
    }

    #[test]
    fn undo_brings_removed_items_and_folders_back() {
        use crate::edit::Edit;
        use crate::history::Document;
        let mut d = Document::new(linked(&["/m/Shoot/a.mov", "/m/Shoot/Drone/b.mov"]));
        let a = d.project.assets[0].id;
        Edit::RemoveAssets { ids: vec![a], folders: vec!["/m/Shoot/Drone".into()] }.apply(&mut d);
        assert!(d.project.assets.is_empty());
        assert!(d.project.folders.is_none(), "nothing left in it: let go");
        assert!(d.undo());
        assert_eq!(d.project.assets.len(), 2, "one undo step brings both back");
        assert_eq!(d.project.folders.as_ref().map(Vec::len), Some(1), "and the linked folder with them");
        assert!(d.redo());
        assert!(d.project.assets.is_empty());
        // Older edits from the UI and MCP have no `folders`.
        let e: Edit = serde_json::from_str(r#"{"op":"removeAssets","ids":[]}"#).unwrap();
        assert_eq!(e, Edit::RemoveAssets { ids: vec![], folders: vec![] });
    }
}
