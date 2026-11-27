//! Magic's commands for the popover and the Magic button.

use super::agent::{self, ModelOption};
use super::mentions::Pointers;
use super::recipe::{ReaderStatus, reader_status};
use super::{Kind, Note, State, add_history, local, magic};
use crate::agents::{AgentApp, Agents, State as AgentState};
use crate::mcp::commands::app_host;
use crate::mcp::host::Host;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    /// claude / chatgpt / local.
    pub tab: String,
    pub prompt: String,
    #[serde(default)]
    pub pointers: Pointers,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
}

/// For each AI: whether it's on this computer, connected in AI Agents, and runnable (CLI found).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub installed: bool,
    pub connected: bool,
    pub runnable: bool,
    /// The Claude app's extension install box is open.
    pub waiting: bool,
    /// Which app connecting Claude connects: the Claude app if it's here, else Claude Code.
    pub connect_app: AgentApp,
}

pub fn availability(kind: Kind) -> Availability {
    let a = Agents::user();
    let on = crate::mcp::settings::get().agents_enabled;
    match kind {
        Kind::Claude => {
            let app = a.status(AgentApp::Claude);
            let code = a.status(AgentApp::ClaudeCode);
            let cli = a.claude_cli().is_some();
            Availability {
                installed: a.claude_app().is_some() || cli,
                connected: on && (app == AgentState::Connected || code == AgentState::Connected),
                runnable: cli,
                waiting: app == AgentState::Waiting,
                connect_app: if a.claude_app().is_some() { AgentApp::Claude } else { AgentApp::ClaudeCode },
            }
        }
        Kind::Chatgpt => {
            let s = a.status(AgentApp::Chatgpt);
            Availability { installed: s != AgentState::Missing, connected: on && s == AgentState::Connected, runnable: a.codex_cli().is_some(), waiting: false, connect_app: AgentApp::Chatgpt }
        }
    }
}

struct Report;
impl local::Progress for Report {
    fn status(&self, s: Option<&str>) {
        match s {
            Some(s) => magic().set_status(s),
            None => magic().clear_status(),
        }
    }
    fn stopped(&self) -> bool {
        !magic().snapshot().running
    }
}

fn record_history(host: &dyn Host, text: &str, tab: &str) {
    let changed = {
        let mut doc = host.state().doc.lock().unwrap();
        let ok = add_history(&mut doc.project, text, tab);
        if ok {
            doc.dirty = true;
        }
        ok
    };
    if changed {
        host.project_changed();
    }
}

/// A Local run, on this thread, with its note at the end.
fn run_local(host: &dyn Host, prompt: &str, pointers: &Pointers, run_id: u64) {
    let note = match local::run(host, prompt, pointers, &Report) {
        Ok(d) => Note { agent: None, text: d.text, changed: d.changed, detail: format!("{} · {}s", on_this_label(), magic().elapsed().as_secs_f64().round() as i64), title: None, sign_in: false },
        Err(e) => Note { title: Some("Local couldn't read that".into()), text: e, ..Default::default() },
    };
    if magic().is_current(run_id) {
        magic().finish(note);
    }
}

fn on_this_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "On this Mac"
    } else if cfg!(windows) {
        "On this PC"
    } else {
        "On this computer"
    }
}

/// Starts Magic with the app's host (runs in the background; poll `magic_state`).
pub fn start(host: Arc<dyn Host>, a: StartArgs) -> Result<State, String> {
    record_history(host.as_ref(), &a.prompt, &a.tab);
    match a.tab.as_str() {
        "local" => {
            let id = magic().begin("local", "Local is looking")?;
            std::thread::spawn(move || run_local(host.as_ref(), &a.prompt, &a.pointers, id));
        }
        "claude" | "chatgpt" => {
            let kind = if a.tab == "claude" { Kind::Claude } else { Kind::Chatgpt };
            agent::start(host, kind, a.prompt, a.pointers, a.model, a.effort)?;
        }
        other => return Err(format!("No Magic tab called {other}.")),
    }
    Ok(magic().snapshot())
}

/// Starts Magic over a borrowed document (the dev server): Local runs to the end before returning;
/// AI runs need the app.
pub fn start_borrowed(host: &dyn Host, a: StartArgs) -> Result<State, String> {
    if a.tab != "local" {
        return Err("Claude and ChatGPT Magic runs need the PromptEdit app.".into());
    }
    record_history(host, &a.prompt, &a.tab);
    let id = magic().begin("local", "Local is looking")?;
    run_local(host, &a.prompt, &a.pointers, id);
    Ok(magic().snapshot())
}

// MARK: Tauri commands

#[tauri::command]
pub fn magic_state() -> State {
    magic().snapshot()
}

#[tauri::command]
pub fn magic_start(args: Value) -> Result<State, String> {
    let a: StartArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
    let host = app_host().ok_or("PromptEdit isn't ready yet.")?;
    start(host, a)
}

#[tauri::command]
pub fn magic_stop() -> State {
    magic().stop();
    magic().snapshot()
}

#[tauri::command]
pub fn magic_dismiss_note() {
    magic().dismiss_note()
}

#[tauri::command]
pub fn magic_models(kind: Kind) -> Vec<ModelOption> {
    agent::models(kind, &Agents::user())
}

#[tauri::command]
pub async fn magic_availability() -> Value {
    tauri::async_runtime::spawn_blocking(availability_json).await.unwrap_or(Value::Null)
}

fn availability_json() -> Value {
    serde_json::json!({"claude": availability(Kind::Claude), "chatgpt": availability(Kind::Chatgpt)})
}

#[tauri::command]
pub async fn magic_local_status() -> ReaderStatus {
    tauri::async_runtime::spawn_blocking(reader_status).await.unwrap_or(ReaderStatus { model: None, note: None })
}

#[tauri::command]
pub async fn magic_sign_in(kind: Kind) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cli = agent::cli(kind).ok_or("The program isn't on this computer.")?;
        agent::sign_in(kind, &cli)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Dev server entries.
pub fn dispatch(host: &dyn Host, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    let to = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    let kind = || serde_json::from_value::<Kind>(args.get("kind").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string());
    Some(match cmd {
        "magic_state" => to(serde_json::to_value(magic().snapshot())),
        "magic_start" => serde_json::from_value::<StartArgs>(args.get("args").cloned().unwrap_or(Value::Null))
            .map_err(|e| e.to_string())
            .and_then(|a| start_borrowed(host, a))
            .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "magic_stop" => {
            magic().stop();
            to(serde_json::to_value(magic().snapshot()))
        }
        "magic_dismiss_note" => {
            magic().dismiss_note();
            Ok(Value::Null)
        }
        "magic_models" => kind().and_then(|k| serde_json::to_value(agent::models(k, &Agents::user())).map_err(|e| e.to_string())),
        "magic_availability" => Ok(availability_json()),
        "magic_local_status" => to(serde_json::to_value(reader_status())),
        "magic_sign_in" => Err("Signing in needs the PromptEdit app.".into()),
        _ => return None,
    })
}
