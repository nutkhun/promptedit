//! `PromptEdit --mcp`: for agents that start their tools as a program and talk over stdin and
//! stdout (the Claude desktop app, Codex). Each line in is passed to the running app's MCP server
//! and its reply written back (Editroom's `MCPBridge`). While PromptEdit is closed, everything but
//! using a tool is answered here, so an agent starting up or idling doesn't open PromptEdit; the
//! first tool it uses opens it, in the background. Nothing else is ever written to stdout.
//!
//! Windows: the bridge is the GUI-subsystem `PromptEdit.exe` re-entered with `--mcp`. It uses the
//! stdio pipes the agent passes it (Claude and Codex spawn it with pipes), which a GUI-subsystem
//! process can use. UNVERIFIED on a real Windows Claude/Codex install; the spec's alternative is a
//! separate console sidecar (`promptedit-mcp.exe`).

use super::protocol;
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// One HTTP exchange with the app: the reply body and status (0 when nothing is listening).
pub struct Exchange {
    pub status: u16,
    pub body: Vec<u8>,
    pub session: Option<String>,
}

/// POSTs one JSON-RPC message to the app's `/mcp` (hand-rolled HTTP/1.1: one request per
/// connection, as the server closes after each reply).
pub fn post(port: u16, line: &[u8], session: Option<&str>, from: Option<&str>) -> Exchange {
    let none = Exchange { status: 0, body: vec![], session: None };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { return none };
    let _ = s.set_read_timeout(Some(Duration::from_secs(600)));
    let mut head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
        line.len()
    );
    if let Some(sid) = session {
        head += &format!("Mcp-Session-Id: {sid}\r\n");
    }
    if let Some(f) = from {
        head += &format!("X-PromptEdit-From: {f}\r\n");
    }
    head += "\r\n";
    if s.write_all(head.as_bytes()).and_then(|_| s.write_all(line)).is_err() {
        return none;
    }
    let mut raw = vec![];
    if s.read_to_end(&mut raw).is_err() && raw.is_empty() {
        return none;
    }
    parse_response(&raw).unwrap_or(none)
}

fn parse_response(raw: &[u8]) -> Option<Exchange> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let mut session = None;
    let mut length = None;
    let mut chunked = false;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        match k.as_str() {
            "mcp-session-id" => session = Some(v.to_string()),
            "content-length" => length = v.parse::<usize>().ok(),
            "transfer-encoding" => chunked = v.eq_ignore_ascii_case("chunked"),
            _ => {}
        }
    }
    let rest = &raw[end + 4..];
    let body = if chunked {
        let mut out = vec![];
        let mut at = 0;
        while let Some(nl) = rest[at..].windows(2).position(|w| w == b"\r\n") {
            let size = usize::from_str_radix(std::str::from_utf8(&rest[at..at + nl]).ok()?.trim(), 16).ok()?;
            at += nl + 2;
            if size == 0 {
                break;
            }
            out.extend_from_slice(rest.get(at..at + size)?);
            at += size + 2;
        }
        out
    } else {
        rest[..length.unwrap_or(rest.len()).min(rest.len())].to_vec()
    };
    Some(Exchange { status, body, session })
}

/// Opens the app in the background (once per bridge).
pub fn launch_app() {
    let Ok(exe) = std::env::current_exe() else { return };
    #[cfg(target_os = "macos")]
    {
        // The .app this program lives in, opened without taking focus (`open -g`).
        let s = exe.to_string_lossy().into_owned();
        if let Some(i) = s.find(".app/Contents/MacOS/") {
            let bundle = &s[..i + 4];
            let _ = std::process::Command::new("/usr/bin/open").args(["-g", "-a", bundle]).status();
            return;
        }
    }
    let mut c = std::process::Command::new(exe);
    c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // Detached from the agent's console, in its own group, so closing the agent doesn't close
        // PromptEdit. Windows' foreground rules keep a background launch from stealing focus.
        // UNVERIFIED on Windows: SW_SHOWNOACTIVATE needs STARTUPINFO, which std doesn't expose.
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        c.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let _ = c.spawn();
}

