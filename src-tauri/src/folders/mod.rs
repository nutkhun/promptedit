//! Linked folders on disk (Editroom/Model/MediaFolders.swift and EditorModel's "Folders on disk";
//! docs/spec/01-model.md §2.17, §3.19; 04-ui.md §1.3, §6.3).
//!
//! Importing a folder links it: everything in it (and in the folders inside it) comes in, and the
//! Media panel mirrors it from then on. This module
//! - scans a folder for media files (hidden files and packages skipped, Finder-like name order),
//! - plans and finishes an import that contains folders (`plan_import` / `finish_import`, called from
//!   `import_paths`),
//! - brings the library up to date with the disk (`sync`): files added to a linked folder come in,
//!   files deleted from it go from Media when no clip uses them (used ones stay and show as missing,
//!   so an edit never loses a clip without a word), and files or linked folders renamed while the app
//!   runs are followed,
//! - watches the linked folders with `notify`, so the UI knows when to sync (an event in the app, and
//!   a change counter the UI polls, which also works behind the browser dev server),
//! - and points a missing linked folder at where it is now (Locate…).
//!
//! What's stored is the model's (`crates/core/src/folders.rs`): linked folders, and `hiddenMedia` for
//! things taken out by hand. None of this is undoable, as in Editroom: imports and syncing change the
//! library directly.
//!
//! Editroom follows renamed and moved files with macOS bookmarks, even across launches. PromptEdit has
//! no portable equivalent, so it follows a file by its identity on disk (inode, or size and times on
//! Windows) as last seen while the app runs: renames and moves inside a linked folder, and a linked
//! folder renamed where it is, are followed; changes made while the app was closed are found by
//! relative path (a moved project folder) or with Locate….

use crate::{media, snapshot, AppState, ImportResult, Snapshot};
use promptedit_core::folders::{file_name, is_media_path, natural_cmp};
use promptedit_core::paths::folder_contains;
use promptedit_core::{Id, MediaFolder, Project};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::Metadata;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

// ---- Scanning ----

/// Folders that are really documents (macOS packages): their insides aren't media to import.
const PACKAGE_EXTENSIONS: &[&str] = &[
    "app", "bundle", "framework", "plugin", "kext", "photoslibrary", "fcpbundle", "fcpxbundle", "imovielibrary",
    "tvlibrary", "musiclibrary", "aplibrary", "migratedphotolibrary", "photolibrary", "lrlibrary", "logicx", "band",
    "rtfd", "pages", "numbers", "key", "xcodeproj", "xcworkspace", "dvdmedia", "prproj",
];

fn is_package(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && PACKAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Hidden files and folders: a leading dot everywhere, and the hidden or system attribute on Windows
/// (`$RECYCLE.BIN`, `System Volume Information`).
fn is_hidden(name: &str, _meta: &Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if _meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    false
}

/// `dir` and `name` joined in `dir`'s own spelling, so files and their folder always line up
/// (Swift keeps the folder's spelling for the same reason).
fn join(dir: &str, name: &str) -> String {
    let sep = if dir.contains('\\') && !dir.contains('/') { '\\' } else if dir.contains('/') { '/' } else { std::path::MAIN_SEPARATOR };
    format!("{}{sep}{name}", dir.trim_end_matches(['/', '\\']))
}

/// A path without a trailing separator (except a root such as `/` or `C:\`).
pub fn normalized(path: &str) -> String {
    let t = path.trim_end_matches(['/', '\\']);
    if t.is_empty() || t.ends_with(':') { path.to_string() } else { t.to_string() }
}

pub fn is_folder(path: &str) -> bool {
    Path::new(path).is_dir()
}

/// The media files in a folder and every folder inside it, not hidden and not inside packages, in
/// Finder-like name order (Swift `MediaFolder.mediaFiles(in:)`). Symbolic links aren't followed, so a
/// link can't make a scan go round in circles.
pub fn media_files(root: &str) -> Vec<String> {
    fn walk(dir: &str, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(meta) = e.metadata() else { continue };
            if is_hidden(&name, &meta) {
                continue;
            }
            let path = join(dir, &name);
            let kind = meta.file_type();
            if kind.is_dir() {
                if !is_package(&name) {
                    walk(&path, out);
                }
            } else if kind.is_file() && is_media_path(&name) {
                out.push(path);
            }
        }
    }
    let mut out = vec![];
    walk(root, &mut out);
    out.sort_by(|a, b| natural_cmp(a, b));
    out
}

