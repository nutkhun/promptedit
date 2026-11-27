//! PromptEdit's app shell: the open document, file I/O and media, exposed to the UI as commands.

pub mod agents;
pub mod magic;
pub mod mcp;
pub mod media;
pub mod menu;
pub mod shell;
pub mod render;
pub mod transcribe;

use promptedit_core::edit::{Edit, Outcome};
use promptedit_core::history::Document;
use promptedit_core::{Id, MediaAsset, Project, SavedDocument};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

/// Project file extensions: Editroom's `.room`, and its older `.cutplay`.
pub const PROJECT_EXTENSIONS: &[&str] = &["room", "cutplay"];

#[derive(Default)]
pub struct AppState {
    pub doc: Mutex<Document>,
    pub file: Mutex<Option<PathBuf>>,
}

/// What the UI needs after any change.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    project: Project,
    file: Option<String>,
    title: String,
    dirty: bool,
    can_undo: bool,
    can_redo: bool,
    outcome: Option<Outcome>,
}

pub fn snapshot(state: &AppState, outcome: Option<Outcome>) -> Snapshot {
    let doc = state.doc.lock().unwrap();
    let file = state.file.lock().unwrap().clone();
    Snapshot {
        project: doc.project.clone(),
        title: file
            .as_deref()
            .and_then(Path::file_stem)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into()),
        file: file.map(|f| f.to_string_lossy().into_owned()),
        dirty: doc.dirty,
        can_undo: doc.can_undo(),
        can_redo: doc.can_redo(),
        outcome,
    }
}

#[tauri::command]
fn get_project(state: State<AppState>) -> Snapshot {
    snapshot(&state, None)
}

#[tauri::command]
fn new_project(state: State<AppState>) -> Snapshot {
    *state.doc.lock().unwrap() = Document::new(Project::default());
    *state.file.lock().unwrap() = None;
    snapshot(&state, None)
}

#[tauri::command]
fn open_project(state: State<AppState>, path: String) -> Result<Snapshot, String> {
    open_project_at(&state, PathBuf::from(path))
}

pub fn open_project_at(state: &AppState, path: PathBuf) -> Result<Snapshot, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut doc = SavedDocument::from_json(&bytes).map_err(|_| {
        format!("Couldn't open {}.", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())
    })?;
    if let Some(dir) = path.parent() {
        doc.project.resolve_moved_media(dir);
    }
    // What's said in its files, in the background, if the speech model is here (as Editroom does
    // for every file it opens).
    let assets = doc.project.assets.clone();
    *state.doc.lock().unwrap() = Document::new(doc.project);
    *state.file.lock().unwrap() = Some(path);
    transcribe::auto_queue(&assets);
    Ok(snapshot(state, None))
}

/// Saves to `path`, or to the current file. Pretty-printed with sorted keys, as Editroom saves.
#[tauri::command]
fn save_project(state: State<AppState>, path: Option<String>) -> Result<Snapshot, String> {
    save_project_to(&state, path)
}

pub fn save_project_to(state: &AppState, path: Option<String>) -> Result<Snapshot, String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => state.file.lock().unwrap().clone().ok_or("No file to save to.")?,
    };
    {
        let mut doc = state.doc.lock().unwrap();
        doc.commit_live();
        let mut project = doc.project.clone();
        if let Some(dir) = target.parent() {
            project.stamp_relative_paths(dir);
        }
        let value = serde_json::to_value(SavedDocument::new(project)).map_err(|e| e.to_string())?;
        // serde_json's Value map is sorted (BTreeMap), matching `.sortedKeys`.
        let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
        let tmp = target.with_extension("room.tmp");
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &target)).map_err(|e| e.to_string())?;
        doc.dirty = false;
    }
    *state.file.lock().unwrap() = Some(target);
    Ok(snapshot(state, None))
}

#[tauri::command]
fn edit(state: State<AppState>, edit: Edit, live: Option<bool>) -> Snapshot {
    let outcome = {
        let mut doc = state.doc.lock().unwrap();
        if live == Some(true) { edit.apply_live(&mut doc) } else { edit.apply(&mut doc) }
    };
    snapshot(&state, Some(outcome))
}

#[tauri::command]
fn commit_live(state: State<AppState>) -> Snapshot {
    state.doc.lock().unwrap().commit_live();
    snapshot(&state, None)
}

#[tauri::command]
fn discard_live(state: State<AppState>) -> Snapshot {
    state.doc.lock().unwrap().discard_live();
    snapshot(&state, None)
}

#[tauri::command]
fn undo(state: State<AppState>) -> Snapshot {
    state.doc.lock().unwrap().undo();
    snapshot(&state, None)
}