fn write_line(out: &mut impl Write, body: &[u8]) {
    // Replies are one line: JSON never needs a raw newline, so they become spaces.
    let text = String::from_utf8_lossy(body).replace('\n', " ");
    let _ = out.write_all(text.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// Settings for one bridge.
pub struct Options {
    pub port: u16,
    pub from: Option<String>,
    /// Attempts and the wait between them while the app starts (Editroom: 80 × 250 ms).
    pub attempts: u32,
    pub wait: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Options { port: super::default_port(), from: None, attempts: 80, wait: Duration::from_millis(250) }
    }
}

/// Passes newline-delimited JSON-RPC from `input` to the app and its replies to `output`, until
/// `input` closes. `launch` opens the app when a tool is used while it's closed.
pub fn serve(input: impl BufRead, mut output: impl Write, opts: &Options, mut launch: impl FnMut()) {
    let mut session: Option<String> = None;
    let mut held_hello: Option<Vec<u8>> = None;
    let mut launched = false;
    let from = opts.from.as_deref();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let data = line.into_bytes();
        let json: Option<Value> = serde_json::from_slice(&data).ok();
        let id = json.as_ref().and_then(|j| j.get("id")).filter(|v| !v.is_null()).cloned();
        let method = json.as_ref().and_then(|j| j.get("method")).and_then(Value::as_str).unwrap_or("").to_string();
        let exchange = |data: &[u8], session: &mut Option<String>| {
            let x = post(opts.port, data, session.as_deref(), from);
            if let Some(s) = &x.session {
                *session = Some(s.clone());
            }
            x
        };
        // Anything but using a tool: the app's own answer if it's open; with it closed, answered
        // here, and the app isn't opened.
        if let Some(j) = json.as_ref().filter(|_| !protocol::opens_app(&method)) {
            let x = exchange(&data, &mut session);
            let reply: Option<Vec<u8>> = match x.status {
                200 => Some(x.body),
                202 => None,
                0 => {
                    if method == "initialize" {
                        held_hello = Some(data.clone());
                    }
                    // A reply to something asked of the agent (no method) or a notification needs no answer.
                    (!method.is_empty() && id.is_some()).then(|| {
                        let answer = protocol::handshake(j)
                            .unwrap_or_else(|| protocol::error(id.as_ref(), -32601, &format!("Method not found: {method}")));
                        serde_json::to_vec(&answer).unwrap_or_default()
                    })
                }
                s => Some(refused_or(x.body, s, id.as_ref())),
            };
            if let (Some(r), true) = (reply, id.is_some()) {
                write_line(&mut output, &r);
            }
            continue;
        }
        // Up to about 20 seconds for the app to start and begin listening.
        let mut reply: Option<Vec<u8>> = None;
        let mut answered = false;
        for _ in 0..opts.attempts {
            // PromptEdit opened for this: it hears the agent's hello first.
            if let Some(hello) = held_hello.clone() {
                let x = exchange(&hello, &mut session);
                if x.status == 0 {
                    if !launched {
                        launched = true;
                        launch();
                    }
                    std::thread::sleep(opts.wait);
                    continue;
                }
                held_hello = None;
            }
            let x = exchange(&data, &mut session);
            match x.status {
                200 | 202 => {
                    reply = (x.status == 200).then_some(x.body);
                    answered = true;
                    launched = false;
                    break;
                }
                0 => {
                    if !launched {
                        launched = true;
                        launch();
                    }
                    std::thread::sleep(opts.wait);
                }
                s => {
                    // The server answered with an error: report it rather than retrying.
                    reply = Some(refused_or(x.body, s, id.as_ref()));
                    answered = true;
                    break;
                }
            }
        }
        if !answered && id.is_some() {
            let msg = format!(
                "{app} isn't answering. Open {app} and turn on AI Agents ({app} > Settings > Magic > Let AI apps edit in {app}).",
                app = super::APP_NAME
            );
            reply = Some(serde_json::to_vec(&protocol::error(id.as_ref(), -32000, &msg)).unwrap_or_default());
        }
        if let (Some(r), true) = (reply, id.is_some()) {
            write_line(&mut output, &r);
        }
    }
}

/// A non-2xx reply's body, or a proper JSON-RPC error when it has none (Editroom writes an empty
/// line here, which agents can't parse; fixed deliberately).
fn refused_or(body: Vec<u8>, status: u16, id: Option<&Value>) -> Vec<u8> {
    if !body.iter().all(u8::is_ascii_whitespace) {
        return body;
    }
    let app = super::APP_NAME;
    let msg = if status == 403 {
        format!("{app} isn't letting AI apps in. Turn on \"Let AI apps edit in {app}\" in {app} > Settings > Magic.")
    } else {
        format!("{app} couldn't answer (HTTP {status}).")
    };
    serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": id.cloned().unwrap_or(Value::Null), "error": {"code": -32000, "message": msg}})).unwrap_or_default()
}

/// The `--mcp` entry: never shows UI, returns when stdin closes.
pub fn run() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    // Which app started this (from its launcher), so PromptEdit can turn away a disconnected one.
    let from = args.iter().position(|a| a == "--from").and_then(|i| args.get(i + 1)).cloned();
    let opts = Options { from, ..Options::default() };
    let stdin = std::io::stdin();
    serve(stdin.lock(), std::io::stdout(), &opts, launch_app);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_handshake_with_the_app_closed() {
        // Nothing listens on this port.
        let opts = Options { port: 47939, from: None, attempts: 2, wait: Duration::from_millis(10) };
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"claude-ai"}}}"#,
            "\n\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_project","arguments":{}}}"#,
            "\n",
        );
        let mut out = vec![];
        let mut launches = 0;
        serve(input.as_bytes(), &mut out, &opts, || launches += 1);
        let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 3, "a reply for each request, none for the notification");
        assert_eq!(lines[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(lines[0]["result"]["serverInfo"]["name"], "promptedit");
        assert_eq!(lines[1]["result"]["tools"].as_array().unwrap().len(), 43);
        assert_eq!(lines[2]["error"]["code"], -32000);
        assert_eq!(launches, 1, "using a tool opens the app once");
    }
}
