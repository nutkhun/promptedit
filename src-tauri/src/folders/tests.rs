//! Linked folders against a real folder on disk: scanning, importing, syncing after files are added,
//! deleted and renamed, hidden items, a project folder moved whole, watching, and the recovery copy.
//! Media is made with the system `ffmpeg` (tiny PNGs); tests that need it are skipped without it.

use super::*;
use crate::{import_paths, open_project_at, recovery, save_project_to};
use promptedit_core::edit::Edit;
use promptedit_core::{Clip, ClipKind};
use std::path::PathBuf;
use std::process::Command;

/// The watcher, the change counter and the identity map are process-wide: one test at a time.
static SERIAL: Mutex<()> = Mutex::new(());

struct Tmp(PathBuf);
impl Tmp {
    fn new(name: &str) -> Tmp {
        let d = std::env::temp_dir().join(format!("promptedit-folders-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Tmp(d)
    }
    fn path(&self, rel: &str) -> String {
        join(&self.0.to_string_lossy(), rel)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn have_ffmpeg() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
}

/// A small PNG, dated a minute ago so it doesn't count as still being written.
fn png(path: &str) {
    if let Some(dir) = Path::new(path).parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    let ok = Command::new("ffmpeg")
        .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x36", "-frames:v", "1", path])
        .status()
        .is_ok_and(|s| s.success());
    assert!(ok, "ffmpeg made {path}");
    age(path);
}

fn age(path: &str) {
    let f = std::fs::File::options().write(true).open(path).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(60)).unwrap();
}

fn touch(path: &str) {
    if let Some(dir) = Path::new(path).parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(path, b"x").unwrap();
}

fn names(state: &AppState) -> Vec<String> {
    state.doc.lock().unwrap().project.assets.iter().map(|a| file_name(&a.path).to_string()).collect()
}

fn cache(t: &Tmp) -> PathBuf {
    t.0.join(".cache")
}

#[test]
fn scan_skips_hidden_files_packages_and_other_files() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = Tmp::new("scan");
    for f in ["Clip 10.mov", "Clip 2.mov", "a.MP4", ".hidden.mov", "notes.txt", "Sub/b.mp3", ".git/x.mov", "Lib.photoslibrary/y.jpg", "Sub/Deeper/c.png"] {
        touch(&t.path(f));
    }
    let root = t.0.to_string_lossy().into_owned();
    let found: Vec<String> = media_files(&root).iter().map(|p| p[root.len() + 1..].replace('\\', "/")).collect();
    assert_eq!(found, ["a.MP4", "Clip 2.mov", "Clip 10.mov", "Sub/b.mp3", "Sub/Deeper/c.png"]);
    assert!(media_files(&t.path("nope")).is_empty());
}

#[test]
fn importing_a_folder_links_it_and_brings_everything_in() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !have_ffmpeg() {
        return eprintln!("skipped: no ffmpeg");
    }
    let t = Tmp::new("import");
    png(&t.path("Shoot/one.png"));
    png(&t.path("Shoot/Drone/two.png"));
    touch(&t.path("Shoot/readme.txt"));
    std::fs::create_dir_all(t.path("Empty")).unwrap();
    let state = AppState::default();
    // A trailing separator is the same folder.
    let r = import_paths(&state, &cache(&t), vec![format!("{}/", t.path("Shoot")), t.path("Empty")]);
    assert_eq!(r.added.len(), 2);
    assert_eq!(r.linked, [t.path("Shoot")]);
    assert_eq!(r.empty, ["Empty"], "a folder with no media is let go");
    let doc = state.doc.lock().unwrap();
    assert_eq!(doc.project.folders.as_ref().unwrap().len(), 1);
    assert!(doc.importing_folders.is_empty());
    assert!(!doc.can_undo(), "importing isn't undoable");
    assert_eq!(doc.project.media_place(&t.path("Shoot/Drone/two.png")), Some(t.path("Shoot/Drone").as_str()));
    drop(doc);
    // A folder inside a linked one isn't linked again: the panel opens it.
    let r = import_paths(&state, &cache(&t), vec![t.path("Shoot/Drone")]);
    assert_eq!(r.opened.as_deref(), Some(t.path("Shoot/Drone").as_str()));
    assert!(r.added.is_empty() && r.linked.is_empty());
    assert_eq!(names(&state).len(), 2);
}

