//! What's in the picture, seen on this computer: zero-shot tags ("beach", "dog", "night") from
//! CLIP on ONNX Runtime, for Media search, `list_media` "shows", `search_media` and Magic
//! (Editroom's `SceneTags`, spec 02-engine §17). Nothing is uploaded; the model is downloaded once,
//! only when the person agrees.
//!
//! - `service`: the queue, one file at a time on a background thread, the cache and the download.
//! - `frames` → `clip` → `score`: looking at one file: ffmpeg frames → embeddings → tags.
//! - `words`: matching search words to tags, as Editroom does (also used by the MCP tools).
//!
//! Commands (Tauri commands and the dev server's `dispatch()`), named like transcription's:
//!
//! | Command | Args | Returns |
//! | --- | --- | --- |
//! | `scene_tags_get` | `{ asset }` | `SceneTags \| null` (from disk only, never starts work) |
//! | `scene_tags_all` | `{}` | `{ [assetId]: SceneTags }` for every library item that has them |
//! | `scene_tags_queue` | `{ asset }` | `SceneState` (queues it; retries a failed one) |
//! | `scene_tags_state` | `{ asset }` | `SceneState` |
//! | `scene_settings_get` | `{}` | `{ enabled, declined, model: { label, sizeMB, state: ModelState } }` |
//! | `scene_settings_set` | `{ enabled?, declined? }` | same as get |
//! | `scene_model_download` | `{}` | `ModelState` (then every library item is looked at) |
//! | `scene_model_state` | `{}` | `ModelState` |
//! | `scene_aliases` | `{}` | `{ [tag]: string[] }` (the everyday words for tags) |
//!
//! Events (Tauri only; the browser polls): `scene-tags-state` `{ asset, ...SceneState }`,
//! `scene-model` `ModelState`.

mod cache;
mod clip;
mod frames;
pub mod model;
mod score;
mod service;
mod tokenizer;
pub mod words;

pub use service::{Dirs, SceneState, Service};

use crate::AppState;
use crate::mcp::providers::{self, SceneTagProvider, SceneTags};
use promptedit_core::{Id, MediaAsset};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

/// The tauri.conf.json identifier: Tauri's app data, config and cache folders are named after it.
const IDENTIFIER: &str = "app.promptedit";

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

pub fn service() -> Option<&'static Arc<Service>> {
    SERVICE.get()
}

/// Starts the service with these folders (once), and makes it the MCP server's scene tag provider.
pub fn start(dirs: Dirs) -> &'static Arc<Service> {
    SERVICE.get_or_init(|| {
        let s = Service::new(dirs);
        s.start();
        providers::set_scene_tags(Box::new(Provider));
        s
    })
}

/// For the dev server: tags in its cache folder, the model where the app keeps it (so one
/// download serves both), or under `PROMPTEDIT_DATA_DIR` when that's set (tests).
pub fn ensure(cache_dir: &Path) -> &'static Arc<Service> {
    if let Some(s) = SERVICE.get() {
        return s;
    }
    let (data, config) = match std::env::var_os("PROMPTEDIT_DATA_DIR") {
        Some(d) => (std::path::PathBuf::from(&d), std::path::PathBuf::from(d)),
        None => (
            dirs::data_dir().unwrap_or_else(std::env::temp_dir).join(IDENTIFIER),
            dirs::config_dir().unwrap_or_else(std::env::temp_dir).join(IDENTIFIER),
        ),
    };
    start(Dirs { models: data.join("Models"), settings: config.join("scenes.json"), tags: cache_dir.join("Scenes") })
}

/// Called from `run()`'s setup: the service in Tauri's folders, events to the window, and the
/// open document as the library.
pub fn start_app(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let path = app.path();
    let dirs = Dirs {
        models: path.app_data_dir().map_err(|e| e.to_string())?.join("Models"),
        settings: path.app_config_dir().map_err(|e| e.to_string())?.join("scenes.json"),
        tags: path.app_cache_dir().map_err(|e| e.to_string())?.join("Scenes"),
    };
    let s = start(dirs);
    let h = app.clone();
    s.set_emitter(Box::new(move |event, payload| {
        let _ = h.emit(event, payload);
    }));
    let h = app.clone();
    s.set_library(Box::new(move || h.state::<AppState>().doc.lock().unwrap().project.assets.clone()));
    Ok(())
}

/// Background looking for newly imported or opened files, if the model is already downloaded.
pub fn auto_queue(assets: &[MediaAsset]) {
    if let Some(s) = service() {
        s.auto_queue(assets);
    }
}

struct Provider;

impl SceneTagProvider for Provider {
    /// What's on disk only, as Editroom's tools use (they never wait for tagging).
    fn tags(&self, asset: Id) -> Option<SceneTags> {
        let s = service()?;
        s.cached(&s.asset(asset)?)
    }
}

