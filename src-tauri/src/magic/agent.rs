//! Magic with an AI (Editroom's `MagicAgent`): Claude (through Claude Code) or ChatGPT (through Codex)
//! works out the edit in the background on a hidden draft of the project, using PromptEdit's MCP
//! tools and the person's own Claude or ChatGPT plan (no API key). The CLIs run headless with the
//! brief on stdin and the draft's MCP address; their JSON-lines output drives the status. When the
//! run ends, the finished draft goes onto the timeline as one undo step.
//!
//! Windows: the MCP config goes to `claude` as a temp file path rather than a JSON argument, since
//! quote-heavy arguments to `.cmd` shims can be refused (spec §2.6). Codex on native Windows and
//! where the Windows ChatGPT app keeps its `codex` are UNSURE.

use super::{Kind, Note, magic};
use crate::agents::{Agents, augmented_path};
use crate::mcp::{self, host::Host};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A model the Magic popover offers.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub efforts: Vec<String>,
    pub default_effort: String,
}

/// The models each AI offers. ChatGPT's are filtered by Codex's own list on this computer.
pub fn models(kind: Kind, agents: &Agents) -> Vec<ModelOption> {
    match kind {
        Kind::Claude => {
            let efforts: Vec<String> = ["low", "medium", "high", "xhigh", "max"].map(String::from).to_vec();
            [("claude-opus-5-5", "Opus 5.5", "Best edits"), ("claude-sonnet-5-5", "Sonnet 5.5", "Fast"), ("claude-haiku-5-5", "Haiku 5.5", "Fastest"), ("claude-fable-5-2", "Fable 5.2", "Most capable")]
                .into_iter()
                .map(|(id, name, blurb)| ModelOption { id: id.into(), name: name.into(), blurb: blurb.into(), efforts: efforts.clone(), default_effort: "medium".into() })
                .collect()
        }
        Kind::Chatgpt => {
            let picks = [("gpt-6.2-sol", "GPT-6.2-Sol"), ("gpt-6.2-astra", "GPT-6.2-Astra"), ("gpt-6.1-terra", "GPT-6.1-Terra"), ("gpt-6-luna", "GPT-6-Luna")];
            let cache: Option<Value> = std::fs::read(agents.codex_home().join("models_cache.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
            let known: Vec<Value> = cache.and_then(|c| c["models"].as_array().cloned()).unwrap_or_default();
            picks
                .into_iter()
                .filter_map(|(slug, name)| {
                    let m = known.iter().find(|m| m["slug"] == slug);
                    // Not listed by Codex here: this plan doesn't offer it.
                    if !known.is_empty() && m.is_none() {
                        return None;
                    }
                    // Not "ultra": it hands parts of the job to more agents, which costs much more.
                    let efforts = m
                        .and_then(|m| m["supported_reasoning_levels"].as_array())
                        .map(|l| l.iter().filter_map(|e| e["effort"].as_str()).filter(|e| *e != "ultra").map(String::from).collect())
                        .unwrap_or_else(|| ["low", "medium", "high", "xhigh"].map(String::from).to_vec());
                    let default_effort = m.and_then(|m| m["default_reasoning_level"].as_str()).unwrap_or("medium").to_string();
                    Some(ModelOption { id: slug.into(), name: name.into(), blurb: String::new(), efforts, default_effort })
                })
                .collect()
        }
    }
}

pub fn effort_name(e: &str) -> String {
    if e == "xhigh" {
        return "Extra high".into();
    }
    let mut c = e.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// The status verb for a tool (`"<Name> is <verb>"`).
pub fn doing(tool: &str) -> &'static str {
    match tool {
        "list_media" | "get_project" | "list_looks" => "reading",
        "look_at_media" => "watching",
        "note_media" => "noting",
        "analyze_media" => "studying",
        "get_transcript" => "listening",
        "add_clip" | "trim_clip" | "move_clip" | "split_clip" | "delete_clips" | "set_sequence" | "add_track" => "cutting",
        "set_grade" => "grading",
        "add_title" | "set_title_style" => "titling",
        "search_media" => "searching",
        "set_marker" | "delete_markers" | "set_in_out" => "marking",
        "set_transform" | "freeze_frame" | "reverse_clip" | "detach_audio" | "duplicate_clip" | "add_solid" | "set_solid_color" | "set_track" => "editing",
        "set_audio" | "set_transition" => "finishing",
        "get_frame" | "playback" | "history" => "checking",
        _ => "thinking",
    }
}

/// An empty folder of its own, so the AI reads no project's settings or notes.
fn magic_folder() -> PathBuf {
    let d = mcp::cache_dir().join("Magic");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn command(cli: &Path) -> Command {
    let mut c = Command::new(cli);
    c.env("PATH", augmented_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Runs a program to the end and returns what it printed.
fn output(cli: &Path, args: &[&str]) -> String {
    match command(cli).args(args).stdin(Stdio::null()).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr),
        Err(e) => e.to_string(),
    }
}

pub fn signed_in(kind: Kind, cli: &Path) -> bool {
    match kind {
        Kind::Claude => serde_json::from_str::<Value>(output(cli, &["auth", "status", "--json"]).trim()).ok().and_then(|j| j["loggedIn"].as_bool()).unwrap_or(false),
        Kind::Chatgpt => {
            let out = output(cli, &["login", "status"]).to_lowercase();
            out.contains("logged in") && !out.contains("not logged in")
        }
    }
}

/// Signs in once, in the browser.
pub fn sign_in(kind: Kind, cli: &Path) -> Result<(), String> {
    let out = output(cli, if kind == Kind::Claude { &["auth", "login", "--claudeai"][..] } else { &["login"][..] });
    if signed_in(kind, cli) { Ok(()) } else { Err(if out.trim().is_empty() { "Signing in didn't finish.".into() } else { out.chars().take(600).collect() }) }
}

pub fn cli(kind: Kind) -> Option<PathBuf> {
    let a = Agents::user();
    if kind == Kind::Claude { a.claude_cli() } else { a.codex_cli() }
}

/// The arguments for each CLI (Editroom's, with the server named "promptedit").
pub fn args(kind: Kind, url: &str, model: &str, effort: &str, folder: &Path) -> Vec<String> {
    let n = mcp::SERVER_NAME;
    let mut a: Vec<String> = vec![];
    match kind {
        Kind::Claude => {
            let config = format!(r#"{{"mcpServers":{{"{n}":{{"type":"http","url":"{url}"}}}}}}"#);
            let config_arg = if cfg!(windows) {
                let file = folder.join("mcp-config.json");
                let _ = std::fs::write(&file, &config);
                file.to_string_lossy().into_owned()
            } else {
                config
            };
            a.extend(["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--mcp-config"].map(String::from));
            a.push(config_arg);
            a.push("--strict-mcp-config".into());
            // PromptEdit's tools, and web search and reading pages (to find music). None of Claude
            // Code's others: no files, no shell.
            a.extend(["--tools", "WebSearch,WebFetch", "--allowedTools"].map(String::from));
            a.extend([format!("mcp__{n}"), "WebSearch".into(), "WebFetch".into(), "--disallowedTools".into()]);
            a.extend(["auto_edit", "import_media", "save_project", "export"].map(|t| format!("mcp__{n}__{t}")));
            if !model.is_empty() {
                a.extend(["--model".into(), model.into()]);
            }
            if !effort.is_empty() {
                a.extend(["--effort".into(), effort.into()]);
            }
        }
        Kind::Chatgpt => {
            // Web search (to find music); the shell stays read-only and offline.
            a.extend(["--search", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-s", "read-only", "-C"].map(String::from));
            a.push(folder.to_string_lossy().into_owned());
            a.extend([
                "-c".into(),
                format!("mcp_servers.{n}.url=\"{url}\""),
                "-c".into(),
                format!("mcp_servers.{n}.tool_timeout_sec=300"),
                "-c".into(),
                format!("mcp_servers.{n}.startup_timeout_sec=30"),
                "-c".into(),
                "approval_policy=\"never\"".into(),
            ]);
            if !model.is_empty() {
                a.extend(["-m".into(), model.into()]);
            }
            if !effort.is_empty() {
                a.extend(["-c".into(), format!("model_reasoning_effort=\"{effort}\"")]);
            }
            a.push("-".into());
        }
    }
    a
}

/// What a run has read from the CLI so far.
#[derive(Default)]
pub struct Reading {
    pub last_message: String,
    pub failure: Option<String>,
    pub tool: Option<String>,
}

/// One line of the CLI's JSON output.
pub fn read_line(kind: Kind, line: &str, r: &mut Reading) {
    let Ok(j) = serde_json::from_str::<Value>(line) else { return };
    match kind {
        Kind::Claude => match j["type"].as_str() {
            Some("result") => {
                if let Some(t) = j["result"].as_str() {
                    r.last_message = t.to_string();
                }
                if j["is_error"].as_bool().unwrap_or(false) || j["subtype"].as_str() != Some("success") {
                    r.failure = Some(if r.last_message.is_empty() { format!("Claude stopped ({}).", j["subtype"].as_str().unwrap_or("error")) } else { r.last_message.clone() });
                }
            }
            Some("assistant") => {
                let Some(content) = j.pointer("/message/content").and_then(Value::as_array) else { return };
                if let Some(t) = content.iter().rev().find(|c| c["type"] == "tool_use").and_then(|c| c["name"].as_str()) {
                    r.tool = Some(t.replace(&format!("mcp__{}__", mcp::SERVER_NAME), ""));
                }
                if let Some(t) = content.iter().rev().find(|c| c["type"] == "text").and_then(|c| c["text"].as_str()).filter(|t| !t.is_empty()) {
                    r.last_message = t.to_string();
                }
            }
            _ => {}
        },
        Kind::Chatgpt => {
            let item = &j["item"];
            match (j["type"].as_str().unwrap_or(""), item["type"].as_str()) {
                ("item.started", Some("mcp_tool_call")) => r.tool = item["tool"].as_str().map(String::from),
                ("item.completed", Some("agent_message")) => {
                    if let Some(t) = item["text"].as_str().filter(|t| !t.is_empty()) {
                        r.last_message = t.to_string();
                    }
                }
                ("turn.failed", _) => r.failure = Some(j.pointer("/error/message").and_then(Value::as_str).unwrap_or("ChatGPT stopped.").to_string()),
                ("error", _) => {
                    if let Some(m) = j["message"].as_str() {
                        r.failure = Some(m.to_string());
                    }
                }
                _ => {}
            }
        }
    }
}

/// Starts an AI run in the background. The Magic state shows its progress; its note comes at the end.
pub fn start(host: Arc<dyn Host>, kind: Kind, request: String, pointers: super::mentions::Pointers, model: String, effort: String) -> Result<(), String> {
    let cli = cli(kind).ok_or_else(|| format!("{} isn't on this computer.", if kind == Kind::Claude { "Claude Code" } else { "Codex" }))?;
    let run_id = magic().begin(kind.tab(), &format!("{} is starting", kind.name()))?;
    let detail = {
        let name = models(kind, &Agents::user()).into_iter().find(|m| m.id == model).map(|m| m.name).unwrap_or_else(|| if model.is_empty() { "Default".into() } else { model.clone() });
        if effort.is_empty() { name } else { format!("{name} · {}", effort_name(&effort)) }
    };
    std::thread::spawn(move || {
        let result = run(host.as_ref(), kind, &cli, &request, &pointers, &model, &effort, run_id);
        let m = magic();
        if !m.is_current(run_id) {
            return;
        }
        let seconds = m.elapsed().as_secs_f64().round() as i64;
        let note = match result {
            Ok((text, changed)) => Note { agent: Some(kind.tab().into()), text, changed, detail: format!("{detail} · {seconds}s"), title: None, sign_in: false },
            Err(e) => e,
        };
        m.finish(note);
        if note_wants_attention() {
            host.request_attention();
        }
    });
    Ok(())
}

fn note_wants_attention() -> bool {
    true
}

type RunResult = Result<(String, bool), Note>;

fn alert(title: &str, text: &str) -> Note {
    Note { agent: None, text: text.into(), changed: false, detail: String::new(), title: Some(title.into()), sign_in: false }
}

#[allow(clippy::too_many_arguments)]
fn run(host: &dyn Host, kind: Kind, cli: &Path, request: &str, pointers: &super::mentions::Pointers, model: &str, effort: &str, run_id: u64) -> RunResult {
    let name = kind.name();
    let m = magic();
    // Magic needs the connection even when other apps aren't allowed in.
    let endpoint = server_ready(host).ok_or_else(|| alert("Couldn't start Magic", &format!("{} couldn't open its connection for {name}.", mcp::APP_NAME)))?;
    if !signed_in(kind, cli) {
        let text = if kind == Kind::Claude {
            format!("Magic uses Claude through Claude Code {}, with your Claude plan. It needs signing in once, in your browser.", mcp::on_this())
        } else {
            "Magic uses ChatGPT through Codex, which comes with the ChatGPT app, with your ChatGPT plan. It needs signing in once, in your browser.".to_string()
        };
        return Err(Note { agent: Some(kind.tab().into()), text, changed: false, detail: String::new(), title: Some(format!("Sign in to {name}")), sign_in: true });
    }
    if !m.is_current(run_id) {
        return Ok((String::new(), false));
    }
    let base = host.state().doc.lock().unwrap().project.clone();
    let draft = mcp::mcp().drafts.open(&base, pointers.playhead);
    let token = draft.lock().unwrap().token.clone();
    m.set_draft(Some(token.clone()));
    m.set_status(&format!("{name} is thinking"));
    let folder = magic_folder();
    let url = format!("{endpoint}?draft={token}");
    let brief = super::brief::brief(request, &base, Some(pointers));
    let started = Instant::now();
    let mut child = match command(cli).args(args(kind, &url, model, effort, &folder)).current_dir(&folder).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            mcp::mcp().drafts.close(&token);
            return Err(alert(&format!("Couldn't start {name}"), &e.to_string()));
        }
    };
    // The brief on stdin, then stdin closed.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(brief.as_bytes());
    }
    let stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            use std::io::Read;
            let _ = s.read_to_string(&mut buf);
        }
        buf.chars().rev().take(20_000).collect::<Vec<_>>().into_iter().rev().collect::<String>()
    });
    let stdout = child.stdout.take();
    m.set_child(Some(child));
    let mut reading = Reading::default();
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            read_line(kind, &line, &mut reading);
            if let Some(t) = reading.tool.take() {
                if std::env::var("PROMPTEDIT_MAGIC_LOG").is_ok() {
                    eprintln!("MAGIC AI tool {t}");
                }
                m.set_status(&format!("{name} is {}", doing(&t)));
            }
        }
    }
    let code = m.take_child().and_then(|mut c| c.wait().ok()).and_then(|s| s.code()).unwrap_or(-1);
    let stderr = errors.join().unwrap_or_default();
    let d = mcp::mcp().drafts.close(&token);
    m.set_draft(None);
    stop_server_if_off();
    if !m.is_current(run_id) {
        // Stopped: nothing changes.
        return Ok((String::new(), false));
    }
    let _ = started;
    let Some(d) = d else { return Ok((format!("{name} didn't change anything."), false)) };
    let d = d.lock().unwrap();
    let said = reading.last_message.trim().to_string();
    if !d.changed() {
        if let Some(f) = reading.failure {
            return Err(alert(&format!("{name} couldn't make the edit"), &f.chars().take(600).collect::<String>()));
        }
        if code != 0 {
            let tail: String = stderr.trim().chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
            return Err(alert(&format!("{name} couldn't make the edit"), &if tail.is_empty() { format!("It stopped (code {code}).") } else { tail }));
        }
        return Ok((if said.is_empty() { format!("{name} didn't change anything.") } else { said }, false));
    }
    // Played onto the timeline as it is now (in case it changed while the AI was thinking), as one undo step.
    let changed = {
        let mut doc = host.state().doc.lock().unwrap();
        let now = doc.project.clone();
        doc.mutate(|p| *p = mcp::draft::merged(&d.base, &d.doc.project, &now))
    };
    if changed {
        host.project_changed();
    }
    Ok((said, changed))
}

