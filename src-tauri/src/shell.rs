//! The window and file side of the app shell (docs/spec/04-ui.md §1.1, §1.7, §1.9, §6.3): files opened
//! from Finder/Explorer, the custom title bar on Windows, and small file and project helpers the UI
//! needs (does a file exist, show it in the file manager, where exports go by default, remembering the
//! export name and folder).

use crate::{snapshot, AppState, Snapshot};
use promptedit_core::Id;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, RunEvent, Runtime, State};

/// Files handed to the app before the UI asked for them (at launch, or before the window loaded).
static PENDING_OPEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Command-line files (Windows "Open with", double-clicked `.room`): everything that isn't a flag.
fn launch_args() -> Vec<String> {
    std::env::args().skip(1).filter(|a| !a.starts_with('-') && Path::new(a).exists()).collect()
}

/// Called from `run()`'s setup: window chrome per platform, and the files the app was launched with.
pub fn setup<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    PENDING_OPEN.lock().unwrap().extend(launch_args());
    // Windows: one unified row like Editroom's toolbar, so the system frame goes and the UI draws the
    // title bar, its menus and the window buttons (TitleBar.tsx). macOS keeps its traffic lights over
    // the UI's title bar (titleBarStyle "Overlay" in tauri.conf.json).
    #[cfg(windows)]
    {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            w.set_decorations(false)?;
        }
    }
    let _ = app;
    Ok(())
}

/// macOS: files opened from Finder or dropped on the Dock icon. Before the UI is ready they wait for
/// `take_open_files`; afterwards they arrive as an `open-files` event.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if let RunEvent::Opened { urls } = &event {
        let paths: Vec<String> = urls
            .iter()
            .filter_map(|u| u.to_file_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if !paths.is_empty() {
            use tauri::Emitter;
            PENDING_OPEN.lock().unwrap().extend(paths.iter().cloned());
            let _ = app.emit("open-files", ());
        }
    }
    let _ = (app, event);
}

/// Files waiting to be opened (and forgets them).
#[tauri::command]
pub fn take_open_files() -> Vec<String> {
    std::mem::take(&mut *PENDING_OPEN.lock().unwrap())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Show in Finder / Show in Explorer.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// Folders the UI starts dialogs in: home and Desktop (exports of unsaved projects go to the Desktop).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dirs {
    home: Option<String>,
    desktop: Option<String>,
}

#[tauri::command]
pub fn user_dirs() -> Dirs {
    let s = |p: Option<std::path::PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    Dirs { home: s(dirs::home_dir()), desktop: s(dirs::desktop_dir().or_else(dirs::home_dir)) }
}

/// The sequence's size and rate are settled (the first video import asked once). Not an undoable edit.
pub fn settings_locked(state: &AppState, locked: bool) -> Snapshot {
    {
        let mut doc = state.doc.lock().unwrap();
        if doc.project.settings_locked != locked {
            doc.project.settings_locked = locked;
            doc.dirty = true;
        }
    }
    snapshot(state, None)
}

#[tauri::command]
pub fn set_settings_locked(state: State<AppState>, locked: bool) -> Snapshot {
    settings_locked(&state, locked)
}

/// Remembers where exports go (name and folder), in the project. Not an undoable edit.
pub fn export_target(state: &AppState, name: String, dir: String) -> Snapshot {
    {
        let mut doc = state.doc.lock().unwrap();
        let p = &mut doc.project;
        if p.export_name.as_deref() != Some(&name) || p.export_dir.as_deref() != Some(&dir) {
            p.export_name = Some(name);
            p.export_dir = Some(dir);
            doc.dirty = true;
        }
    }
    snapshot(state, None)
}

#[tauri::command]
pub fn set_export_target(state: State<AppState>, name: String, dir: String) -> Snapshot {
    export_target(&state, name, dir)
}

/// Points a Media item at its file again (Locate…, Reload from Disk): probed afresh, keeping the item's
/// id and name so its clips stay. A file the webview can't decode gets a fresh playable copy.
pub fn relink(state: &AppState, cache_dir: &Path, asset: Id, path: &str) -> Result<Snapshot, String> {
    let file = Path::new(path);
    let probe = crate::media::probe(file).map_err(|_| format!("“{}” isn't a file PromptEdit can read.", file.display()))?;
    let playable = if probe.kind != promptedit_core::MediaKind::Image && !crate::media::container_is_native(&probe) {
        Some(crate::media::make_playable(file, &cache_dir.join("Converted"), false).ok_or("Couldn't convert this file.")?)
    } else {
        None
    };
    {
        let mut doc = state.doc.lock().unwrap();
        let a = doc.project.assets.iter_mut().find(|a| a.id == asset).ok_or("No such media.")?;
        let fresh = crate::media::asset_for(file, &probe);
        a.path = fresh.path;
        a.relative_path = None;
        a.playable_path = playable.map(|p| p.to_string_lossy().into_owned());
        a.kind = fresh.kind;
        a.duration = fresh.duration;
        a.width = fresh.width;
        a.height = fresh.height;
        a.fps = fresh.fps;
        a.has_audio = fresh.has_audio;
        doc.dirty = true;
    }
    Ok(snapshot(state, None))
}

#[tauri::command]
pub async fn relink_asset<R: Runtime>(app: AppHandle<R>, asset: Id, path: String) -> Result<Snapshot, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || relink(&app2.state::<AppState>(), &cache, asset, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// File › Exit on Windows (macOS quits from the app menu).
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

/// The same commands for the browser dev server (`dispatch`). None when the command isn't one of these.
pub fn dispatch(state: &AppState, cache_dir: &Path, cmd: &str, args: &serde_json::Value) -> Option<Result<serde_json::Value, String>> {
    use serde_json::to_value;
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let ok = |v: Result<serde_json::Value, serde_json::Error>| v.map_err(|e| e.to_string());
    Some(match cmd {
        "take_open_files" => ok(to_value(Vec::<String>::new())),
        "path_exists" => ok(to_value(s("path").is_some_and(|p| Path::new(&p).exists()))),
        "user_dirs" => ok(to_value(user_dirs())),
        "set_settings_locked" => ok(to_value(settings_locked(state, args.get("locked").and_then(|v| v.as_bool()).unwrap_or(true)))),
        "set_export_target" => match (s("name"), s("dir")) {
            (Some(n), Some(d)) => ok(to_value(export_target(state, n, d))),
            _ => Err("name and dir are needed".into()),
        },
        "relink_asset" => match (args.get("asset").cloned().map(serde_json::from_value::<Id>), s("path")) {
            (Some(Ok(id)), Some(p)) => relink(state, cache_dir, id, &p).and_then(|v| to_value(v).map_err(|e| e.to_string())),
            _ => Err("asset and path are needed".into()),
        },
        // No file manager or native menu behind the dev server.
        "reveal_path" | "quit_app" => ok(to_value(())),
        "set_app_menu" => ok(to_value(false)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_target_and_lock_are_remembered_without_undo() {
        let state = AppState::default();
        let s = dispatch(&state, Path::new("/tmp"), "set_export_target", &serde_json::json!({ "name": "cut", "dir": "/tmp" })).unwrap().unwrap();
        assert_eq!(s["project"]["exportName"], "cut");
        assert_eq!(s["canUndo"], false);
        let s = dispatch(&state, Path::new("/tmp"), "set_settings_locked", &serde_json::json!({ "locked": true })).unwrap().unwrap();
        assert_eq!(s["project"]["settingsLocked"], true);
        assert!(dispatch(&state, Path::new("/tmp"), "nope", &serde_json::Value::Null).is_none());
    }
}
