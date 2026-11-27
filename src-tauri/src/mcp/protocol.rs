//! JSON-RPC methods: the MCP handshake, listing tools and calling them (Editroom's `MCPHandler`).

use super::{APP_NAME, SERVER_NAME, defs};
use serde_json::{Value, json};

/// Protocol versions spoken, newest first. An unknown one asked for gets the newest.
pub const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Sent with `initialize`: Editroom's instructions, naming PromptEdit.
pub const INSTRUCTIONS: &str = "PromptEdit is a video editor. Times are in seconds. Video tracks are V1, V2, … (V1 is the bottom; higher tracks cover lower ones) and audio tracks are A1, A2, …. A video with sound is placed as a linked pair: moving, trimming or deleting either moves both. Placing, moving or trimming a clip, title or solid over another on the same track overwrites what's underneath, as on the timeline. Start with get_project and list_media; analyze_media finds a clip's best moments or a song's beats; look_at_media shows you a clip or photo, and get_frame shows you the cut; search_media finds shots by what they show or what's said. After looking at a clip, save what you saw with note_media; list_media gives those notes back next time, so trust a clip's notes and look again only for an exact frame. Each edit is shown to the person with your own cursor and can be undone with history. auto_edit builds a whole cut on its own, and export delivers it to a file (vertical, square or portrait too, at a loudness target).";

pub fn error(id: Option<&Value>, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id.cloned().unwrap_or(Value::Null), "error": {"code": code, "message": message}})
}

pub fn ok(id: Option<&Value>, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id.cloned().unwrap_or(Value::Null), "result": result})
}

/// A tool's failure, which is a result (not a JSON-RPC error), so the agent reads it.
pub fn failure(message: &str) -> Value {
    json!({"content": [{"type": "text", "text": message}], "isError": true})
}

/// The handshake, ping and the lists: needing nothing from the editor, so the bridge answers them
/// the same way while PromptEdit is closed (and doesn't open it just for an agent saying hello).
pub fn handshake(req: &Value) -> Option<Value> {
    let id = req.get("id");
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "initialize" => {
            let asked = req.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or(VERSIONS[0]);
            let version = if VERSIONS.contains(&asked) { asked } else { VERSIONS[0] };
            Some(ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": SERVER_NAME, "title": APP_NAME, "version": "1.0"},
                    "instructions": INSTRUCTIONS,
                }),
            ))
        }
        "ping" => Some(ok(id, json!({}))),
        "tools/list" => Some(ok(id, json!({"tools": defs::definitions()}))),
        // Asked by some agents as they start (Codex): PromptEdit has neither, and saying so mustn't open it.
        "resources/list" => Some(ok(id, json!({"resources": []}))),
        "resources/templates/list" => Some(ok(id, json!({"resourceTemplates": []}))),
        "prompts/list" => Some(ok(id, json!({"prompts": []}))),
        _ => None,
    }
}

/// Whether a request needs the app itself, and opens it when it's closed: only using a tool does.
pub fn opens_app(method: &str) -> bool {
    method == "tools/call"
}
