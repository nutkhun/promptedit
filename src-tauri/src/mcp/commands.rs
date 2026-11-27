//! The commands the UI uses for the MCP server and agent connect (Settings › Magic, the Magic
//! popover), the app start-up hook, and their entries in the dev server's `dispatch`.

use super::host::{BorrowedHost, Host, TauriHost};
use super::providers::ExportStatus;
use super::{mcp, presence, server, settings};
use crate::AppState;
use crate::agents::{AgentApp, Agents, State as AgentState};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, OnceLock};

static APP_HOST: OnceLock<Arc<dyn Host>> = OnceLock::new();

/// The app's host, once the app has started (None in the dev server and tests).
pub fn app_host() -> Option<Arc<dyn Host>> {
    APP_HOST.get().cloned()
}

pub fn set_app_host(h: Arc<dyn Host>) {
    let _ = APP_HOST.set(h);
}

/// Starts listening (in the background) on the usual port, or any free one.
pub fn start_server(host: Arc<dyn Host>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server::start(host, super::default_port()).await {
            eprintln!("MCP server: {e}");
        }
    });
}

/// Called once from `run()`: the MCP server starts if AI apps may edit, and the launchers the AI
/// apps have are pointed at this copy of PromptEdit.
pub fn start_app(handle: tauri::AppHandle) {
    let host: Arc<dyn Host> = Arc::new(TauriHost(handle));
    set_app_host(host.clone());
    if settings::get().agents_enabled {
        start_server(host);
    }
    std::thread::spawn(|| Agents::user().follow_move());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: Option<u16>,
    pub endpoint: String,
    pub problem: Option<String>,
    pub enabled: bool,
    /// Agents seen in the last 60 s, with their cursor colours.
    pub clients: Vec<Value>,
}

pub fn status() -> Status {
    let m = mcp();
    Status {
        running: server::is_running(),
        port: *m.listening.lock().unwrap(),
        endpoint: super::endpoint(),
        problem: m.problem.lock().unwrap().clone(),
        enabled: settings::get().agents_enabled,
        clients: m.recent_clients().iter().map(|c| json!({"name": c.name, "color": presence::color(&c.name)})).collect(),
    }
}

pub fn set_enabled(enabled: bool) -> Status {
    settings::update(|s| s.agents_enabled = enabled);
    if enabled {
        if let Some(h) = app_host() {
            start_server(h);
        }
    } else {
        server::stop();
    }
    status()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    pub app: AgentApp,
    pub title: &'static str,
    #[serde(flatten)]
    pub state: AgentState,
    pub download: Option<&'static str>,
    pub cursor_name: &'static str,
}

pub fn agents_status() -> Vec<AgentRow> {
    let a = Agents::user();
    AgentApp::ALL.iter().map(|&app| AgentRow { app, title: app.title(), state: a.status(app), download: app.download(), cursor_name: app.cursor_name() }).collect()
}

fn row(app: AgentApp, state: AgentState) -> AgentRow {
    AgentRow { app, title: app.title(), state, download: app.download(), cursor_name: app.cursor_name() }
}

pub fn connect(app: AgentApp) -> Result<AgentRow, String> {
    let s = Agents::user().connect(app)?;
    // Connecting an AI turns "Let AI apps edit" on, and with it the server.
    set_enabled(true);
    Ok(row(app, s))
}

pub fn disconnect(app: AgentApp) -> Result<AgentRow, String> {
    Agents::user().disconnect(app).map(|s| row(app, s))
}

fn export_update(id: &str, status: &str, progress: f64, error: Option<String>) {
    let s = match status {
        "running" => ExportStatus::Running,
        "done" => ExportStatus::Done,
        "failed" => ExportStatus::Failed(error.unwrap_or_else(|| "unknown error".into())),
        "cancelled" => ExportStatus::Cancelled,
        _ => ExportStatus::Waiting,
    };
    mcp().exports.update(id, s, progress);
}

fn report_view(playhead: f64, playing: bool) {
    *mcp().view.lock().unwrap() = super::View { playhead, playing };
}

// MARK: Tauri commands

#[tauri::command]
pub fn mcp_status() -> Status {
    status()
}

#[tauri::command]
pub fn mcp_set_enabled(enabled: bool) -> Status {
    set_enabled(enabled)
}

/// The UI reports the playhead and transport (it owns playback) for get_project and get_frame.
#[tauri::command]
pub fn mcp_report_view(playhead: f64, playing: bool) {
    report_view(playhead, playing)
}

/// The export pipeline reports on an export an agent started (`mcp-export`).
#[tauri::command]
pub fn mcp_export_update(id: String, status: String, progress: f64, error: Option<String>) {
    export_update(&id, &status, progress, error)
}

#[tauri::command]
pub async fn agents_status_cmd() -> Vec<AgentRow> {
    tauri::async_runtime::spawn_blocking(agents_status).await.unwrap_or_default()
}

#[tauri::command]
pub async fn agents_connect(app: AgentApp) -> Result<AgentRow, String> {
    tauri::async_runtime::spawn_blocking(move || connect(app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agents_disconnect(app: AgentApp) -> Result<AgentRow, String> {
    tauri::async_runtime::spawn_blocking(move || disconnect(app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn agents_cancel_waiting() {
    Agents::user().cancel_waiting()
}

#[tauri::command]
pub fn agents_reopen_claude() -> Result<(), String> {
    Agents::user().reopen_claude()
}

#[tauri::command]
pub fn agents_connect_prompt() -> String {
    Agents::connect_prompt()
}

/// The browser dev server's entries for these commands and Magic's (`lib.rs` `dispatch`).
pub fn dispatch(state: &AppState, cache_dir: &Path, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    let to = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    let arg = |k: &str| args.get(k).cloned().unwrap_or(Value::Null);
    let app = || serde_json::from_value::<AgentApp>(arg("app")).map_err(|e| e.to_string());
    Some(match cmd {
        "mcp_status" => to(serde_json::to_value(status())),
        "mcp_set_enabled" => to(serde_json::to_value(set_enabled(arg("enabled").as_bool().unwrap_or(true)))),
        "mcp_report_view" => {
            report_view(arg("playhead").as_f64().unwrap_or(0.0), arg("playing").as_bool().unwrap_or(false));
            Ok(Value::Null)
        }
        "mcp_export_update" => {
            export_update(arg("id").as_str().unwrap_or(""), arg("status").as_str().unwrap_or(""), arg("progress").as_f64().unwrap_or(0.0), arg("error").as_str().map(String::from));
            Ok(Value::Null)
        }
        "agents_status_cmd" => to(serde_json::to_value(agents_status())),
        "agents_connect" => app().and_then(connect).and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())),
        "agents_disconnect" => app().and_then(disconnect).and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())),
        "agents_cancel_waiting" => {
            Agents::user().cancel_waiting();
            Ok(Value::Null)
        }
        "agents_reopen_claude" => Agents::user().reopen_claude().map(|_| Value::Null),
        "agents_connect_prompt" => Ok(Agents::connect_prompt().into()),
        _ => {
            let host = BorrowedHost { state, cache: cache_dir.to_path_buf() };
            return crate::magic::commands::dispatch(&host, cmd, args);
        }
    })
}
