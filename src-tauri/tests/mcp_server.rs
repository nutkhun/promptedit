//! The MCP server end to end, headless: started on port 47931 against a project with a generated
//! clip, then driven over HTTP the way Claude Code drives it (initialize → tools/list → tools/call),
//! checking Editroom's JSON shapes, undo grouping, the security checks, Magic drafts and the stdio
//! bridge.

use promptedit_lib::mcp::bridge::{self, Options};
use promptedit_lib::mcp::host::{HeadlessHost, Host};
use promptedit_lib::mcp::{self, protocol, server};
use serde_json::{Value, json};
use std::net::TcpStream;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const PORT: u16 = 47931;

fn scratch() -> PathBuf {
    let d = std::env::temp_dir().join(format!("promptedit-mcp-test-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A 10-second 1280×720 test clip with a tone.
fn make_clip(dir: &std::path::Path) -> PathBuf {
    let out = dir.join("clip.mp4");
    if !out.exists() {
        let ok = std::process::Command::new(promptedit_lib::media::tool("ffmpeg"))
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=10"])
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(&out)
            .status()
            .expect("ffmpeg runs")
            .success();
        assert!(ok, "made the test clip");
    }
    out
}

/// One POST to the server, with the headers given; (status, session, body).
fn raw(headers: &[(&str, &str)], method: &str, path: &str, body: &str) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", PORT)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n", body.len());
    for (k, v) in headers {
        head += &format!("{k}: {v}\r\n");
    }
    head += "\r\n";
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body.as_bytes()).unwrap();
    let mut out = vec![];
    s.read_to_end(&mut out).unwrap();
    let text = String::from_utf8_lossy(&out).into_owned();
    let (h, b) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = h.split(' ').nth(1).unwrap().parse().unwrap();
    let session = h.lines().find_map(|l| l.to_lowercase().starts_with("mcp-session-id:").then(|| l[15..].trim().to_string()));
    (status, session, b.to_string())
}

struct Agent {
    session: Option<String>,
    path: String,
    next: u64,
}

impl Agent {
    fn new(path: &str) -> Self {
        Agent { session: None, path: path.into(), next: 1 }
    }
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
        let host = format!("127.0.0.1:{PORT}");
        let mut headers = vec![("Host", host.as_str())];
        let sid = self.session.clone();
        if let Some(s) = &sid {
            headers.push(("Mcp-Session-Id", s));
        }
        let (status, session, body) = raw(&headers, "POST", &self.path, &body);
        assert_eq!(status, 200, "{method}: {body}");
        if session.is_some() {
            self.session = session;
        }
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["id"], id);
        v
    }
    /// A tool call's content, failing the test on a tool error.
    fn call(&mut self, name: &str, args: Value) -> Vec<Value> {
        let v = self.rpc("tools/call", json!({"name": name, "arguments": args}));
        assert_eq!(v["result"]["isError"], false, "{name}: {}", v["result"]);
        v["result"]["content"].as_array().unwrap().clone()
    }
    /// A tool call's JSON text.
    fn json(&mut self, name: &str, args: Value) -> Value {
        let c = self.call(name, args);
        assert_eq!(c[0]["type"], "text");
        let text = c[0]["text"].as_str().unwrap();
        assert!(text.contains(" : ") || !text.contains(':') || text.starts_with('['), "pretty-printed like Editroom: {text}");
        serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.into()))
    }
    fn error(&mut self, name: &str, args: Value) -> String {
        let v = self.rpc("tools/call", json!({"name": name, "arguments": args}));
        assert_eq!(v["result"]["isError"], true, "{name} should fail");
        v["result"]["content"][0]["text"].as_str().unwrap().to_string()
    }
}