// ---- Following files by identity while the app runs ----

/// Who a file or folder is on disk, whatever it's called: device and inode on macOS and Linux; size and
/// times on Windows, which a rename or move on the same drive keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct FileId(u64, u64, u64);

fn file_id(meta: &Metadata) -> FileId {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileId(meta.dev(), meta.ino(), 0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // A folder's write time changes with what's in it; its creation time doesn't.
        if meta.is_dir() { FileId(1, 0, meta.creation_time()) } else { FileId(meta.file_size(), meta.last_write_time(), meta.creation_time()) }
    }
    #[cfg(not(any(unix, windows)))]
    {
        FileId(meta.len(), 0, 0)
    }
}

fn id_of(path: &str) -> Option<FileId> {
    std::fs::symlink_metadata(path).ok().map(|m| file_id(&m))
}

/// What each library file and linked folder was, by path, the last time it was looked at.
static KNOWN: Mutex<Option<HashMap<String, FileId>>> = Mutex::new(None);

fn remember(paths: impl IntoIterator<Item = String>) {
    let mut known = KNOWN.lock().unwrap();
    let map = known.get_or_insert_with(HashMap::new);
    for p in paths {
        if let Some(id) = id_of(&p) {
            map.insert(p, id);
        }
    }
}

fn known(path: &str) -> Option<FileId> {
    KNOWN.lock().unwrap().as_ref().and_then(|m| m.get(path).copied())
}

/// Files that couldn't be imported, with their size and write time then: not tried again on every
/// look at their folder, unless they've changed since (Swift `unreadable`).
static UNREADABLE: Mutex<Option<HashMap<String, (u64, Option<SystemTime>)>>> = Mutex::new(None);

fn stamp(path: &str) -> Option<(u64, Option<SystemTime>)> {
    std::fs::metadata(path).ok().map(|m| (m.len(), m.modified().ok()))
}

fn mark_unreadable(paths: &[String]) {
    let mut u = UNREADABLE.lock().unwrap();
    let map = u.get_or_insert_with(HashMap::new);
    for p in paths {
        if let Some(s) = stamp(p) {
            map.insert(p.clone(), s);
        }
    }
}

fn still_unreadable(path: &str) -> bool {
    let u = UNREADABLE.lock().unwrap();
    u.as_ref().and_then(|m| m.get(path)).is_some_and(|s| stamp(path).as_ref() == Some(s))
}

/// Files being imported right now: a sync doesn't start them again (Swift `pendingImports`).
static PENDING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn pending(path: &str) -> bool {
    PENDING.lock().unwrap().as_ref().is_some_and(|s| s.contains(path))
}

fn set_pending(paths: &[String], on: bool) {
    let mut p = PENDING.lock().unwrap();
    let set = p.get_or_insert_with(HashSet::new);
    for path in paths {
        if on { set.insert(path.clone()); } else { set.remove(path); }
    }
}

/// A file written in the last moment may still be being copied or recorded: it waits for the next look.
const SETTLE: Duration = Duration::from_millis(1500);

fn settling(path: &str) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < SETTLE)
}

// ---- Importing folders ----

/// An import with its folders worked out: the files to bring in, and the folders it links.
pub struct ImportPlan {
    pub files: Vec<String>,
    pub linked: Vec<MediaFolder>,
    /// A folder brought in that's already inside a linked one: the panel opens it.
    pub opened: Option<String>,
}

/// Before an import: a folder is linked and brings in everything in it that isn't hidden; a file
/// brought in by hand is no longer hidden from its folder (Swift `importFiles`).
pub fn plan_import(state: &AppState, paths: Vec<String>) -> ImportPlan {
    let mut plan = ImportPlan { files: vec![], linked: vec![], opened: None };
    for raw in paths {
        let path = normalized(&raw);
        if is_folder(&path) && !is_package(file_name(&path)) {
            {
                let mut doc = state.doc.lock().unwrap();
                let (folder, nested) = doc.project.link_folder(&path);
                if let Some(f) = folder {
                    doc.importing_folders.insert(f.id);
                    plan.linked.push(f);
                }
                if nested {
                    plan.opened = Some(path.clone());
                }
                doc.dirty = true;
            }
            let found = media_files(&path);
            let doc = state.doc.lock().unwrap();
            plan.files.extend(found.into_iter().filter(|f| !doc.project.is_hidden(f)));
        } else {
            state.doc.lock().unwrap().project.unhide(&path);
            plan.files.push(path);
        }
    }
    plan.files.retain(|f| !pending(f));
    let mut seen = HashSet::new();
    plan.files.retain(|f| seen.insert(f.clone()));
    set_pending(&plan.files, true);
    remember(plan.linked.iter().map(|f| f.path.clone()));
    plan
}