#[tauri::command]
fn redo(state: State<AppState>) -> Snapshot {
    state.doc.lock().unwrap().redo();
    snapshot(&state, None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub snapshot: Snapshot,
    pub added: Vec<Id>,
    pub probes: Vec<(Id, media::Probe)>,
    pub failed: Vec<String>,
}

/// Brings files into the library (not undoable, as in Editroom). Files the engine can't read
/// directly get a playable copy in the app's cache.
#[tauri::command]
async fn import_media(app: tauri::AppHandle, paths: Vec<String>) -> Result<ImportResult, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || import_paths(&app2.state::<AppState>(), &cache, paths))
        .await
        .map_err(|e| e.to_string())
}

/// Brings files into the library (not undoable, as in Editroom). Files the engine can't read
/// directly get a playable copy in `cache_dir/Converted`.
pub fn import_paths(state: &AppState, cache_dir: &Path, paths: Vec<String>) -> ImportResult {
    let converted = cache_dir.join("Converted");
    let mut ok: Vec<(MediaAsset, media::Probe)> = vec![];
    let mut failed = vec![];
    for p in paths {
        let path = PathBuf::from(&p);
        match media::probe(&path) {
            Ok(probe) => {
                let mut asset = media::asset_for(&path, &probe);
                if probe.kind != promptedit_core::MediaKind::Image && !media::container_is_native(&probe) {
                    match media::make_playable(&path, &converted, false) {
                        Some(copy) => asset.playable_path = Some(copy.to_string_lossy().into_owned()),
                        None => {
                            failed.push(p);
                            continue;
                        }
                    }
                }
                ok.push((asset, probe));
            }
            Err(_) => failed.push(p),
        }
    }
    let mut added = vec![];
    let mut probes = vec![];
    let mut new_assets = vec![];
    {
        let mut doc = state.doc.lock().unwrap();
        for (asset, probe) in ok {
            // The same file twice is one library item.
            if let Some(existing) = doc.project.assets.iter().find(|a| a.path == asset.path) {
                probes.push((existing.id, probe));
                continue;
            }
            added.push(asset.id);
            probes.push((asset.id, probe));
            new_assets.push(asset.clone());
            doc.project.assets.push(asset);
        }
        if !added.is_empty() {
            doc.dirty = true;
        }
    }
    // Heard in the background if the speech model is already here, so search finds what's said.
    transcribe::auto_queue(&new_assets);
    ImportResult { snapshot: snapshot(state, None), added, probes, failed }
}