#[test]
fn sync_follows_adds_and_deletes_and_keeps_used_files() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !have_ffmpeg() {
        return eprintln!("skipped: no ffmpeg");
    }
    let t = Tmp::new("sync");
    png(&t.path("Shoot/a.png"));
    png(&t.path("Shoot/b.png"));
    png(&t.path("Shoot/used.png"));
    let state = AppState::default();
    import_paths(&state, &cache(&t), vec![t.path("Shoot")]);
    {
        let mut doc = state.doc.lock().unwrap();
        let used = doc.project.assets.iter().find(|a| a.path.ends_with("used.png")).unwrap().id;
        let track = doc.project.video_tracks[0].id;
        doc.mutate(|p| p.clips.push(Clip { track_id: track, kind: ClipKind::Image, asset_id: Some(used), duration: 2.0, ..Clip::default() }));
    }
    assert!(sync(&state, &cache(&t)).added.is_empty(), "nothing new");

    // Added on disk: comes in (not while it's still being written).
    png(&t.path("Shoot/New/c.png"));
    touch(&t.path("Shoot/fresh.png"));
    let r = sync(&state, &cache(&t));
    assert_eq!(r.added.len(), 1);
    assert!(r.retry, "a file written just now waits for the next look");
    assert!(names(&state).contains(&"c.png".to_string()));
    assert!(!names(&state).contains(&"fresh.png".to_string()));

    // Deleted on disk: the unused item goes; the one a clip uses stays (shown missing).
    std::fs::remove_file(t.path("Shoot/a.png")).unwrap();
    std::fs::remove_file(t.path("Shoot/used.png")).unwrap();
    std::fs::remove_file(t.path("Shoot/fresh.png")).unwrap();
    let r = sync(&state, &cache(&t));
    assert_eq!(r.removed.len(), 1);
    let left = names(&state);
    assert!(!left.contains(&"a.png".to_string()));
    assert!(left.contains(&"used.png".to_string()));
    let mut doc = state.doc.lock().unwrap();
    // Gone from disk: Undo doesn't bring it back.
    assert!(doc.undo());
    assert!(!doc.project.assets.iter().any(|a| a.path.ends_with("a.png")));
}

#[test]
fn removed_items_stay_out_until_undone() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !have_ffmpeg() {
        return eprintln!("skipped: no ffmpeg");
    }
    let t = Tmp::new("hidden");
    png(&t.path("Shoot/a.png"));
    png(&t.path("Shoot/Drone/b.png"));
    png(&t.path("Shoot/Drone/c.png"));
    let state = AppState::default();
    import_paths(&state, &cache(&t), vec![t.path("Shoot")]);
    let a = state.doc.lock().unwrap().project.assets.iter().find(|x| x.path.ends_with("a.png")).unwrap().id;
    Edit::RemoveAssets { ids: vec![a], folders: vec![t.path("Shoot/Drone")] }.apply(&mut state.doc.lock().unwrap());
    // `a` was the last thing left once Drone went: the linked folder is let go with it.
    assert!(state.doc.lock().unwrap().project.folders.is_none());
    assert!(state.doc.lock().unwrap().project.assets.is_empty());

    // Same again with something left in the folder: the removed things stay out on the next sync.
    png(&t.path("Shoot/d.png"));
    import_paths(&state, &cache(&t), vec![t.path("Shoot")]);
    assert_eq!(names(&state).len(), 4, "linking the folder again brings everything back");
    let a = state.doc.lock().unwrap().project.assets.iter().find(|x| x.path.ends_with("a.png")).unwrap().id;
    Edit::RemoveAssets { ids: vec![a], folders: vec![t.path("Shoot/Drone")] }.apply(&mut state.doc.lock().unwrap());
    assert_eq!(names(&state), ["d.png"]);
    png(&t.path("Shoot/Drone/e.png"));
    sync(&state, &cache(&t));
    assert_eq!(names(&state), ["d.png"], "hidden files and folders don't come back");
    let hidden = state.doc.lock().unwrap().project.hidden_media.clone().unwrap();
    assert!(hidden.contains(&t.path("Shoot/a.png")) && hidden.contains(&t.path("Shoot/Drone")));
    assert!(state.doc.lock().unwrap().undo());
    assert_eq!(names(&state).len(), 4, "one undo brings them back");
}

#[cfg(unix)]
#[test]
fn renames_while_running_are_followed() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !have_ffmpeg() {
        return eprintln!("skipped: no ffmpeg");
    }
    let t = Tmp::new("rename");
    png(&t.path("Shoot/take.png"));
    let state = AppState::default();
    import_paths(&state, &cache(&t), vec![t.path("Shoot")]);
    let id = state.doc.lock().unwrap().project.assets[0].id;
    {
        let mut doc = state.doc.lock().unwrap();
        let track = doc.project.video_tracks[0].id;
        doc.mutate(|p| p.clips.push(Clip { track_id: track, kind: ClipKind::Image, asset_id: Some(id), duration: 2.0, ..Clip::default() }));
    }
    std::fs::create_dir_all(t.path("Shoot/Selects")).unwrap();
    std::fs::rename(t.path("Shoot/take.png"), t.path("Shoot/Selects/best.png")).unwrap();
    let r = sync(&state, &cache(&t));
    assert_eq!(r.moved, [id]);
    assert!(r.added.is_empty(), "the same item, not a new one");
    let p = state.doc.lock().unwrap().project.clone();
    assert_eq!(p.assets.len(), 1);
    assert_eq!(p.assets[0].path, t.path("Shoot/Selects/best.png"));
    assert_eq!(p.assets[0].name, "best");

    // The linked folder itself renamed where it is.
    std::fs::rename(t.path("Shoot"), t.path("Shoot 2")).unwrap();
    sync(&state, &cache(&t));
    let p = state.doc.lock().unwrap().project.clone();
    assert_eq!(p.folders.unwrap()[0].path, t.path("Shoot 2"));
    assert_eq!(p.assets[0].path, t.path("Shoot 2/Selects/best.png"));
    assert_eq!(p.assets[0].id, id);
}