/// After an import: the linked folders stop counting as importing, any left with nothing in them are
/// let go ("There's no media in …"), and what came in is remembered for following renames.
pub fn finish_import(state: &AppState, plan: &ImportPlan, r: &mut ImportResult) {
    set_pending(&plan.files, false);
    mark_unreadable(&r.failed);
    let roots = {
        let mut doc = state.doc.lock().unwrap();
        for f in &plan.linked {
            doc.importing_folders.remove(&f.id);
        }
        let importing = doc.importing_folders.clone();
        let before = doc.project.folders.clone();
        doc.project.prune_folders(&importing);
        if doc.project.folders != before {
            doc.dirty = true;
        }
        let kept: HashSet<Id> = doc.project.folders.iter().flatten().map(|f| f.id).collect();
        r.linked = plan.linked.iter().filter(|f| kept.contains(&f.id)).map(|f| f.path.clone()).collect();
        r.empty = plan.linked.iter().filter(|f| !kept.contains(&f.id)).map(MediaFolder::name).collect();
        r.opened = plan.opened.clone();
        roots(&doc.project)
    };
    remember(plan.files.iter().cloned());
    rewatch(&roots);
    r.snapshot = snapshot(state, None);
}

// ---- Syncing with the disk ----

/// What a sync did, for the UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub snapshot: Snapshot,
    /// New items from files added to linked folders.
    pub added: Vec<Id>,
    /// Items gone because their file was deleted from a linked folder (and no clip used them).
    pub removed: Vec<Id>,
    /// Items whose file was renamed or moved (followed): opened again at the new place.
    pub moved: Vec<Id>,
    pub probes: Vec<(Id, media::Probe)>,
    /// Files that couldn't be imported.
    pub failed: Vec<String>,
    /// Something is still settling (a file being written, an edit being dragged): sync again shortly.
    pub retry: bool,
}

fn roots(p: &Project) -> Vec<String> {
    p.folders.iter().flatten().map(|f| f.path.clone()).collect()
}

/// A linked folder that's gone from where it was: renamed in place, it's found beside where it was by
/// its identity (not in the Trash, which isn't followed).
fn find_renamed_folder(old: &str) -> Option<String> {
    let id = known(old)?;
    let parent = promptedit_core::folders::parent_dir(old);
    let entries = std::fs::read_dir(if parent.is_empty() { "." } else { parent }).ok()?;
    entries.flatten().find_map(|e| {
        let meta = e.metadata().ok()?;
        (meta.is_dir() && file_id(&meta) == id).then(|| join(parent, &e.file_name().to_string_lossy()))
    })
}

static SYNCING: AtomicBool = AtomicBool::new(false);

