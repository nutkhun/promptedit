//! What the MCP tools and Magic need from the app: the open document, a way to tell the UI that
//! it changed, and the media cache. The Tauri app provides it with its `AppHandle`; tests provide
//! their own, so the server runs headless.

use crate::{AppState, ImportResult, snapshot};
use serde_json::Value;
use std::path::PathBuf;

pub trait Host: Send + Sync {
    fn state(&self) -> &AppState;
    /// Sends an event to the UI (`project-changed`, `agent-presence`, …).
    fn emit(&self, event: &str, payload: Value);
    /// Where converted media goes (the app cache).
    fn cache_dir(&self) -> PathBuf;

    /// Tells the UI the project changed, with the same snapshot the commands return.
    fn project_changed(&self) {
        let s = snapshot(self.state(), None);
        self.emit("project-changed", serde_json::to_value(s).unwrap_or(Value::Null));
    }

    /// Bounces the Dock icon / flashes the taskbar when a Magic run finishes in the background.
    fn request_attention(&self) {}

    /// Brings files into the library, as the Import button does.
    fn import(&self, paths: Vec<String>) -> ImportResult {
        crate::import_paths(self.state(), &self.cache_dir(), paths)
    }
}

/// The app's own host.
pub struct TauriHost(pub tauri::AppHandle);

impl Host for TauriHost {
    fn state(&self) -> &AppState {
        use tauri::Manager;
        self.0.state::<AppState>().inner()
    }
    fn emit(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.0.emit(event, payload);
    }
    fn cache_dir(&self) -> PathBuf {
        use tauri::Manager;
        self.0.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("promptedit-cache"))
    }
    fn request_attention(&self) {
        use tauri::Manager;
        for w in self.0.webview_windows().values() {
            if !w.is_focused().unwrap_or(true) {
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }
    }
}

/// A host over a borrowed document, for the browser dev server's command dispatch (no events).
pub struct BorrowedHost<'a> {
    pub state: &'a AppState,
    pub cache: PathBuf,
}

impl Host for BorrowedHost<'_> {
    fn state(&self) -> &AppState {
        self.state
    }
    fn emit(&self, _event: &str, _payload: Value) {}
    fn cache_dir(&self) -> PathBuf {
        self.cache.clone()
    }
}

/// A host for tests and headless use: owns its document and records the events it would send.
#[derive(Default)]
pub struct HeadlessHost {
    pub state: AppState,
    pub events: std::sync::Mutex<Vec<(String, Value)>>,
    pub cache: PathBuf,
}

impl Host for HeadlessHost {
    fn state(&self) -> &AppState {
        &self.state
    }
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
    fn cache_dir(&self) -> PathBuf {
        if self.cache.as_os_str().is_empty() { std::env::temp_dir().join("promptedit-headless-cache") } else { self.cache.clone() }
    }
}
