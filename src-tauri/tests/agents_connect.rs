//! Agent connect on a throwaway home folder: the Codex config edit and its one-time backup, the
//! Claude extension, and status detection for Claude Code.

use promptedit_lib::agents::{AgentApp, Agents, State};

fn home(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("promptedit-agents-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn codex_config_is_edited_in_place_and_backed_up_once() {
    let h = home("codex");
    // SAFETY: set before anything reads it.
    unsafe { std::env::set_var("PROMPTEDIT_DATA_DIR", h.join("data")) };
    let agents = Agents::at(&h);
    let codex = h.join(".codex");
    std::fs::create_dir_all(&codex).unwrap();
    let original = "model = \"gpt-6.2-sol\"\n\n[mcp_servers.other]\ncommand = \"other\"\nargs = [\"--x\"]\n\n[features]\nweb_search = true\n";
    std::fs::write(codex.join("config.toml"), original).unwrap();
    assert_eq!(agents.status(AgentApp::Chatgpt), State::Ready, "~/.codex exists");

    agents.connect_codex().unwrap();
    let text = std::fs::read_to_string(codex.join("config.toml")).unwrap();
    assert!(text.starts_with(original.trim_end()), "every other line kept exactly:\n{text}");
    assert!(text.contains("\n\n[mcp_servers.promptedit]\n"));
    assert!(text.contains("startup_timeout_sec = 30\ntool_timeout_sec = 300"));
    if cfg!(windows) {
        assert!(text.contains("args = [\"--mcp\", \"--from\", \"codex\"]"));
    } else {
        assert!(text.contains("command = \"/bin/sh\""));
        let launcher = agents.support_folder().join("promptedit-mcp");
        let script = std::fs::read_to_string(&launcher).unwrap();
        assert!(script.starts_with("#!/bin/sh\n") && script.ends_with("--mcp --from codex\n"), "{script}");
    }
    assert_eq!(std::fs::read_to_string(codex.join("config.toml.before-promptedit")).unwrap(), original);
    assert!(agents.codex_connected());
    assert_eq!(agents.status(AgentApp::Chatgpt), State::Connected);

    // Connecting again replaces the section (once) and leaves the first backup alone.
    agents.connect_codex().unwrap();
    let again = std::fs::read_to_string(codex.join("config.toml")).unwrap();
    assert_eq!(again.matches("[mcp_servers.promptedit]").count(), 1);
    assert_eq!(std::fs::read_to_string(codex.join("config.toml.before-promptedit")).unwrap(), original);

    // A sub-table someone added under ours goes with it on disconnect; everything else stays.
    std::fs::write(codex.join("config.toml"), again.clone() + "\n[mcp_servers.promptedit.env]\nA = \"1\"\n\n[profiles.fast]\nmodel = \"x\"\n").unwrap();
    agents.disconnect_codex().unwrap();
    let after = std::fs::read_to_string(codex.join("config.toml")).unwrap();
    assert!(!after.contains("promptedit"));
    assert!(after.contains("[mcp_servers.other]") && after.contains("[features]") && after.contains("[profiles.fast]"));
    assert!(after.ends_with('\n'));
    assert!(!agents.codex_connected());

    // A fresh home with no config: created, with no backup (there was nothing to keep).
    let fresh = home("codex-fresh");
    let a2 = Agents::at(&fresh);
    a2.connect_codex().unwrap();
    assert!(fresh.join(".codex/config.toml").exists());
    assert!(!fresh.join(".codex/config.toml.before-promptedit").exists());
    assert!(std::fs::read_to_string(fresh.join(".codex/config.toml")).unwrap().starts_with("[mcp_servers.promptedit]\n"));
}

#[test]
fn claude_extension_and_claude_code_status() {
    let h = home("claude");
    unsafe { std::env::set_var("PROMPTEDIT_DATA_DIR", h.join("data")) };
    let agents = Agents::at(&h);
    // The .mcpb: a zip with the manifest, icon and launcher.
    let file = agents.make_claude_extension().unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&file).unwrap()).unwrap();
    let mut names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
    names.sort();
    let launcher = if cfg!(windows) { "server/promptedit-mcp.cmd" } else { "server/promptedit-mcp" };
    assert_eq!(names, vec!["icon.png".to_string(), "manifest.json".into(), launcher.into()]);
    let manifest: serde_json::Value = serde_json::from_reader(zip.by_name("manifest.json").unwrap()).unwrap();
    assert_eq!(manifest["name"], "promptedit");
    assert_eq!(manifest["display_name"], "PromptEdit");
    assert_eq!(manifest["manifest_version"], "0.3");
    assert_eq!(manifest["tools"].as_array().unwrap().len(), 43);
    assert_eq!(manifest["tools"][0], serde_json::json!({"name": "get_project", "description": "The sequence (size, frame rate, length), tracks, and every clip with its id, track, times, source, grade, sound and transition."}));
    assert_eq!(manifest["version"], "0.1.0");

    // Installed by Claude (unpacked into its extensions folder): connected.
    assert!(!agents.claude_extension_installed());
    let support = if cfg!(target_os = "macos") {
        h.join("Library/Application Support/Claude")
    } else if cfg!(windows) {
        h.join("AppData/Roaming/Claude")
    } else {
        h.join(".config/Claude")
    };
    let ext = support.join("Claude Extensions").join("local.mcpb.promptedit");
    std::fs::create_dir_all(&ext).unwrap();
    std::fs::write(ext.join("manifest.json"), manifest.to_string()).unwrap();
    assert!(agents.claude_extension_installed());

    // Claude Code: connected when ~/.claude.json lists the server.
    assert!(!agents.claude_code_connected());
    std::fs::write(h.join(".claude.json"), r#"{"mcpServers":{"promptedit":{"type":"http","url":"http://127.0.0.1:47921/mcp"}}}"#).unwrap();
    assert!(agents.claude_code_connected());
    assert_eq!(agents.status(AgentApp::ClaudeCode), State::Connected);
    assert!(Agents::connect_prompt().contains("http://127.0.0.1:47921/mcp"));
}
