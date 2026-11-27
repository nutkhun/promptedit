//! A Claude Magic run end to end, with a stand-in `claude` program: PromptEdit starts it with the
//! brief on stdin and the draft's MCP address, the stand-in edits through MCP and prints Claude
//! Code's stream-json, and the finished draft lands on the project as one undo step.
#![cfg(unix)]

use promptedit_lib::magic::{self, Kind, mentions::Pointers};
use promptedit_lib::mcp::host::{HeadlessHost, Host};
use promptedit_lib::mcp::{commands, server};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::{Duration, Instant};

const FAKE_CLAUDE: &str = r#"#!/usr/bin/env python3
import json, sys, urllib.request
args = sys.argv[1:]
if args[:2] == ["auth", "status"]:
    print(json.dumps({"loggedIn": True})); sys.exit(0)
config = json.loads(args[args.index("--mcp-config") + 1])
url = config["mcpServers"]["promptedit"]["url"]
brief = sys.stdin.read()
assert "You're the editor in PromptEdit" in brief, brief
assert "mcp__promptedit__export" in args
session = None
def rpc(method, params, id):
    global session
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json", **({"Mcp-Session-Id": session} if session else {})})
    with urllib.request.urlopen(req) as r:
        session = r.headers.get("Mcp-Session-Id") or session
        return json.loads(r.read())
rpc("initialize", {"clientInfo": {"name": "claude-code"}}, 1)
media = json.loads(rpc("tools/call", {"name": "list_media", "arguments": {}}, 2)["result"]["content"][0]["text"])
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "mcp__promptedit__add_clip"}]}}), flush=True)
out = rpc("tools/call", {"name": "add_clip", "arguments": {"asset_id": media[0]["id"], "duration": 3}}, 3)
assert not out["result"]["isError"], out
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Working on it."}]}}), flush=True)
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "Put a 3-second shot on the timeline."}), flush=True)
"#;

#[test]
fn claude_magic_run_lands_as_one_undo_step() {
    let dir = std::env::temp_dir().join(format!("promptedit-magic-agent-{}", std::process::id()));
    let home = dir.join("home");
    std::fs::create_dir_all(home.join(".local/bin")).unwrap();
    let cli = home.join(".local/bin/claude");
    std::fs::write(&cli, FAKE_CLAUDE).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    // SAFETY: set before anything else runs.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("PROMPTEDIT_DATA_DIR", dir.join("data"));
    }
    let clip = dir.join("clip.mp4");
    if !clip.exists() {
        assert!(std::process::Command::new(promptedit_lib::media::tool("ffmpeg"))
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&clip)
            .status()
            .unwrap()
            .success());
    }
    let host = Arc::new(HeadlessHost { cache: dir.join("cache"), ..Default::default() });
    host.import(vec![clip.to_string_lossy().into_owned()]);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(server::start(host.clone() as Arc<dyn Host>, 47931)).unwrap();
    commands::set_app_host(host.clone());

    magic::agent::start(host.clone(), Kind::Claude, "Put one shot on.".into(), Pointers::default(), "claude-sonnet-5-5".into(), "low".into()).unwrap();
    let started = Instant::now();
    let state = loop {
        let s = magic::magic().snapshot();
        if !s.running {
            break s;
        }
        assert!(started.elapsed() < Duration::from_secs(60), "the run finishes");
        std::thread::sleep(Duration::from_millis(100));
    };
    let note = state.note.expect("a note");
    assert_eq!(note.title, None, "not an error: {}", note.text);
    assert_eq!(note.text, "Put a 3-second shot on the timeline.");
    assert!(note.changed);
    assert!(note.detail.starts_with("Sonnet 5.5 · Low · "), "{}", note.detail);
    let mut doc = host.state.doc.lock().unwrap();
    assert_eq!(doc.project.clips.len(), 1, "the draft's clip is on the timeline");
    assert!((doc.project.clips[0].duration - 3.0).abs() < 1e-6);
    assert!(doc.undo());
    assert!(doc.project.clips.is_empty(), "one undo takes the whole run back");
    assert!(!doc.can_undo());
    server::stop();
}
