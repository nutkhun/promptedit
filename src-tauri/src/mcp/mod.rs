//! Lets AI agents (Claude, ChatGPT's Codex, Claude Code) edit in PromptEdit using the Model
//! Context Protocol (docs/spec/03-mcp-magic.md §1).
//!
//! A small HTTP server on this computer only (127.0.0.1), speaking MCP's Streamable HTTP transport
//! with plain JSON replies, wire-compatible with Editroom's. Claude Code connects to it directly;
//! the Claude desktop app and Codex start `PromptEdit --mcp`, which passes their messages through
//! (see `bridge`). Magic's own AI runs use the same server on a private draft (`?draft=<token>`).
//!
//! PromptEdit uses its own identity (server name "promptedit", port 47921) so it can run beside
//! Editroom on the same Mac without the two answering each other's agents.

pub mod bridge;
pub mod commands;
pub mod defs;
pub mod download;
pub mod draft;
pub mod frames;
pub mod host;
pub mod json;
pub mod notes;
pub mod presence;
pub mod protocol;
pub mod providers;
pub mod server;
pub mod settings;
pub mod tools;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// The usual port. Editroom uses 47920; PromptEdit has its own so both can be open.
pub const PORT: u16 = 47921;
/// The name agents know this server by (`mcp__promptedit__…` in Claude Code).
pub const SERVER_NAME: &str = "promptedit";
/// The product name in messages.
pub const APP_NAME: &str = "PromptEdit";

/// The port agents should reach: `PROMPTEDIT_MCP_PORT` (tests) or the usual one.
pub fn default_port() -> u16 {
    std::env::var("PROMPTEDIT_MCP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(PORT)
}

pub fn endpoint() -> String {
    format!("http://127.0.0.1:{}/mcp", default_port())
}

/// An agent that has talked to the server.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Client {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub last_seen: SystemTime,
}

/// Everything the MCP server keeps between requests. One per process.
#[derive(Default)]
pub struct Mcp {
    pub clients: Mutex<HashMap<String, Client>>,
    /// The port this copy is listening on (the usual one, or any free one when another copy has it).
    pub listening: Mutex<Option<u16>>,
    pub problem: Mutex<Option<String>>,
    pub(crate) running: Mutex<Option<server::Running>>,
    pub drafts: draft::Drafts,
    /// The playhead and transport as the UI last reported them (the UI owns playback).
    pub view: Mutex<View>,
    pub exports: providers::Exports,
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct View {
    pub playhead: f64,
    pub playing: bool,
}

static MCP: OnceLock<Mcp> = OnceLock::new();

pub fn mcp() -> &'static Mcp {
    MCP.get_or_init(Mcp::default)
}

impl Mcp {
    /// Where this copy's own Magic runs reach it.
    pub fn local_endpoint(&self) -> Option<String> {
        self.listening.lock().unwrap().map(|p| format!("http://127.0.0.1:{p}/mcp"))
    }

    /// Agents seen in the last 60 s (Settings › Magic "Working now:").
    pub fn recent_clients(&self) -> Vec<Client> {
        let now = SystemTime::now();
        let mut out: Vec<Client> = self
            .clients
            .lock()
            .unwrap()
            .values()
            .filter(|c| now.duration_since(c.last_seen).map(|d| d.as_secs() < 60).unwrap_or(true))
            .cloned()
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out.dedup_by(|a, b| a.name == b.name);
        out
    }
}

/// What to call an agent on its cursor (Editroom's `MCPServer.displayName`).
pub fn display_name(raw: &str) -> String {
    let s = raw.to_lowercase();
    if s.contains("claude") {
        return "Claude".into();
    }
    if s.contains("codex") {
        return "Codex".into();
    }
    if s.contains("chatgpt") || s.contains("openai") {
        return "ChatGPT".into();
    }
    let words = raw.replace(['-', '_'], " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// "on this Mac" on macOS (Editroom's words), "on this PC" on Windows.
pub fn on_this() -> &'static str {
    if cfg!(target_os = "macos") {
        "on this Mac"
    } else if cfg!(windows) {
        "on this PC"
    } else {
        "on this computer"
    }
}

/// PromptEdit's folder for settings, notes and agent files: `~/Library/Application Support/PromptEdit`
/// on macOS, `%APPDATA%\PromptEdit` on Windows. `PROMPTEDIT_DATA_DIR` overrides it (tests).
pub fn data_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("PROMPTEDIT_DATA_DIR") {
        return d.into();
    }
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join(APP_NAME)
}

/// Caches that can be rebuilt (analysis): `%LOCALAPPDATA%\PromptEdit` on Windows, as the spec's
/// Windows table suggests; the data folder elsewhere.
pub fn cache_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("PROMPTEDIT_DATA_DIR") {
        return std::path::PathBuf::from(d).join("Caches");
    }
    if cfg!(windows) { dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join(APP_NAME) } else { data_dir() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_agents_like_editroom() {
        assert_eq!(display_name("claude-ai"), "Claude");
        assert_eq!(display_name("codex-mcp-client"), "Codex");
        assert_eq!(display_name("OpenAI Agents"), "ChatGPT");
        assert_eq!(display_name("my-agent_x"), "My agent x");
    }
}
