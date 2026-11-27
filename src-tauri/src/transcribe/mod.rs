//! Speech to text on this computer with whisper.cpp, for captions, transcript search and the AI
//! tools (docs/spec/05-captions-contract.md; Editroom's `Transcripts`, spec 02-engine §18).
//!
//! - `service`: the queue, one file at a time on a background thread, the cache and the model downloads.
//! - `whisper` / `words` / `audio`: hearing one file: ffmpeg → 16 kHz mono → whisper → words.
//! - `models`: the three speech models and the settings.
//!
//! The commands here are both Tauri commands and entries in the dev server's `dispatch()`.

mod audio;
mod cache;
pub mod models;
mod service;
pub mod state;
mod voice;
mod whisper;
mod words;

pub use service::{Dirs, Service};

use crate::AppState;
use crate::mcp::providers::{self, Transcript, TranscriptProvider};
use models::ModelId;
use promptedit_core::{Id, MediaAsset};
use serde_json::Value;
use state::{ModelState, TranscriptState};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// The tauri.conf.json identifier: Tauri's app data, config and cache folders are named after it.
const IDENTIFIER: &str = "app.promptedit";

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

/// The running service, if `start` or `ensure` has been called.
pub fn service() -> Option<&'static Arc<Service>> {
    SERVICE.get()
}

/// Starts the service with these folders (once; later calls return the first one), and makes it
/// the MCP server's transcript provider.
pub fn start(dirs: Dirs) -> &'static Arc<Service> {
    SERVICE.get_or_init(|| {
        let s = Service::new(dirs);
        s.start();
        providers::set_transcripts(Box::new(Provider));
        s
    })
}

/// Starts the service for the dev server: transcripts in its cache folder, models and settings
/// where the app keeps them (so a model downloaded once serves both), or under
/// `PROMPTEDIT_DATA_DIR` when that's set (tests).
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
    start(Dirs { models: data.join("Models"), settings: config.join("transcription.json"), transcripts: cache_dir.join("Transcripts") })
}

/// Called from `run()`'s setup: the service in Tauri's folders, with events to the window, and
/// items removed from the library no longer heard.
pub fn start_app(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let path = app.path();
    let dirs = Dirs {
        models: path.app_data_dir().map_err(|e| e.to_string())?.join("Models"),
        settings: path.app_config_dir().map_err(|e| e.to_string())?.join("transcription.json"),
        transcripts: path.app_cache_dir().map_err(|e| e.to_string())?.join("Transcripts"),
    };
    let s = start(dirs);
    let h = app.clone();
    s.set_emitter(Box::new(move |event, payload| {
        let _ = h.emit(event, payload);
    }));
    let h = app.clone();
    s.set_wanted(Box::new(move |id| h.state::<AppState>().doc.lock().unwrap().project.assets.iter().any(|a| a.id == id)));
    Ok(())
}

/// Background hearing for newly imported or opened files, if the model is already downloaded.
pub fn auto_queue(assets: &[MediaAsset]) {
    if let Some(s) = service() {
        s.auto_queue(assets);
    }
}

struct Provider;

impl TranscriptProvider for Provider {
    fn cached(&self, asset: &MediaAsset) -> Option<Transcript> {
        service()?.cached(asset)
    }
    /// Waits up to 90 s, as Editroom's `ready()`.
    fn ready(&self, asset: &MediaAsset) -> Option<Transcript> {
        service()?.ready(asset, Duration::from_secs(90))
    }
}

fn asset_of(state: &AppState, id: Id) -> Result<MediaAsset, String> {
    state.doc.lock().unwrap().project.asset(Some(id)).cloned().ok_or_else(|| "No such media.".to_string())
}

fn model_arg(m: Option<String>) -> Result<Option<ModelId>, String> {
    m.map(|m| ModelId::parse(&m).ok_or_else(|| format!("Unknown speech model {m}."))).transpose()
}

// MARK: Commands (shared by Tauri and the dev server)

pub fn get(s: &Service, state: &AppState, asset: Id) -> Result<Option<Transcript>, String> {
    Ok(s.cached(&asset_of(state, asset)?))
}

pub fn queue(s: &Service, state: &AppState, asset: Id) -> Result<TranscriptState, String> {
    // Asked for by the person (Add Captions): a file that failed is tried again.
    Ok(s.queue(&asset_of(state, asset)?, false, true))
}

pub fn state_of(s: &Service, state: &AppState, asset: Id) -> Result<TranscriptState, String> {
    Ok(s.state(&asset_of(state, asset)?))
}

/// The dev server's entries for these commands (`lib.rs` `dispatch`). No events there: the browser
/// polls the state commands.
pub fn dispatch(state: &AppState, cache_dir: &Path, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    let s = ensure(cache_dir);
    let to = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    let asset = || serde_json::from_value::<Id>(args.get("asset").cloned().unwrap_or(Value::Null)).map_err(|e| format!("asset: {e}"));
    let text = |k: &str| args.get(k).and_then(Value::as_str).map(String::from);
    Some(match cmd {
        "transcript_get" => asset().and_then(|a| get(s, state, a)).and_then(|t| to(serde_json::to_value(t))),
        "transcribe" => asset().and_then(|a| queue(s, state, a)).and_then(|t| to(serde_json::to_value(t))),
        "transcript_state" => asset().and_then(|a| state_of(s, state, a)).and_then(|t| to(serde_json::to_value(t))),
        "transcription_settings_get" => to(serde_json::to_value(s.settings())),
        "transcription_settings_set" => {
            s.set_settings(text("model").as_deref(), text("language").as_deref()).and_then(|v| to(serde_json::to_value(v)))
        }
        "transcription_model_download" => model_arg(text("model")).and_then(|m| to(serde_json::to_value(s.download(m)))),
        "transcription_model_state" => to(serde_json::to_value(s.model_state(None))),
        _ => return None,
    })
}

// MARK: Tauri commands

/// Named as the contract names them (the command name is the function's name).
pub mod commands {
    use super::*;

    fn app_service() -> Result<&'static Arc<Service>, String> {
        service().ok_or_else(|| "Transcription isn't running.".to_string())
    }

    #[tauri::command(async)]
    pub fn transcript_get(state: tauri::State<'_, AppState>, asset: Id) -> Result<Option<Transcript>, String> {
        get(app_service()?, &state, asset)
    }

    #[tauri::command(async)]
    pub fn transcribe(state: tauri::State<'_, AppState>, asset: Id) -> Result<TranscriptState, String> {
        queue(app_service()?, &state, asset)
    }

    #[tauri::command(async)]
    pub fn transcript_state(state: tauri::State<'_, AppState>, asset: Id) -> Result<TranscriptState, String> {
        state_of(app_service()?, &state, asset)
    }

    #[tauri::command(async)]
    pub fn transcription_settings_get() -> Result<models::SettingsView, String> {
        Ok(app_service()?.settings())
    }

    #[tauri::command(async)]
    pub fn transcription_settings_set(model: Option<String>, language: Option<String>) -> Result<models::SettingsView, String> {
        app_service()?.set_settings(model.as_deref(), language.as_deref())
    }

    #[tauri::command(async)]
    pub fn transcription_model_download(model: Option<String>) -> Result<ModelState, String> {
        Ok(app_service()?.download(model_arg(model)?))
    }

    #[tauri::command(async)]
    pub fn transcription_model_state() -> Result<ModelState, String> {
        Ok(app_service()?.model_state(None))
    }
}

#[cfg(test)]
mod tests;
