//! The recovery copy (Editroom EditorModel "Autosave and recovery"; docs/spec/01-model.md §1.3–§1.4):
//! unsaved work on an untitled project, or unsaved changes to a saved project while Auto-save is off,
//! is kept in `<app data>/Recovery/Untitled.room`, so a crash or a quit loses nothing. It reopens at
//! the next launch, still unsaved.
//!
//! The UI decides when to write it (src/ui/shell/files.ts, which also keeps `lastSession` and
//! `recoveryFor`, as Editroom keeps them in UserDefaults); this module only reads and writes the file.
//! Like Editroom's, the copy is compact JSON with no relative paths stamped.

use crate::{snapshot, AppState, Snapshot};
use promptedit_core::history::Document;
use promptedit_core::SavedDocument;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called from `run()`'s setup: the copy lives in the app's data folder.
pub fn start_app(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(d) = app.path().app_data_dir() {
        let _ = DIR.set(d.join("Recovery"));
    }
}

/// Where the copy is. Behind the dev server (no app data folder) it sits in the dev cache, one per
/// port, so several dev servers on one machine don't share it.
pub fn file(cache_dir: &Path) -> PathBuf {
    let dir = DIR.get().cloned().unwrap_or_else(|| match std::env::var_os("PROMPTEDIT_DATA_DIR") {
        Some(d) => PathBuf::from(d).join("Recovery"),
        None => cache_dir.join(match std::env::var("PROMPTEDIT_DEV_PORT") {
            Ok(port) => format!("Recovery-{port}"),
            Err(_) => "Recovery".into(),
        }),
    });
    dir.join("Untitled.room")
}

/// Writes the open project to the copy (atomically). It stays unsaved: the copy isn't the project file.
pub fn save(state: &AppState, cache_dir: &Path) -> Result<Snapshot, String> {
    let bytes = {
        let mut doc = state.doc.lock().unwrap();
        doc.commit_live();
        SavedDocument::new(doc.project.clone()).to_json()
    };
    let target = file(cache_dir);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("room.tmp");
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &target)).map_err(|e| e.to_string())?;
    Ok(snapshot(state, None))
}

/// Lets the copy go (saved, discarded, or nothing worth keeping).
pub fn discard(cache_dir: &Path) {
    let _ = std::fs::remove_file(file(cache_dir));
}

pub fn exists(cache_dir: &Path) -> bool {
    file(cache_dir).is_file()
}

/// Opens the copy as the project, unsaved. `belongs_to`: the project file it holds changes to (Auto-save
/// off); media moved along with that file's folder is found by relative path, as when it opens.
pub fn open(state: &AppState, cache_dir: &Path, belongs_to: Option<String>) -> Result<Snapshot, String> {
    let bytes = std::fs::read(file(cache_dir)).map_err(|_| "There's no unsaved work to recover.".to_string())?;
    let mut saved = SavedDocument::from_json(&bytes).map_err(|_| "The unsaved work couldn't be read.".to_string())?;
    let path = belongs_to.map(PathBuf::from);
    if let Some(dir) = path.as_deref().and_then(Path::parent) {
        saved.project.resolve_moved_media(dir);
    }
    let assets = saved.project.assets.clone();
    let mut doc = Document::new(saved.project);
    doc.dirty = true;
    *state.doc.lock().unwrap() = doc;
    *state.file.lock().unwrap() = path;
    crate::transcribe::auto_queue(&assets);
    Ok(snapshot(state, None))
}

// ---- Commands ----

fn cache(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_cache_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recovery_save(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<Snapshot, String> {
    save(&state, &cache(&app)?)
}

#[tauri::command]
pub fn recovery_discard(app: tauri::AppHandle) -> Result<(), String> {
    discard(&cache(&app)?);
    Ok(())
}

#[tauri::command]
pub fn recovery_exists(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(exists(&cache(&app)?))
}

#[tauri::command]
pub fn recovery_open(app: tauri::AppHandle, state: tauri::State<AppState>, file: Option<String>) -> Result<Snapshot, String> {
    open(&state, &cache(&app)?, file)
}

/// The same commands for the browser dev server (`dispatch`). None when the command isn't one of these.
pub fn dispatch(state: &AppState, cache_dir: &Path, cmd: &str, args: &serde_json::Value) -> Option<Result<serde_json::Value, String>> {
    use serde_json::to_value;
    let to = |v: Result<Snapshot, String>| v.and_then(|s| to_value(s).map_err(|e| e.to_string()));
    Some(match cmd {
        "recovery_save" => to(save(state, cache_dir)),
        "recovery_discard" => {
            discard(cache_dir);
            Ok(serde_json::Value::Null)
        }
        "recovery_exists" => Ok(serde_json::Value::Bool(exists(cache_dir))),
        "recovery_open" => to(open(state, cache_dir, args.get("file").and_then(|v| v.as_str()).map(str::to_owned))),
        _ => return None,
    })
}