#[test]
fn a_missing_folder_is_located_and_a_moved_project_finds_its_folders() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if !have_ffmpeg() {
        return eprintln!("skipped: no ffmpeg");
    }
    let t = Tmp::new("relocate");
    png(&t.path("Job/Media/a.png"));
    png(&t.path("Job/Media/Sub/b.png"));
    let state = AppState::default();
    import_paths(&state, &cache(&t), vec![t.path("Job/Media")]);
    let file = t.path("Job/Edit.room");
    save_project_to(&state, Some(file.clone())).unwrap();

    // The whole project folder moved: the linked folder is found by its relative path.
    std::fs::rename(t.path("Job"), t.path("Job Moved")).unwrap();
    let opened = AppState::default();
    open_project_at(&opened, PathBuf::from(t.path("Job Moved/Edit.room"))).unwrap();
    let p = opened.doc.lock().unwrap().project.clone();
    assert_eq!(p.folders.as_ref().unwrap()[0].path, t.path("Job Moved/Media"));
    assert!(p.assets.iter().all(|a| a.path.starts_with(&t.path("Job Moved/Media"))));

    // Gone missing, then located: everything in it is found there.
    std::fs::rename(t.path("Job Moved/Media"), t.path("Elsewhere")).unwrap();
    let r = sync(&opened, &cache(&t));
    assert!(r.removed.is_empty(), "a whole folder gone isn't emptied out; it's found with Locate");
    let id = p.folders.as_ref().unwrap()[0].id;
    let r = locate_folder(&opened, &cache(&t), id, &t.path("Elsewhere")).unwrap();
    assert_eq!(r.moved.len(), 2);
    let p = opened.doc.lock().unwrap().project.clone();
    assert_eq!(p.folders.unwrap()[0].path, t.path("Elsewhere"));
    assert!(p.assets.iter().all(|a| Path::new(&a.path).exists()));
}

#[test]
fn changes_in_a_watched_folder_are_noticed() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = Tmp::new("watch");
    std::fs::create_dir_all(t.path("Shoot/Sub")).unwrap();
    rewatch(&[t.path("Shoot")]);
    let before = GENERATION.load(Ordering::SeqCst);
    touch(&t.path("Shoot/Sub/new.mov"));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while GENERATION.load(Ordering::SeqCst) == before && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(GENERATION.load(Ordering::SeqCst) > before, "a file added in a sub-folder was noticed");
    // Reading a file isn't a change.
    std::thread::sleep(Duration::from_millis(300));
    let settled = GENERATION.load(Ordering::SeqCst);
    let _ = std::fs::read(t.path("Shoot/Sub/new.mov"));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(GENERATION.load(Ordering::SeqCst), settled);
    rewatch(&[]);
}

#[test]
fn the_recovery_copy_is_written_and_reopened_unsaved() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = Tmp::new("recovery");
    let state = AppState::default();
    let c = cache(&t);
    state.doc.lock().unwrap().mutate(|p| p.width = 1280);
    recovery::save(&state, &c).unwrap();
    assert!(recovery::exists(&c));
    let raw = std::fs::read_to_string(recovery::file(&c)).unwrap();
    assert!(!raw.contains('\n'), "compact JSON, as Editroom writes it");
    assert!(raw.starts_with("{\"version\":1"));

    let back = AppState::default();
    let s = recovery::open(&back, &c, None).unwrap();
    assert_eq!(s_project_width(&s), 1280);
    assert!(back.doc.lock().unwrap().dirty, "recovered work is still unsaved");
    assert!(back.file.lock().unwrap().is_none());
    // Changes to a saved project (Auto-save off): reopened over that file.
    let s = recovery::open(&back, &c, Some(t.path("Edit.room"))).unwrap();
    assert_eq!(serde_json::to_value(&s).unwrap()["title"], "Edit");
    recovery::discard(&c);
    assert!(!recovery::exists(&c));
    assert!(recovery::open(&back, &c, None).is_err());
}

fn s_project_width(s: &Snapshot) -> i64 {
    serde_json::to_value(s).unwrap()["project"]["width"].as_i64().unwrap()
}