/// Re-probes one library item (for the UI's codec check).
#[tauri::command]
async fn probe_media(path: String) -> Result<media::Probe, String> {
    tauri::async_runtime::spawn_blocking(move || media::probe(Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// Makes an edit-friendly copy of a file the webview can't decode (e.g. HEVC without
/// hardware support, ProRes) and points the asset at it.
#[tauri::command]
async fn transcode_media(app: tauri::AppHandle, asset: Id) -> Result<Snapshot, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || transcode_asset(&app2.state::<AppState>(), &cache, asset))
        .await
        .map_err(|e| e.to_string())?
}

/// Makes an edit-friendly copy of a file the webview can't decode (e.g. HEVC without
/// hardware support, ProRes) and points the asset at it.
pub fn transcode_asset(state: &AppState, cache_dir: &Path, asset: Id) -> Result<Snapshot, String> {
    let src = {
        let doc = state.doc.lock().unwrap();
        doc.project.asset(Some(asset)).map(|a| a.path.clone()).ok_or("No such media.")?
    };
    let copy = media::make_playable(Path::new(&src), &cache_dir.join("Converted"), true).ok_or("Couldn't convert this file.")?;
    {
        let mut doc = state.doc.lock().unwrap();
        if let Some(a) = doc.project.assets.iter_mut().find(|a| a.id == asset) {
            a.playable_path = Some(copy.to_string_lossy().into_owned());
        }
        doc.dirty = true;
    }
    Ok(snapshot(state, None))
}

/// Runs a command by name with JSON arguments, the way `invoke` does. Used by the browser
/// dev server (`src/bin/devserver.rs`) so the UI can be tested outside the Tauri window.
pub fn dispatch(state: &AppState, cache_dir: &Path, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::{from_value, to_value, Value};
    let arg = |k: &str| args.get(k).cloned().unwrap_or(Value::Null);
    let ok = |v: Snapshot| to_value(v).map_err(|e| e.to_string());
    // Transcription runs from the first command, so imports are heard in the background too.
    transcribe::ensure(cache_dir);
    match cmd {
        "get_project" => ok(snapshot(state, None)),
        "new_project" => {
            *state.doc.lock().unwrap() = Document::new(Project::default());
            *state.file.lock().unwrap() = None;
            ok(snapshot(state, None))
        }
        "edit" => {
            let e: Edit = from_value(arg("edit")).map_err(|e| e.to_string())?;
            let live = arg("live").as_bool() == Some(true);
            let outcome = {
                let mut doc = state.doc.lock().unwrap();
                if live { e.apply_live(&mut doc) } else { e.apply(&mut doc) }
            };
            ok(snapshot(state, Some(outcome)))
        }
        "commit_live" => {
            state.doc.lock().unwrap().commit_live();
            ok(snapshot(state, None))
        }
        "discard_live" => {
            state.doc.lock().unwrap().discard_live();
            ok(snapshot(state, None))
        }
        "undo" => {
            state.doc.lock().unwrap().undo();
            ok(snapshot(state, None))
        }
        "redo" => {
            state.doc.lock().unwrap().redo();
            ok(snapshot(state, None))
        }
        "open_project" => {
            let path: String = from_value(arg("path")).map_err(|e| e.to_string())?;
            ok(open_project_at(state, PathBuf::from(path))?)
        }
        "save_project" => {
            let path: Option<String> = from_value(arg("path")).unwrap_or(None);
            ok(save_project_to(state, path)?)
        }
        "import_media" => {
            let paths: Vec<String> = from_value(arg("paths")).map_err(|e| e.to_string())?;
            to_value(import_paths(state, cache_dir, paths)).map_err(|e| e.to_string())
        }
        "probe_media" => {
            let path: String = from_value(arg("path")).map_err(|e| e.to_string())?;
            to_value(media::probe(Path::new(&path))?).map_err(|e| e.to_string())
        }
        "transcode_media" => {
            let asset: Id = from_value(arg("asset")).map_err(|e| e.to_string())?;
            ok(transcode_asset(state, cache_dir, asset)?)
        }
        other => render::dispatch(cache_dir, other, &args)
            .or_else(|| shell::dispatch(state, cache_dir, other, &args))
            .or_else(|| mcp::commands::dispatch(state, cache_dir, other, &args))
            .or_else(|| transcribe::dispatch(state, cache_dir, other, &args))
            .unwrap_or_else(|| Err(format!("Unknown command {other}"))),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // Speech to text (src/transcribe): the queue's thread, and the MCP transcript provider
            // (registered first, so the MCP server's first tools can hear files).
            if let Err(e) = transcribe::start_app(app.handle()) {
                eprintln!("Transcription didn't start: {e}");
            }
            // The MCP server for AI apps and Magic (src/mcp), then the shell.
            mcp::commands::start_app(app.handle().clone());
            shell::setup(app)
        })
        .on_menu_event(menu::on_menu_event)
        .invoke_handler(tauri::generate_handler![
            get_project,
            new_project,
            open_project,
            save_project,
            edit,
            commit_live,
            discard_live,
            undo,
            redo,
            import_media,
            probe_media,
            transcode_media,
            render::audio_pcm,
            render::audio_waveform,
            render::export_begin,
            render::export_append,
            render::export_loudness,
            render::export_finish,
            render::export_cancel,
            menu::set_app_menu,
            shell::take_open_files,
            shell::path_exists,
            shell::reveal_path,
            shell::user_dirs,
            shell::set_settings_locked,
            shell::set_export_target,
            shell::quit_app,
            shell::relink_asset,
            mcp::commands::mcp_status,
            mcp::commands::mcp_set_enabled,
            mcp::commands::mcp_report_view,
            mcp::commands::mcp_export_update,
            mcp::commands::agents_status_cmd,
            mcp::commands::agents_connect,
            mcp::commands::agents_disconnect,
            mcp::commands::agents_cancel_waiting,
            mcp::commands::agents_reopen_claude,
            mcp::commands::agents_connect_prompt,
            magic::commands::magic_state,
            magic::commands::magic_start,
            magic::commands::magic_stop,
            magic::commands::magic_dismiss_note,
            magic::commands::magic_models,
            magic::commands::magic_availability,
            magic::commands::magic_local_status,
            magic::commands::magic_sign_in,
            transcribe::commands::transcript_get,
            transcribe::commands::transcribe,
            transcribe::commands::transcript_state,
            transcribe::commands::transcription_settings_get,
            transcribe::commands::transcription_settings_set,
            transcribe::commands::transcription_model_download,
            transcribe::commands::transcription_model_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while running PromptEdit")
        .run(shell::on_run_event);
}
