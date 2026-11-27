//! The HTTP side (Editroom's `MCPServer`): MCP's Streamable HTTP transport with JSON replies only
//! (never SSE, never a GET stream), on 127.0.0.1 only, one request per connection.
//!
//! Security, in order: the `Host` header must name this computer (a DNS-rebinding guard), an
//! `Origin` must be local (so web pages can't reach in), and with "Let AI apps edit" off only a
//! Magic run's own draft address is served.

use super::host::Host;
use super::{Client, display_name, mcp, protocol, settings, tools};
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use axum::response::Response;
use axum::Router;
use serde_json::Value;
use std::sync::Arc;
use std::time::SystemTime;

/// A listening server; dropping the sender stops it.
pub struct Running {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }
}

/// Starts listening on `port`, or on any free port when another copy has it. Returns the port.
/// Must be called within a Tokio runtime.
pub async fn start(host: Arc<dyn Host>, port: u16) -> Result<u16, String> {
    let m = mcp();
    if let Some(p) = *m.listening.lock().unwrap() {
        return Ok(p);
    }
    let (listener, problem) = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => (l, None),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Someone else (another copy of PromptEdit) has the usual port.
            let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
            (l, Some(format!("Another copy of {} is answering AI apps; this one only runs its own Magic.", super::APP_NAME)))
        }
        Err(e) => {
            let msg = format!("Couldn't listen on port {port}: {e}");
            *m.problem.lock().unwrap() = Some(msg.clone());
            return Err(msg);
        }
    };
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    *m.problem.lock().unwrap() = problem;
    *m.listening.lock().unwrap() = Some(bound);
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    *m.running.lock().unwrap() = Some(Running { stop: Some(tx) });
    let app = Router::new().fallback(handle).with_state(host);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        let m = mcp();
        let mut l = m.listening.lock().unwrap();
        if *l == Some(bound) {
            *l = None;
        }
    });
    Ok(bound)
}

pub fn stop() {
    let m = mcp();
    m.running.lock().unwrap().take();
    *m.listening.lock().unwrap() = None;
}

pub fn is_running() -> bool {
    mcp().listening.lock().unwrap().is_some()
}

fn reply(status: StatusCode, body: Option<Value>, session: Option<&str>) -> Response {
    let mut r = Response::builder().status(status).header(header::CONNECTION, "close");
    if let Some(s) = session
        && let Ok(v) = HeaderValue::from_str(s)
    {
        r = r.header("Mcp-Session-Id", v);
    }
    match body {
        Some(b) => r.header(header::CONTENT_TYPE, "application/json").body(Body::from(serde_json::to_vec(&b).unwrap_or_default())),
        None => r.body(Body::empty()),
    }
    .unwrap()
}

/// The hostname in a `Host` header, port stripped (`[::1]:47921` → `[::1]`).
fn host_name(h: &str) -> &str {
    if h.starts_with('[') {
        return h.find(']').map(|i| &h[..=i]).unwrap_or(h);
    }
    h.split(':').next().unwrap_or("")
}

fn local_origin(origin: &str) -> bool {
    reqwest::Url::parse(origin).ok().and_then(|u| u.host_str().map(|h| h == "127.0.0.1" || h == "localhost")).unwrap_or(false)
}

fn query_item(uri: &axum::http::Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| v.to_string())
    })
}

fn header<'a>(h: &'a HeaderMap, k: &str) -> Option<&'a str> {
    h.get(k).and_then(|v| v.to_str().ok())
}