fn asset_of(state: &AppState, id: Id) -> Result<MediaAsset, String> {
    state.doc.lock().unwrap().project.asset(Some(id)).cloned().ok_or_else(|| "No such media.".to_string())
}

// MARK: Commands (shared by Tauri and the dev server)

pub fn get(s: &Service, state: &AppState, asset: Id) -> Result<Option<SceneTags>, String> {
    Ok(s.cached(&asset_of(state, asset)?))
}

pub fn all(s: &Service, state: &AppState) -> BTreeMap<String, SceneTags> {
    let assets = state.doc.lock().unwrap().project.assets.clone();
    assets.iter().filter_map(|a| s.cached(a).map(|t| (a.id.to_string(), t))).collect()
}

pub fn queue(s: &Service, state: &AppState, asset: Id) -> Result<SceneState, String> {
    Ok(s.queue(&asset_of(state, asset)?, std::time::Duration::ZERO, true))
}

pub fn state_of(s: &Service, state: &AppState, asset: Id) -> Result<SceneState, String> {
    Ok(s.state(&asset_of(state, asset)?))
}

pub fn aliases() -> &'static std::collections::HashMap<String, Vec<String>> {
    words::aliases()
}

/// The dev server's entries for these commands (`lib.rs` `dispatch`). No events there: the browser
/// polls the state commands.
pub fn dispatch(state: &AppState, cache_dir: &Path, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    if !cmd.starts_with("scene_") {
        return None;
    }
    let s = ensure(cache_dir);
    // The dev server has no `Library`: the open document is the one it's handed.
    s.remember(&state.doc.lock().unwrap().project.assets);
    let to = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    let asset = || serde_json::from_value::<Id>(args.get("asset").cloned().unwrap_or(Value::Null)).map_err(|e| format!("asset: {e}"));
    let flag = |k: &str| args.get(k).and_then(Value::as_bool);
    Some(match cmd {
        "scene_tags_get" => asset().and_then(|a| get(s, state, a)).and_then(|t| to(serde_json::to_value(t))),
        "scene_tags_all" => to(serde_json::to_value(all(s, state))),
        "scene_tags_queue" => asset().and_then(|a| queue(s, state, a)).and_then(|t| to(serde_json::to_value(t))),
        "scene_tags_state" => asset().and_then(|a| state_of(s, state, a)).and_then(|t| to(serde_json::to_value(t))),
        "scene_settings_get" => to(serde_json::to_value(s.settings())),
        "scene_settings_set" => s.set_settings(flag("enabled"), flag("declined")).and_then(|v| to(serde_json::to_value(v))),
        "scene_model_download" => to(serde_json::to_value(s.download())),
        "scene_model_state" => to(serde_json::to_value(s.model_state())),
        "scene_aliases" => to(serde_json::to_value(aliases())),
        _ => return None,
    })
}

// MARK: Tauri commands

pub mod commands {
    use super::*;
    use crate::transcribe::state::ModelState;

    fn app_service() -> Result<&'static Arc<Service>, String> {
        service().ok_or_else(|| "Picture search isn't running.".to_string())
    }

    #[tauri::command(async)]
    pub fn scene_tags_get(state: tauri::State<'_, AppState>, asset: Id) -> Result<Option<SceneTags>, String> {
        get(app_service()?, &state, asset)
    }

    #[tauri::command(async)]
    pub fn scene_tags_all(state: tauri::State<'_, AppState>) -> Result<BTreeMap<String, SceneTags>, String> {
        Ok(all(app_service()?, &state))
    }

    #[tauri::command(async)]
    pub fn scene_tags_queue(state: tauri::State<'_, AppState>, asset: Id) -> Result<SceneState, String> {
        queue(app_service()?, &state, asset)
    }

    #[tauri::command(async)]
    pub fn scene_tags_state(state: tauri::State<'_, AppState>, asset: Id) -> Result<SceneState, String> {
        state_of(app_service()?, &state, asset)
    }

    #[tauri::command(async)]
    pub fn scene_settings_get() -> Result<service::SettingsView, String> {
        Ok(app_service()?.settings())
    }

    #[tauri::command(async)]
    pub fn scene_settings_set(enabled: Option<bool>, declined: Option<bool>) -> Result<service::SettingsView, String> {
        app_service()?.set_settings(enabled, declined)
    }

    #[tauri::command(async)]
    pub fn scene_model_download() -> Result<ModelState, String> {
        Ok(app_service()?.download())
    }

    #[tauri::command(async)]
    pub fn scene_model_state() -> Result<ModelState, String> {
        Ok(app_service()?.model_state())
    }

    #[tauri::command(async)]
    pub fn scene_aliases() -> std::collections::HashMap<String, Vec<String>> {
        aliases().clone()
    }
}

#[cfg(test)]
mod tests;