/// The local MCP address, starting the server for this run if it isn't running.
fn server_ready(host: &dyn Host) -> Option<String> {
    let m = mcp::mcp();
    if let Some(e) = m.local_endpoint() {
        return Some(e);
    }
    let app = mcp::commands::app_host()?;
    let _ = host;
    super::magic().started_server.store(true, std::sync::atomic::Ordering::SeqCst);
    mcp::commands::start_server(app);
    for _ in 0..40 {
        if let Some(e) = m.local_endpoint() {
            return Some(e);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn stop_server_if_off() {
    if super::magic().started_server.swap(false, std::sync::atomic::Ordering::SeqCst) && !mcp::settings::get().agents_enabled {
        mcp::server::stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_args_name_promptedit() {
        let a = args(Kind::Claude, "http://127.0.0.1:47921/mcp?draft=abc", "claude-opus-5-5", "low", Path::new("/tmp"));
        assert!(a.contains(&"mcp__promptedit".to_string()));
        assert!(a.contains(&"mcp__promptedit__export".to_string()));
        assert!(a.iter().any(|x| x.contains("\"promptedit\":{\"type\":\"http\"") || x.ends_with("mcp-config.json")));
        let c = args(Kind::Chatgpt, "http://x/mcp?draft=1", "", "high", Path::new("/tmp"));
        assert_eq!(c.last().map(String::as_str), Some("-"));
        assert!(c.contains(&"mcp_servers.promptedit.url=\"http://x/mcp?draft=1\"".to_string()));
    }

    #[test]
    fn reads_stream_json() {
        let mut r = Reading::default();
        read_line(Kind::Claude, r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__promptedit__add_clip"}]}}"#, &mut r);
        assert_eq!(r.tool.as_deref(), Some("add_clip"));
        read_line(Kind::Claude, r#"{"type":"result","subtype":"success","is_error":false,"result":"Made a cut."}"#, &mut r);
        assert_eq!(r.last_message, "Made a cut.");
        assert!(r.failure.is_none());
        let mut c = Reading::default();
        read_line(Kind::Chatgpt, r#"{"type":"turn.failed","error":{"message":"No."}}"#, &mut c);
        assert_eq!(c.failure.as_deref(), Some("No."));
    }
}