async fn handle(State(host): State<Arc<dyn Host>>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let h = &parts.headers;
    // Only local callers by name, and no web pages: a page in a browser can't reach in.
    if !["127.0.0.1", "localhost", "[::1]"].contains(&host_name(header(h, "host").unwrap_or(""))) {
        return reply(StatusCode::FORBIDDEN, None, None);
    }
    if let Some(o) = header(h, "origin").filter(|o| !o.is_empty())
        && !local_origin(o)
    {
        return reply(StatusCode::FORBIDDEN, None, None);
    }
    if !parts.uri.path().starts_with("/mcp") {
        return reply(StatusCode::NOT_FOUND, None, None);
    }
    let m = mcp();
    // A Magic run's agent works on a hidden draft, named in its address.
    let draft_token = query_item(&parts.uri, "draft");
    // With AI apps off, the connection is only open for this copy's own Magic runs.
    let draft_open = draft_token.as_deref().is_some_and(|t| m.drafts.is_open(t));
    if !settings::get().agents_enabled && !draft_open {
        return reply(StatusCode::FORBIDDEN, None, None);
    }
    match parts.method {
        Method::POST => {}
        Method::DELETE => {
            if let Some(s) = header(h, "mcp-session-id") {
                m.clients.lock().unwrap().remove(s);
            }
            return reply(StatusCode::OK, None, None);
        }
        _ => {
            let mut r = reply(StatusCode::METHOD_NOT_ALLOWED, None, None);
            r.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST, DELETE"));
            return r;
        }
    }
    let Ok(bytes) = to_bytes(body, 32 << 20).await else { return reply(StatusCode::PAYLOAD_TOO_LARGE, None, None) };
    let json: Value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) if v.is_object() => v,
        _ => return reply(StatusCode::BAD_REQUEST, Some(protocol::error(None, -32700, "Parse error")), None),
    };
    let id = json.get("id").filter(|v| !v.is_null()).cloned();
    // The Claude app, disconnected in PromptEdit's Settings: say so instead of working.
    let from = header(h, "x-promptedit-from").or_else(|| header(h, "x-editroom-from"));
    if from == Some("claude-app") && settings::get().claude_app_disconnected {
        if id.is_none() {
            return reply(StatusCode::ACCEPTED, None, None);
        }
        let msg = format!(
            "{app} is disconnected from Claude. To use it again, connect Claude in {app} > Settings > Magic.",
            app = super::APP_NAME
        );
        return reply(StatusCode::OK, Some(protocol::error(id.as_ref(), -32001, &msg)), None);
    }
    let method = json.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let mut session = header(h, "mcp-session-id").map(String::from);
    if method == "initialize" {
        let s = promptedit_core::Id::new().to_string();
        let name = json.pointer("/params/clientInfo/name").and_then(Value::as_str).unwrap_or("Agent");
        // Magic's own agent isn't listed as a connected app.
        if draft_token.is_none() {
            m.clients.lock().unwrap().insert(s.clone(), Client { id: s.clone(), name: display_name(name), last_seen: SystemTime::now() });
        }
        session = Some(s);
    } else if draft_token.is_none()
        && let Some(s) = &session
    {
        let mut clients = m.clients.lock().unwrap();
        let c = clients.entry(s.clone()).or_insert_with(|| Client { id: s.clone(), name: "Agent".into(), last_seen: SystemTime::now() });
        c.last_seen = SystemTime::now();
    }
    // Notifications get no reply.
    if id.is_none() {
        return reply(StatusCode::ACCEPTED, None, None);
    }
    let client = session.as_ref().and_then(|s| m.clients.lock().unwrap().get(s).map(|c| c.name.clone()));
    let answer = respond(host, json, client, draft_token).await;
    reply(StatusCode::OK, Some(answer), session.as_deref())
}

/// Answers one JSON-RPC request.
pub async fn respond(host: Arc<dyn Host>, req: Value, client: Option<String>, draft_token: Option<String>) -> Value {
    if let Some(r) = protocol::handshake(&req) {
        return r;
    }
    let id = req.get("id").cloned();
    match req.get("method").and_then(Value::as_str).unwrap_or("") {
        "tools/call" => {
            let name = req.pointer("/params/name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = req.pointer("/params/arguments").cloned().filter(Value::is_object).unwrap_or_else(|| serde_json::json!({}));
            if std::env::var("PROMPTEDIT_MAGIC_LOG").is_ok() || std::env::args().any(|a| a == "--magic-ai") {
                eprintln!("MCP CALL {name} {} from {}", if draft_token.is_some() { "draft" } else { "live" }, client.as_deref().unwrap_or("?"));
            }
            let draft = match &draft_token {
                Some(t) => match mcp().drafts.find(t) {
                    Some(d) => Some(d),
                    None => return protocol::ok(id.as_ref(), protocol::failure("This Magic edit was stopped or has finished. Stop now.")),
                },
                None => None,
            };
            let result = tokio::task::spawn_blocking(move || tools::call(host.as_ref(), &name, &args, client, draft))
                .await
                .unwrap_or_else(|e| protocol::failure(&format!("The tool stopped: {e}")));
            protocol::ok(id.as_ref(), result)
        }
        _ => protocol::error(id.as_ref(), -32601, "Method not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names() {
        assert_eq!(host_name("127.0.0.1:47921"), "127.0.0.1");
        assert_eq!(host_name("[::1]:47921"), "[::1]");
        assert_eq!(host_name("localhost"), "localhost");
        assert!(local_origin("http://localhost:3000"));
        assert!(!local_origin("https://evil.example"));
    }
}