#[test]
fn mcp_server_end_to_end() {
    let dir = scratch();
    // SAFETY: set before any thread reads it.
    unsafe { std::env::set_var("PROMPTEDIT_DATA_DIR", dir.join("data")) };
    let clip = make_clip(&dir);
    let host = Arc::new(HeadlessHost { cache: dir.join("cache"), ..Default::default() });
    let imported = host.import(vec![clip.to_string_lossy().into_owned()]);
    assert_eq!(imported.added.len(), 1);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let port = rt.block_on(server::start(host.clone() as Arc<dyn Host>, PORT)).unwrap();
    assert_eq!(port, PORT);

    // The handshake.
    let mut a = Agent::new("/mcp");
    let hello = a.rpc("initialize", json!({"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2"}}));
    assert_eq!(hello["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(hello["result"]["serverInfo"], json!({"name": "promptedit", "title": "PromptEdit", "version": "1.0"}));
    assert_eq!(hello["result"]["capabilities"], json!({"tools": {"listChanged": false}}));
    assert!(hello["result"]["instructions"].as_str().unwrap().starts_with("PromptEdit is a video editor."));
    let sid = a.session.clone().expect("a session id");
    assert_eq!(sid.len(), 36);
    assert_eq!(sid, sid.to_uppercase(), "uppercase like Swift's UUID");
    assert_eq!(mcp::mcp().recent_clients().first().map(|c| c.name.clone()), Some("Claude".into()));
    let old = Agent::new("/mcp").rpc("initialize", json!({"protocolVersion": "1999-01-01"}));
    assert_eq!(old["result"]["protocolVersion"], "2025-06-18", "unknown versions get the newest");
    assert_eq!(a.rpc("ping", json!({}))["result"], json!({}));
    assert_eq!(a.rpc("prompts/list", json!({}))["result"], json!({"prompts": []}));
    assert_eq!(a.rpc("nope", json!({}))["error"]["code"], -32601);

    let tools = a.rpc("tools/list", json!({}));
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 43);
    let add = tools.iter().find(|t| t["name"] == "add_clip").unwrap();
    assert_eq!(add["inputSchema"]["required"], json!(["asset_id"]));
    assert_eq!(add["annotations"], json!({"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}));
    assert!(tools.iter().all(|t| t["inputSchema"]["required"].is_array() && t["title"].is_string()));

    // Reading.
    let media = a.json("list_media", json!({}));
    let asset = &media[0];
    assert_eq!(asset["kind"], "video");
    assert_eq!((asset["width"].clone(), asset["height"].clone(), asset["has_audio"].clone()), (json!(1280), json!(720), json!(true)));
    let asset_id = asset["id"].as_str().unwrap().to_string();
    assert_eq!(a.json("list_looks", json!({}))[0], "Warm film");

    // add_clip: picture and linked sound, one undo step, the UI told.
    let events_before = host.events.lock().unwrap().len();
    let added = a.json("add_clip", json!({"asset_id": asset_id, "start": 0}));
    let added = added["added"].as_array().unwrap().clone();
    assert_eq!(added.len(), 2);
    assert_eq!((added[0]["track"].clone(), added[1]["track"].clone()), (json!("V1"), json!("A1")));
    assert_eq!((added[0]["start"].clone(), added[0]["end"].clone()), (json!(0), json!(10)));
    let video = added[0]["id"].as_str().unwrap().to_string();
    {
        let ev = host.events.lock().unwrap();
        let names: Vec<&str> = ev[events_before..].iter().map(|e| e.0.as_str()).collect();
        assert_eq!(names, vec!["project-changed", "agent-presence"]);
        let presence = &ev.last().unwrap().1;
        assert_eq!((presence["name"].clone(), presence["color"].clone(), presence["label"].clone()), (json!("Claude"), json!("#D97857"), json!("Place")));
        assert_eq!(ev[events_before].1["project"]["clips"].as_array().unwrap().len(), 2, "the event carries the snapshot");
    }
    assert!(host.state.doc.lock().unwrap().can_undo());

    // get_project's shape.
    let p = a.json("get_project", json!({}));
    assert_eq!(p["name"], "Untitled");
    assert_eq!(p["sequence"], json!({"width": 1920, "height": 1080, "fps": 30, "duration": 10}));
    assert_eq!(p["tracks"][0]["name"], "V2", "video tracks top first");
    assert_eq!(p["clips"][0]["track"], "A1", "clips sorted by track name");
    assert_eq!(p["clips"][0]["linked_to"], json!(video));
    assert_eq!(p["clips"][0]["gain_db"], 0);
    assert_eq!(p["in_out"], Value::Null);

    // split_clip: both linked clips, new right-hand pieces.
    let split = a.json("split_clip", json!({"clip_id": video, "at": 4}));
    assert_eq!(split["left"].as_array().unwrap().len(), 2);
    let right = split["right"].as_array().unwrap();
    assert_eq!(right.len(), 2);
    assert_eq!((right[0]["start"].clone(), right[0]["source_start"].clone()), (json!(4), json!(4)));
    let right_video = right.iter().find(|c| c["kind"] == "video").unwrap()["id"].as_str().unwrap().to_string();
    assert!(a.error("split_clip", json!({"clip_id": video, "at": 9})).contains("isn't inside the clip"));

    // set_speed: twice as fast, half as long, its sound too.
    let sped = a.json("set_speed", json!({"clip_id": right_video, "speed": 2}));
    let sped = sped.as_array().unwrap();
    assert_eq!(sped.len(), 2);
    assert!(sped.iter().all(|c| c["speed"] == 2 && c["duration"] == 3), "{sped:?}");

    // history: one step back is just the speed change.
    assert_eq!(a.call("history", json!({"action": "undo"}))[0]["text"], "Done. 4 clips on the timeline.");
    let p = a.json("get_project", json!({}));
    assert!(p["clips"].as_array().unwrap().iter().all(|c| c.get("speed").is_none()));
    assert_eq!(p["sequence"]["duration"], 10);
    a.call("history", json!({"action": "redo"}));
    assert_eq!(a.json("get_project", json!({}))["sequence"]["duration"], 7);

    // More tools and their shapes.
    let graded = a.json("set_grade", json!({"clip_ids": [video], "look": "Mono", "exposure": 1}));
    assert_eq!(graded[0]["grade"], json!({"look": "Mono", "exposure": 1}));
    let marker = a.json("set_marker", json!({"time": 2.5, "name": "Beat"}));
    assert_eq!((marker["time"].clone(), marker["color"].clone()), (json!(2.5), json!("yellow")));
    let title = a.json("add_title", json!({"text": "Hello", "start": 1}));
    assert_eq!(title["added"]["track"], "V2");
    let range = a.json("set_in_out", json!({"in": 1, "out": 3}));
    assert_eq!(range, json!({"in": 1, "out": 3}));
    assert!(a.error("add_clip", json!({"asset_id": "nope"})).contains("No library item with id nope"));
    assert!(a.error("add_clip", json!({"asset_id": asset_id, "track": "V9"})).contains("There's no V9; there are 2."));

    // Pictures: a contact sheet of the file, and a frame of the cut.
    let look = a.call("look_at_media", json!({"asset_id": asset_id, "frames": 4}));
    assert_eq!((look[0]["type"].clone(), look[0]["mimeType"].clone()), (json!("image"), json!("image/jpeg")));
    assert!(look[1]["text"].as_str().unwrap().contains("Frames at 1.2s, 3.8s, 6.2s, 8.8s"), "{}", look[1]["text"]);
    let frame = a.call("get_frame", json!({"time": 5}));
    assert_eq!(frame[0]["mimeType"], "image/png");
    assert!(frame[1]["text"].as_str().unwrap().starts_with("Frame at 5s."));
    let analysis = a.json("analyze_media", json!({"asset_id": asset_id}));
    assert_eq!(analysis["duration"], 10);
    let moments = analysis["best_moments"].as_array().unwrap();
    assert!((3..=5).contains(&moments.len()), "up to five, not overlapping: {moments:?}");
    assert!(moments[0]["score"].as_f64().unwrap() >= moments[1]["score"].as_f64().unwrap(), "best first");

    // Each live call was one undo step: undo the in/out, title, marker, grade and speed, and the
    // split and add, and the timeline is empty again.
    let mut steps = 0;
    while host.state.doc.lock().unwrap().can_undo() {
        a.call("history", json!({"action": "undo"}));
        steps += 1;
    }
    assert_eq!(steps, 7);
    assert!(host.state.doc.lock().unwrap().project.clips.is_empty());

    // Security and transport.
    let host_hdr = format!("127.0.0.1:{PORT}");
    let init = json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}).to_string();
    assert_eq!(raw(&[("Host", "evil.example")], "POST", "/mcp", &init).0, 403, "DNS-rebinding guard");
    assert_eq!(raw(&[("Host", &host_hdr), ("Origin", "https://evil.example")], "POST", "/mcp", &init).0, 403, "no web pages");
    assert_eq!(raw(&[("Host", &host_hdr), ("Origin", "http://localhost:3000")], "POST", "/mcp", &init).0, 200);
    assert_eq!(raw(&[("Host", &host_hdr)], "POST", "/other", &init).0, 404);
    assert_eq!(raw(&[("Host", &host_hdr)], "GET", "/mcp", "").0, 405);
    let (status, _, body) = raw(&[("Host", &host_hdr)], "POST", "/mcp", "{not json");
    assert_eq!(status, 400);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], -32700);
    assert_eq!(raw(&[("Host", &host_hdr)], "POST", "/mcp", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).0, 202);
    assert_eq!(raw(&[("Host", &host_hdr), ("Mcp-Session-Id", &sid)], "DELETE", "/mcp", "").0, 200);

    // A Magic run's draft: edits go to the draft, not the person's timeline.
    let draft = mcp::mcp().drafts.open(&host.state.doc.lock().unwrap().project, 0.0);
    let token = draft.lock().unwrap().token.clone();
    assert_eq!(token.len(), 32);
    let mut m = Agent::new(&format!("/mcp?draft={token}"));
    m.rpc("initialize", json!({"clientInfo": {"name": "claude-code"}}));
    m.json("add_clip", json!({"asset_id": asset_id}));
    assert!(host.state.doc.lock().unwrap().project.clips.is_empty(), "the live project is untouched");
    assert!(draft.lock().unwrap().changed());
    assert!(m.error("export", json!({})).contains("isn't available while making a Magic edit"));
    assert!(m.error("import_media", json!({"paths": ["/x"]})).contains("import_media isn't available while making a Magic edit."));
    assert_eq!(m.call("history", json!({"action": "undo"}))[0]["text"], "Done. 0 clips on the timeline.");
    assert!(m.call("playback", json!({"action": "seek", "time": 3}))[0]["text"].as_str().unwrap().starts_with("Playhead at 3.000s. Playback is off"));
    mcp::mcp().drafts.close(&token);
    assert!(m.error("get_project", json!({})).contains("This Magic edit was stopped or has finished."));

    // The stdio bridge, with the app answering.
    let input = format!(
        "{}\n{}\n{}\n",
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "codex-mcp-client"}}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_media", "arguments": {}}}),
    );
    let mut out = vec![];
    let mut launched = false;
    bridge::serve(input.as_bytes(), &mut out, &Options { port: PORT, from: Some("codex".into()), attempts: 3, wait: Duration::from_millis(20) }, || launched = true);
    let lines: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["result"]["serverInfo"]["name"], "promptedit");
    assert!(lines[1]["result"]["content"][0]["text"].as_str().unwrap().contains("clip.mp4"));
    assert!(!launched, "the app was open, so nothing was launched");

    // "Let AI apps edit" off: only the app's own Magic drafts are served.
    promptedit_lib::mcp::settings::update(|s| s.agents_enabled = false);
    assert_eq!(raw(&[("Host", &host_hdr)], "POST", "/mcp", &init).0, 403);
    let d2 = mcp::mcp().drafts.open(&host.state.doc.lock().unwrap().project, 0.0);
    let t2 = d2.lock().unwrap().token.clone();
    assert_eq!(raw(&[("Host", &host_hdr)], "POST", &format!("/mcp?draft={t2}"), &init).0, 200);
    promptedit_lib::mcp::settings::update(|s| s.agents_enabled = true);
    let _ = protocol::VERSIONS;

    server::stop();
}