/// Brings Media up to date with the disk (Swift `syncFolders`). Run when the window comes back to the
/// front, when a project opens, when a watched folder changes, and from Reload Folder from Disk.
pub fn sync(state: &AppState, cache_dir: &Path) -> SyncResult {
    let mut result = SyncResult {
        snapshot: snapshot(state, None),
        added: vec![],
        removed: vec![],
        moved: vec![],
        probes: vec![],
        failed: vec![],
        retry: false,
    };
    if SYNCING.swap(true, Ordering::SeqCst) {
        result.retry = true;
        return result;
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            SYNCING.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done;

    let p = {
        let doc = state.doc.lock().unwrap();
        // Never under a drag: its pre-drag snapshot would be committed under the person's hand.
        if doc.is_live() {
            result.retry = true;
            return result;
        }
        doc.project.clone()
    };
    if p.folders.as_ref().is_none_or(Vec::is_empty) {
        return result;
    }

    // 1. Linked folders renamed in place.
    let mut folder_moves = vec![];
    for f in p.folders.iter().flatten().filter(|f| !is_folder(&f.path)) {
        if let Some(now) = find_renamed_folder(&f.path) {
            folder_moves.push((f.path.clone(), now));
        }
    }
    let mut q = p.clone();
    for (old, new) in &folder_moves {
        q.move_paths(old, new);
    }

    // 2. What's in each linked folder now.
    let mut on_disk: Vec<String> = vec![];
    for f in q.folders.iter().flatten().filter(|f| is_folder(&f.path)) {
        on_disk.extend(media_files(&f.path));
    }
    let have: HashSet<&str> = q.assets.iter().map(|a| a.path.as_str()).collect();
    let fresh: Vec<&String> = on_disk.iter().filter(|f| !have.contains(f.as_str())).collect();

    // 3. Files renamed or moved inside a linked folder: the item follows its file, keeping its clips.
    let mut by_id: HashMap<FileId, &String> = HashMap::new();
    for f in &fresh {
        if let Some(id) = id_of(f) {
            by_id.insert(id, f);
        }
    }
    let mut file_moves: Vec<(Id, String, String)> = vec![];
    let mut taken: HashSet<String> = HashSet::new();
    for a in q.assets.iter().filter(|a| !Path::new(&a.path).exists()) {
        let Some(id) = known(&a.path) else { continue };
        if let Some(now) = by_id.get(&id).filter(|n| !taken.contains(n.as_str())) {
            taken.insert((*now).clone());
            file_moves.push((a.id, a.path.clone(), (*now).clone()));
        }
    }

    // 4. Deleted from a linked folder (or put in the Trash) and used by no clip: gone from Media too, as
    //    from the folder. The folder itself has to be there: a whole folder gone is found with Locate.
    let used: HashSet<Id> = q.clips.iter().filter_map(|c| c.asset_id).collect();
    let moved_ids: HashSet<Id> = file_moves.iter().map(|m| m.0).collect();
    let gone: HashSet<Id> = q
        .assets
        .iter()
        .filter(|a| {
            !used.contains(&a.id)
                && !moved_ids.contains(&a.id)
                && !Path::new(&a.path).exists()
                && q.linked_folder_holding(&a.path).is_some_and(|f| is_folder(&f.path))
        })
        .map(|a| a.id)
        .collect();

    // 5. New files, unless hidden, being imported, known to fail, or still being written.
    let mut added: Vec<String> = vec![];
    for f in fresh.iter().filter(|f| !taken.contains(f.as_str())) {
        if q.is_hidden(f) || pending(f) || still_unreadable(f) {
            continue;
        }
        if settling(f) {
            result.retry = true;
            continue;
        }
        added.push((*f).clone());
    }

    // Applied to the project as it is now (an edit may have landed meanwhile). Not undoable.
    {
        let mut doc = state.doc.lock().unwrap();
        let mut changed = false;
        for (old, new) in &folder_moves {
            if doc.project.folders.iter().flatten().any(|f| &f.path == old) {
                doc.project.move_paths(old, new);
                changed = true;
            }
        }
        for (id, old, new) in &file_moves {
            // `old` is already where any renamed linked folder put it (as just applied above).
            if let Some(a) = doc.project.assets.iter_mut().find(|a| a.id == *id && &a.path == old) {
                // Renamed: the new name shows, unless it was given a name of its own.
                let stem = |p: &str| file_name(p).rsplit_once('.').map_or(file_name(p), |(s, _)| s).to_string();
                if a.name == stem(old) {
                    a.name = stem(new);
                }
                a.path = new.clone();
                result.moved.push(*id);
                changed = true;
            }
        }
        let still_used: HashSet<Id> = doc.project.clips.iter().filter_map(|c| c.asset_id).collect();
        let gone: HashSet<Id> = gone.into_iter().filter(|id| !still_used.contains(id)).collect();
        if !gone.is_empty() {
            let before = doc.project.assets.len();
            doc.project.assets.retain(|a| !gone.contains(&a.id));
            if doc.project.assets.len() != before {
                doc.dropped_from_disk.extend(gone.iter().copied());
                result.removed.extend(gone.iter().copied());
                changed = true;
            }
        }
        if changed {
            doc.commit_live();
            doc.dirty = true;
        }
    }

    // Items that followed their file are read again where they are now.
    for id in &result.moved {
        let path = state.doc.lock().unwrap().project.asset(Some(*id)).map(|a| a.path.clone());
        if let Some(Ok(probe)) = path.map(|p| media::probe(Path::new(&p))) {
            result.probes.push((*id, probe));
        }
    }

    if !added.is_empty() {
        set_pending(&added, true);
        let r = crate::import_files(state, cache_dir, added.clone());
        set_pending(&added, false);
        mark_unreadable(&r.failed);
        result.added = r.added;
        result.probes.extend(r.probes);
        result.failed = r.failed;
    }

    let (paths, roots) = {
        let doc = state.doc.lock().unwrap();
        let p = &doc.project;
        let paths: Vec<String> =
            p.assets.iter().filter(|a| p.linked_folder_holding(&a.path).is_some()).map(|a| a.path.clone()).chain(roots(p)).collect();
        (paths, roots(p))
    };
    remember(paths);
    rewatch(&roots);
    result.snapshot = snapshot(state, None);
    result
}

/// Locate… for a linked folder that's gone missing: it, and everything in it, is pointed at where it
/// is now, then the folder is looked at again (Swift `relinkFolder`).
pub fn locate_folder(state: &AppState, cache_dir: &Path, id: Id, path: &str) -> Result<SyncResult, String> {
    let new = normalized(path);
    if !is_folder(&new) {
        return Err(format!("“{}” isn't a folder.", file_name(&new)));
    }
    let moved: Vec<Id> = {
        let mut doc = state.doc.lock().unwrap();
        let old = doc.project.folders.iter().flatten().find(|f| f.id == id).map(|f| f.path.clone()).ok_or("No such folder.")?;
        doc.commit_live();
        let ids = doc.project.assets.iter().filter(|a| folder_contains(&old, &a.path)).map(|a| a.id).collect();
        doc.project.move_paths(&old, &new);
        doc.dirty = true;
        ids
    };
    let mut r = sync(state, cache_dir);
    for id in moved {
        let path = state.doc.lock().unwrap().project.asset(Some(id)).map(|a| a.path.clone());
        if let Some(Ok(probe)) = path.map(|p| media::probe(Path::new(&p))) {
            r.probes.push((id, probe));
            r.moved.push(id);
        }
    }
    Ok(r)
}

/// Reload Folder from Disk: a sync, then every file in the folder read again as it is on disk now.
pub fn reload_folder(state: &AppState, cache_dir: &Path, folder: &str) -> SyncResult {
    let mut r = sync(state, cache_dir);
    let items: Vec<(Id, String)> = {
        let doc = state.doc.lock().unwrap();
        let under: HashSet<Id> = doc.project.assets_under(folder).into_iter().collect();
        doc.project.assets.iter().filter(|a| under.contains(&a.id)).map(|a| (a.id, a.path.clone())).collect()
    };
    for (id, path) in items {
        if Path::new(&path).exists() && crate::shell::relink(state, cache_dir, id, &path).is_ok() {
            if let Ok(probe) = media::probe(Path::new(&path)) {
                r.probes.push((id, probe));
            }
        }
    }
    r.snapshot = snapshot(state, None);
    r
}

// ---- Watching ----

struct Watch {
    watcher: Option<notify::RecommendedWatcher>,
    /// Linked folders being watched.
    watched: HashSet<String>,
    /// Linked folders that weren't there to watch: when one appears, it's a change.
    missing: HashSet<String>,
}

static WATCH: Mutex<Option<Watch>> = Mutex::new(None);
/// Bumped whenever something changed in a linked folder; the UI syncs when it moves.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The app's way of telling the window right away (an event); the dev server has none.
static EMIT: OnceLock<Box<dyn Fn(u64) + Send + Sync>> = OnceLock::new();

fn bump() {
    let g = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(emit) = EMIT.get() {
        emit(g);
    }
}

/// Whether a file-system event could change what Media shows. Reads (ffprobe opening a file, a
/// poster being made) and attribute changes don't, which also keeps the app's own reads from
/// setting off syncs.
fn matters(e: &notify::Event) -> bool {
    use notify::event::{EventKind, ModifyKind};
    let kind = matches!(
        e.kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(_) | ModifyKind::Data(_) | ModifyKind::Any)
            | EventKind::Any
    );
    kind && (e.paths.is_empty()
        || e.paths.iter().any(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // A media file, or something without an extension (a folder, likely), not hidden.
            !name.starts_with('.') && (is_media_path(&name) || !name.contains('.') || p.is_dir())
        }))
}

/// Watches exactly these linked folders (and the folders inside them).
pub fn rewatch(roots: &[String]) {
    use notify::Watcher;
    let mut guard = WATCH.lock().unwrap();
    let w = guard.get_or_insert_with(|| Watch {
        watcher: notify::recommended_watcher(|res: notify::Result<notify::Event>| {
            if res.as_ref().is_ok_and(matters) || res.is_err() {
                bump();
            }
        })
        .map_err(|e| eprintln!("Linked folders won't be watched: {e}"))
        .ok(),
        watched: HashSet::new(),
        missing: HashSet::new(),
    });
    let wanted: HashSet<String> = roots.iter().cloned().collect();
    let mut appeared = false;
    for gone in w.watched.clone().difference(&wanted) {
        if let Some(watcher) = w.watcher.as_mut() {
            let _ = watcher.unwatch(Path::new(gone));
        }
        w.watched.remove(gone);
    }
    w.missing.retain(|m| wanted.contains(m));
    for root in &wanted {
        let there = is_folder(root);
        if w.watched.contains(root) {
            if !there {
                // Deleted or renamed: watched again if it comes back.
                if let Some(watcher) = w.watcher.as_mut() {
                    let _ = watcher.unwatch(Path::new(root));
                }
                w.watched.remove(root);
                w.missing.insert(root.clone());
                appeared = true;
            }
            continue;
        }
        if !there {
            w.missing.insert(root.clone());
            continue;
        }
        if w.missing.remove(root) {
            appeared = true;
        }
        let ok = w.watcher.as_mut().is_some_and(|watcher| watcher.watch(Path::new(root), notify::RecursiveMode::Recursive).is_ok());
        if ok {
            w.watched.insert(root.clone());
        }
    }
    drop(guard);
    if appeared {
        bump();
    }
}

/// The change counter, after making sure the project's linked folders are the ones watched (a project
/// opened, a folder let go, Undo bringing one back). Cheap enough to poll every second.
pub fn changes(state: &AppState) -> u64 {
    let roots = roots(&state.doc.lock().unwrap().project);
    rewatch(&roots);
    GENERATION.load(Ordering::SeqCst)
}

/// Called from `run()`'s setup: changes reach the window as `media-folders-changed` right away.
pub fn start_app(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let h = app.clone();
    let _ = EMIT.set(Box::new(move |g| {
        let _ = h.emit("media-folders-changed", g);
    }));
}

// ---- Commands ----

#[tauri::command]
pub async fn sync_folders(app: tauri::AppHandle) -> Result<SyncResult, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || sync(&app2.state::<AppState>(), &cache)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn locate_media_folder(app: tauri::AppHandle, id: Id, path: String) -> Result<SyncResult, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || locate_folder(&app2.state::<AppState>(), &cache, id, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reload_media_folder(app: tauri::AppHandle, path: String) -> Result<SyncResult, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || reload_folder(&app2.state::<AppState>(), &cache, &path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn folder_changes(state: tauri::State<AppState>) -> u64 {
    changes(&state)
}

/// The same commands for the browser dev server (`dispatch`). None when the command isn't one of these.
pub fn dispatch(state: &AppState, cache_dir: &Path, cmd: &str, args: &serde_json::Value) -> Option<Result<serde_json::Value, String>> {
    use serde_json::to_value;
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let json = |v: Result<serde_json::Value, serde_json::Error>| v.map_err(|e| e.to_string());
    Some(match cmd {
        "sync_folders" => json(to_value(sync(state, cache_dir))),
        "folder_changes" => json(to_value(changes(state))),
        "locate_media_folder" => match (args.get("id").cloned().map(serde_json::from_value::<Id>), s("path")) {
            (Some(Ok(id)), Some(p)) => locate_folder(state, cache_dir, id, &p).and_then(|r| to_value(r).map_err(|e| e.to_string())),
            _ => Err("id and path are needed".into()),
        },
        "reload_media_folder" => match s("path") {
            Some(p) => json(to_value(reload_folder(state, cache_dir, &p))),
            None => Err("path is needed".into()),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests;
