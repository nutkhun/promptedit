//! Adds PromptEdit to the Claude app, ChatGPT's Codex and Claude Code, and takes it out again
//! (Editroom's `AgentConnect`, docs/spec/03-mcp-magic.md §2):
//!
//! - Claude: PromptEdit makes a Claude extension (an `.mcpb` file) and opens it in Claude, which
//!   asks the person to install it. Disconnecting only stops PromptEdit answering it.
//! - ChatGPT: adds an `[mcp_servers.promptedit]` section to Codex's settings (`~/.codex/config.toml`),
//!   used by Codex in the ChatGPT app, backing the file up once first.
//! - Claude Code: runs `claude mcp add --scope user --transport http promptedit <endpoint>`.
//!
//! Claude and Codex start PromptEdit's own connection program, `PromptEdit --mcp` (see
//! `mcp::bridge`); Claude Code talks to the server directly.
//!
//! Paths follow the spec's Windows table. Things marked UNSURE haven't been checked against a real
//! Windows install of that app.

use crate::mcp::{self, SERVER_NAME, settings};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentApp {
    Claude,
    Chatgpt,
    ClaudeCode,
}

impl AgentApp {
    pub const ALL: [AgentApp; 3] = [AgentApp::Claude, AgentApp::Chatgpt, AgentApp::ClaudeCode];
    pub fn title(self) -> &'static str {
        match self {
            AgentApp::Claude => "Claude",
            AgentApp::Chatgpt => "ChatGPT",
            AgentApp::ClaudeCode => "Claude Code",
        }
    }
    /// The name the app's cursor uses in the timeline.
    pub fn cursor_name(self) -> &'static str {
        match self {
            AgentApp::Claude | AgentApp::ClaudeCode => "Claude",
            AgentApp::Chatgpt => "Codex",
        }
    }
    pub fn download(self) -> Option<&'static str> {
        match self {
            AgentApp::Claude => Some("https://claude.ai/download"),
            AgentApp::Chatgpt => Some("https://chatgpt.com/download"),
            AgentApp::ClaudeCode => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", content = "message", rename_all = "camelCase")]
pub enum State {
    /// The app isn't on this computer.
    Missing,
    /// Can connect.
    Ready,
    /// Claude's install box is open.
    Waiting,
    Connected,
    Working,
    Failed(String),
}

/// Where everything lives, from a home folder (tests use a throwaway one).
pub struct Agents {
    pub home: PathBuf,
    /// The real home: system locations (`%APPDATA%`, `CODEX_HOME`, `/Applications`) count too.
    pub real: bool,
    /// Make the Claude extension without opening it (tests).
    pub open_in_claude: bool,
}

/// Claude's install box being open, and since when.
static WAITING: Mutex<Option<Instant>> = Mutex::new(None);
static FAILED: Mutex<Vec<(AgentApp, String)>> = Mutex::new(Vec::new());

const CODEX_HEADER: &str = "[mcp_servers.promptedit]";

impl Agents {
    pub fn user() -> Self {
        Agents { home: dirs::home_dir().unwrap_or_else(std::env::temp_dir), real: true, open_in_claude: true }
    }

    pub fn at(home: impl Into<PathBuf>) -> Self {
        Agents { home: home.into(), real: false, open_in_claude: false }
    }

    // MARK: Folders

    /// The per-user roaming folder apps keep settings in.
    fn roaming(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            self.home.join("Library/Application Support")
        } else if cfg!(windows) {
            if self.real { dirs::data_dir().unwrap_or_else(|| self.home.join("AppData\\Roaming")) } else { self.home.join("AppData").join("Roaming") }
        } else {
            self.home.join(".config")
        }
    }

    /// `…/PromptEdit/Agents`: the launcher and the Claude extension.
    pub fn support_folder(&self) -> PathBuf {
        if self.real && !cfg!(target_os = "linux") {
            return mcp::data_dir().join("Agents");
        }
        self.roaming().join(mcp::APP_NAME).join("Agents")
    }

    /// Claude's settings folder. Windows: `%APPDATA%\Claude` (documented); a Store (MSIX) install may
    /// keep it under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude` (UNSURE), also checked.
    fn claude_support(&self) -> Vec<PathBuf> {
        let mut out = vec![self.roaming().join("Claude")];
        if cfg!(windows) {
            let local = if self.real { dirs::data_local_dir() } else { Some(self.home.join("AppData").join("Local")) };
            if let Some(packages) = local.map(|l| l.join("Packages"))
                && let Ok(rd) = std::fs::read_dir(&packages)
            {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with("Claude_") {
                        out.push(e.path().join("LocalCache").join("Roaming").join("Claude"));
                    }
                }
            }
        }
        out
    }

    /// `~/.codex`, or `CODEX_HOME` when set (Editroom ignores it; the Codex CLI honours it).
    pub fn codex_home(&self) -> PathBuf {
        if self.real
            && let Some(h) = std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty())
        {
            return PathBuf::from(h);
        }
        self.home.join(".codex")
    }

    fn codex_config(&self) -> PathBuf {
        self.codex_home().join("config.toml")
    }

    // MARK: Apps and programs

    /// The Claude desktop app. macOS: by bundle id. Windows: the Squirrel install at
    /// `%LOCALAPPDATA%\AnthropicClaude\claude.exe`, or a Store package (UNSURE).
    pub fn claude_app(&self) -> Option<PathBuf> {
        if cfg!(target_os = "macos") {
            let mut c = vec![PathBuf::from("/Applications/Claude.app"), self.home.join("Applications/Claude.app")];
            if !self.real {
                c.remove(0);
            }
            return c.into_iter().find(|p| p.exists()).or_else(|| self.real.then(|| spotlight("com.anthropic.claudefordesktop")).flatten());
        }
        if cfg!(windows) {
            let local = if self.real { dirs::data_local_dir()? } else { self.home.join("AppData").join("Local") };
            let exe = local.join("AnthropicClaude").join("claude.exe");
            if exe.exists() {
                return Some(exe);
            }
            return self.claude_support().into_iter().nth(1).filter(|p| p.exists());
        }
        None
    }

    /// ChatGPT or Codex app (macOS bundle ids `com.openai.chat`, `com.openai.codex`).
    fn chatgpt_app(&self) -> Option<PathBuf> {
        if !cfg!(target_os = "macos") {
            return None;
        }
        let mut c = vec![];
        for name in ["ChatGPT.app", "Codex.app"] {
            if self.real {
                c.push(PathBuf::from("/Applications").join(name));
            }
            c.push(self.home.join("Applications").join(name));
        }
        c.into_iter().find(|p| p.exists()).or_else(|| {
            self.real.then(|| spotlight("com.openai.codex").or_else(|| spotlight("com.openai.chat"))).flatten()
        })
    }

    /// The `codex` program: the one the ChatGPT app ships, or one installed on its own.
    /// Windows: npm's `%APPDATA%\npm\codex.cmd` or PATH (where the Windows ChatGPT app keeps its copy is UNSURE).
    pub fn codex_cli(&self) -> Option<PathBuf> {
        if let Some(app) = self.chatgpt_app() {
            let c = app.join("Contents/Resources/codex-cli/bin/codex");
            if is_executable(&c) {
                return Some(c);
            }
        }
        let mut known = vec![self.home.join(".local/bin/codex")];
        if cfg!(windows) {
            known.push(self.roaming().join("npm").join("codex.cmd"));
            known.push(self.home.join(".local").join("bin").join("codex.exe"));
        } else if self.real {
            known.push("/opt/homebrew/bin/codex".into());
            known.push("/usr/local/bin/codex".into());
        }
        known.into_iter().find(|p| is_executable(p)).or_else(|| self.real.then(|| which("codex")).flatten())
    }

    /// The `claude` program: where its installers put it, PATH, or the copy inside the Claude app.
    pub fn claude_cli(&self) -> Option<PathBuf> {
        let h = &self.home;
        let mut known = vec![h.join(".local/bin/claude"), h.join(".claude/local/claude")];
        if cfg!(windows) {
            known = vec![h.join(".local").join("bin").join("claude.exe"), self.roaming().join("npm").join("claude.cmd"), h.join(".claude").join("local").join("claude.exe")];
        } else if self.real {
            known.push("/opt/homebrew/bin/claude".into());
            known.push("/usr/local/bin/claude".into());
        }
        if let Some(p) = known.into_iter().find(|p| is_executable(p)) {
            return Some(p);
        }
        if self.real
            && let Some(p) = which("claude")
        {
            return Some(p);
        }
        // The copy the Claude app keeps for its Code tab (macOS): newest version first.
        let root = self.roaming().join("Claude").join("claude-code");
        let mut versions: Vec<PathBuf> = std::fs::read_dir(&root).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        versions.sort_by(|a, b| numeric_cmp(&b.to_string_lossy(), &a.to_string_lossy()));
        for v in versions {
            if let Some(found) = find_file(&v, "claude", 6).filter(|p| p.to_string_lossy().ends_with("Contents/MacOS/claude") && is_executable(p)) {
                return Some(found);
            }
        }
        None
    }

    // MARK: Status

    pub fn claude_extension_installed(&self) -> bool {
        for support in self.claude_support() {
            if self.installed_extension_dirs(&support).next().is_some() {
                return true;
            }
            // Set up by hand in Claude's settings file.
            let config = support.join("claude_desktop_config.json");
            if let Some(j) = read_json(&config)
                && j.pointer(&format!("/mcpServers/{SERVER_NAME}")).is_some()
            {
                return true;
            }
        }
        false
    }

    fn installed_extension_dirs(&self, support: &Path) -> impl Iterator<Item = PathBuf> {
        let dir = support.join("Claude Extensions");
        std::fs::read_dir(dir)
            .map(|r| r.flatten().map(|e| e.path()).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .filter(|d| read_json(&d.join("manifest.json")).is_some_and(|j| j["name"] == SERVER_NAME))
    }

    pub fn codex_connected(&self) -> bool {
        std::fs::read_to_string(self.codex_config()).is_ok_and(|t| t.lines().any(|l| l.trim() == CODEX_HEADER))
    }

    pub fn claude_code_connected(&self) -> bool {
        read_json(&self.home.join(".claude.json")).is_some_and(|j| j.pointer(&format!("/mcpServers/{SERVER_NAME}")).is_some())
    }

    pub fn status(&self, app: AgentApp) -> State {
        if let Some((_, m)) = FAILED.lock().unwrap().iter().find(|(a, _)| *a == app) {
            return State::Failed(m.clone());
        }
        match app {
            AgentApp::Claude => {
                let off = settings::get().claude_app_disconnected;
                let installed = self.claude_extension_installed();
                let mut w = WAITING.lock().unwrap();
                if installed && !off {
                    *w = None;
                    return State::Connected;
                }
                if let Some(since) = *w {
                    if since.elapsed() < Duration::from_secs(300) {
                        return State::Waiting;
                    }
                    *w = None;
                }
                if self.claude_app().is_none() { State::Missing } else { State::Ready }
            }
            AgentApp::Chatgpt => {
                if self.codex_connected() {
                    return State::Connected;
                }
                let installed = self.chatgpt_app().is_some() || self.codex_home().exists() || self.codex_cli().is_some();
                if installed { State::Ready } else { State::Missing }
            }
            AgentApp::ClaudeCode => {
                if self.claude_code_connected() {
                    return State::Connected;
                }
                if self.claude_cli().is_none() { State::Missing } else { State::Ready }
            }
        }
    }

    // MARK: Connect

    pub fn connect(&self, app: AgentApp) -> Result<State, String> {
        FAILED.lock().unwrap().retain(|(a, _)| *a != app);
        let r = (|| -> Result<(), String> {
            match app {
                AgentApp::Claude => {
                    settings::update(|s| s.claude_app_disconnected = false);
                    // Installed already (and only turned off here): nothing more to do.
                    if !self.claude_extension_installed() {
                        let file = self.make_claude_extension()?;
                        if self.open_in_claude {
                            self.open_in_claude_app(&file)?;
                            *WAITING.lock().unwrap() = Some(Instant::now());
                        }
                    }
                }
                AgentApp::Chatgpt => self.connect_codex()?,
                AgentApp::ClaudeCode => {
                    self.run_claude_cli(&["mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, &format!("http://127.0.0.1:{}/mcp", mcp::PORT)])?
                }
            }
            // Connecting an AI turns "Let AI apps edit" on.
            settings::update(|s| s.agents_enabled = true);
            Ok(())
        })();
        match r {
            Ok(()) => Ok(self.status(app)),
            Err(e) => {
                FAILED.lock().unwrap().push((app, e.clone()));
                Err(e)
            }
        }
    }

    pub fn disconnect(&self, app: AgentApp) -> Result<State, String> {
        FAILED.lock().unwrap().retain(|(a, _)| *a != app);
        match app {
            // Claude keeps its own list of extensions; PromptEdit stops answering this one.
            AgentApp::Claude => {
                settings::update(|s| s.claude_app_disconnected = true);
            }
            AgentApp::Chatgpt => self.disconnect_codex()?,
            AgentApp::ClaudeCode => self.run_claude_cli(&["mcp", "remove", "--scope", "user", SERVER_NAME])?,
        }
        Ok(self.status(app))
    }

    /// Stops waiting for the person to click Install in Claude.
    pub fn cancel_waiting(&self) {
        *WAITING.lock().unwrap() = None;
    }

    /// Opens the Claude extension in Claude again (if its install box was closed).
    pub fn reopen_claude(&self) -> Result<(), String> {
        let file = self.support_folder().join(format!("{}.mcpb", mcp::APP_NAME));
        if !file.exists() {
            return self.connect(AgentApp::Claude).map(|_| ());
        }
        self.open_in_claude_app(&file)?;
        *WAITING.lock().unwrap() = Some(Instant::now());
        Ok(())
    }

    // MARK: The program each app starts

    /// The app's own executable (the bridge is `<it> --mcp`).
    pub fn binary() -> PathBuf {
        std::env::current_exe().unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/Applications/PromptEdit.app/Contents/MacOS/PromptEdit".into()
            } else {
                "PromptEdit.exe".into()
            }
        })
    }

    /// A small script that starts PromptEdit's connection program, finding PromptEdit even if it
    /// has moved (macOS: Spotlight by bundle id). `from` tells PromptEdit which app is calling.
    pub fn launcher_script(from: &str) -> String {
        let binary = Self::binary().to_string_lossy().into_owned();
        if cfg!(windows) {
            return format!("@echo off\r\nrem Starts PromptEdit's connection for AI apps (Claude, ChatGPT's Codex).\r\n\"{binary}\" --mcp --from {from}\r\n");
        }
        let bundle_id = "app.promptedit";
        format!(
            "#!/bin/sh\n# Starts PromptEdit's connection for AI apps (Claude, ChatGPT's Codex).\napp={}\nif [ ! -x \"$app\" ] && [ -x /usr/bin/mdfind ]; then\n  found=$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == \"{bundle_id}\"' | /usr/bin/head -n 1)\n  [ -n \"$found\" ] && for n in PromptEdit promptedit; do [ -x \"$found/Contents/MacOS/$n\" ] && app=\"$found/Contents/MacOS/$n\"; done\nfi\n[ -x \"$app\" ] || app=\"/Applications/PromptEdit.app/Contents/MacOS/PromptEdit\"\nexec \"$app\" --mcp --from {from}\n",
            shell_quote(&binary)
        )
    }

    fn launcher_name() -> &'static str {
        if cfg!(windows) { "promptedit-mcp.cmd" } else { "promptedit-mcp" }
    }

    /// Writes the launcher (refreshed every time, in case PromptEdit moved) and returns its path.
    fn write_launcher(&self, folder: &Path, from: &str) -> Result<PathBuf, String> {
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        let path = folder.join(Self::launcher_name());
        std::fs::write(&path, Self::launcher_script(from)).map_err(|e| e.to_string())?;
        make_executable(&path);
        Ok(path)
    }

    /// PromptEdit moved, or a new copy runs from somewhere else: the launchers the AI apps already
    /// have are pointed at this copy (once a launch).
    pub fn follow_move(&self) {
        let mut launchers = vec![(self.support_folder().join(Self::launcher_name()), "codex")];
        for support in self.claude_support() {
            for d in self.installed_extension_dirs(&support) {
                launchers.push((d.join("server").join(Self::launcher_name()), "claude-app"));
            }
        }
        for (path, from) in launchers {
            let Ok(now) = std::fs::read_to_string(&path) else { continue };
            let want = Self::launcher_script(from);
            if now != want && std::fs::write(&path, want).is_ok() {
                make_executable(&path);
            }
        }
        // Windows' Codex entry names the executable itself.
        if cfg!(windows) && self.codex_connected() {
            let _ = self.connect_codex();
        }
    }

    // MARK: Claude (an extension)

    /// The extension's manifest. macOS runs the shell launcher with `/bin/sh`; Windows runs the
    /// `.cmd` launcher through `cmd.exe` (Claude spawns without a shell, and Node refuses to run a
    /// `.cmd` directly). Claude substitutes `${__dirname}` (known); the Windows entry is UNSURE.
    pub fn manifest(&self, with_icon: bool) -> serde_json::Value {
        use serde_json::json;
        let tools: Vec<serde_json::Value> = mcp::defs::definitions()
            .iter()
            .map(|d| {
                let text = d["description"].as_str().unwrap_or("").split(". ").next().unwrap_or("").to_string();
                json!({"name": d["name"], "description": if text.ends_with('.') { text } else { text + "." }})
            })
            .collect();
        let (platform, config, entry) = if cfg!(windows) {
            ("win32", json!({"command": "cmd.exe", "args": ["/d", "/c", "${__dirname}\\server\\promptedit-mcp.cmd"]}), "server/promptedit-mcp.cmd")
        } else {
            ("darwin", json!({"command": "/bin/sh", "args": ["${__dirname}/server/promptedit-mcp"]}), "server/promptedit-mcp")
        };
        let mut m = json!({
            "manifest_version": "0.3",
            "name": SERVER_NAME,
            "display_name": mcp::APP_NAME,
            "version": semver(env!("CARGO_PKG_VERSION")),
            "description": "Edit your videos in PromptEdit: cut, trim, arrange, grade, add titles and music.",
            "long_description": format!("Lets Claude edit in PromptEdit, the video editor on your {}. Claude gets its own cursor in PromptEdit, so you can watch every edit, and each one can be undone. PromptEdit opens by itself when Claude needs it.", if cfg!(windows) { "PC" } else { "Mac" }),
            "author": {"name": mcp::APP_NAME},
            "server": {"type": "binary", "entry_point": entry, "mcp_config": config},
            "tools": tools,
            "keywords": ["video", "editing", "promptedit"],
            "compatibility": {"platforms": [platform]},
        });
        if with_icon {
            m["icon"] = "icon.png".into();
        }
        m
    }

    /// The extension file: a zip holding manifest.json, an icon and the launcher.
    pub fn make_claude_extension(&self) -> Result<PathBuf, String> {
        use std::io::Write;
        let folder = self.support_folder();
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let out = folder.join(format!("{}.mcpb", mcp::APP_NAME));
        let file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let icon: &[u8] = include_bytes!("../icons/128x128@2x.png");
        let manifest = serde_json::to_vec_pretty(&self.manifest(true)).map_err(|e| e.to_string())?;
        let err = |e: zip::result::ZipError| format!("Couldn't make the Claude extension: {e}");
        zip.start_file("manifest.json", opts).map_err(err)?;
        zip.write_all(&manifest).map_err(|e| e.to_string())?;
        zip.start_file("icon.png", opts).map_err(err)?;
        zip.write_all(icon).map_err(|e| e.to_string())?;
        zip.start_file(format!("server/{}", Self::launcher_name()), opts.unix_permissions(0o755)).map_err(err)?;
        zip.write_all(Self::launcher_script("claude-app").as_bytes()).map_err(|e| e.to_string())?;
        zip.finish().map_err(err)?;
        Ok(out)
    }

    /// Opens the extension in Claude, which shows its own install box. macOS: `open -a Claude`.
    /// Windows: `claude.exe <file>` (UNSURE that it takes a file argument), else the file's own
    /// association.
    fn open_in_claude_app(&self, file: &Path) -> Result<(), String> {
        let app = self.claude_app().ok_or("The Claude app isn't on this computer.")?;
        let status = if cfg!(target_os = "macos") {
            Command::new("/usr/bin/open").arg("-a").arg(&app).arg(file).status()
        } else if cfg!(windows) {
            if app.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
                Command::new(&app).arg(file).spawn().map(|_| std::process::ExitStatus::default())
            } else {
                Command::new("explorer.exe").arg(file).status()
            }
        } else {
            Command::new("xdg-open").arg(file).status()
        };
        status.map(|_| ()).map_err(|e| format!("Couldn't open Claude: {e}"))
    }

    // MARK: ChatGPT (Codex settings)

    /// The config with PromptEdit's section (and any `[mcp_servers.promptedit.*]` under it) taken
    /// out. Every other line is left exactly as it was.
    pub fn removing_promptedit(text: &str) -> String {
        let mut out: Vec<&str> = vec![];
        let mut skipping = false;
        for line in text.split('\n') {
            let t = line.trim();
            if t.starts_with('[') {
                skipping = t == CODEX_HEADER || t.starts_with("[mcp_servers.promptedit.");
            }
            if !skipping {
                out.push(line);
            }
        }
        // Drop the blank lines left at the end.
        while out.last().is_some_and(|l| l.trim().is_empty()) {
            out.pop();
        }
        out.join("\n")
    }

    /// PromptEdit's section for Codex. macOS/Linux: the shell launcher; Windows: the executable
    /// itself with `--mcp --from codex` (a design choice from the spec's Windows table).
    fn codex_section(&self, launcher: &Path) -> String {
        if cfg!(windows) {
            return format!(
                "{CODEX_HEADER}\ncommand = {}\nargs = [\"--mcp\", \"--from\", \"codex\"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 300",
                toml_string(&Self::binary().to_string_lossy())
            );
        }
        format!(
            "{CODEX_HEADER}\ncommand = \"/bin/sh\"\nargs = [{}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 300",
            toml_string(&launcher.to_string_lossy())
        )
    }

    pub fn connect_codex(&self) -> Result<(), String> {
        let home = self.codex_home();
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        let launcher = self.write_launcher(&self.support_folder(), "codex")?;
        let config = self.codex_config();
        let existing = std::fs::read_to_string(&config).unwrap_or_default();
        if !existing.is_empty() {
            // A copy of their settings as they were, just in case (once).
            let backup = home.join("config.toml.before-promptedit");
            if !backup.exists() {
                std::fs::write(&backup, &existing).map_err(|e| e.to_string())?;
            }
        }
        let mut text = Self::removing_promptedit(&existing);
        if !text.is_empty() {
            text += "\n\n";
        }
        text += &self.codex_section(&launcher);
        write_atomically(&config, &text)
    }

    pub fn disconnect_codex(&self) -> Result<(), String> {
        let config = self.codex_config();
        let Ok(existing) = std::fs::read_to_string(&config) else { return Ok(()) };
        write_atomically(&config, &(Self::removing_promptedit(&existing) + "\n"))
    }

    // MARK: Claude Code

    fn run_claude_cli(&self, args: &[&str]) -> Result<(), String> {
        let cli = self.claude_cli().ok_or("Claude Code isn't installed.")?;
        let mut c = Command::new(cli);
        c.args(args).env("PATH", augmented_path());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        let out = c.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let all = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
        Err(all.lines().find(|l| !l.trim().is_empty()).unwrap_or("Claude Code couldn't make the change.").to_string())
    }

    /// The prompt "Connect another AI app" copies.
    pub fn connect_prompt() -> String {
        format!(
            "Connect to PromptEdit, the video editor on my {}, and edit only through its MCP tools (never screenshots or clicks). Its MCP server runs as the command \"{}\" with the argument --mcp (stdio; it opens PromptEdit when needed), or at http://127.0.0.1:{}/mcp (Streamable HTTP) while PromptEdit is open. Add it to your MCP settings as \"{SERVER_NAME}\" (or use the entry if it's already there). Until its tools appear in a new session, call the address directly. Then call get_project and list_media, and follow the instructions PromptEdit sends when you connect.",
            if cfg!(windows) { "PC" } else if cfg!(target_os = "macos") { "Mac" } else { "computer" },
            Self::binary().display(),
            mcp::PORT
        )
    }
}

// MARK: Helpers

pub fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn semver(v: &str) -> String {
    let mut parts: Vec<String> = v.split('.').filter(|p| p.parse::<u64>().is_ok()).map(String::from).collect();
    while parts.len() < 3 {
        parts.push("0".into());
    }
    parts[..3].join(".")
}

fn read_json(p: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("toml.promptedit-tmp");
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())
}

fn make_executable(_p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_p, std::fs::Permissions::from_mode(0o755));
    }
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.is_file() && std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// A program on PATH (with PATHEXT on Windows).
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').map(|e| e.to_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path).chain(extra_paths()) {
        for e in &exts {
            let p = dir.join(format!("{name}{e}"));
            if is_executable(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Where CLIs are usually installed, beyond what a GUI app's PATH has.
fn extra_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    if cfg!(windows) {
        vec![home.join(".local").join("bin"), dirs::data_dir().unwrap_or_default().join("npm")]
    } else {
        ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"].iter().map(PathBuf::from).chain([home.join(".local/bin")]).collect()
    }
}

/// PATH for the CLIs PromptEdit runs: the usual install places first (Editroom's augmented PATH).
pub fn augmented_path() -> std::ffi::OsString {
    let mut all = extra_paths();
    if let Some(p) = std::env::var_os("PATH") {
        all.extend(std::env::split_paths(&p));
    }
    std::env::join_paths(all).unwrap_or_default()
}

/// macOS Spotlight lookup of an app by bundle id.
fn spotlight(bundle_id: &str) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("/usr/bin/mdfind").arg(format!("kMDItemCFBundleIdentifier == \"{bundle_id}\"")).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next().filter(|l| !l.is_empty()).map(PathBuf::from)
}

fn find_file(dir: &Path, name: &str, depth: u32) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() && depth > 0 {
            if let Some(f) = find_file(&p, name, depth - 1) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == name) {
            return Some(p);
        }
    }
    None
}

/// Compares version-ish strings with numbers as numbers ("2.10" > "2.9").
fn numeric_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| s.split(|c: char| !c.is_ascii_digit()).filter_map(|p| p.parse::<u64>().ok()).collect::<Vec<_>>();
    parts(a).cmp(&parts(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_promptedit() {
        let text = "model = \"x\"\n\n[mcp_servers.other]\ncommand = \"a\"\n\n[mcp_servers.promptedit]\ncommand = \"b\"\n[mcp_servers.promptedit.env]\nA = \"1\"\n\n[features]\nx = true\n";
        let out = Agents::removing_promptedit(text);
        assert!(out.contains("[mcp_servers.other]") && out.contains("[features]\nx = true"));
        assert!(!out.contains("promptedit"));
    }

    #[test]
    fn versions() {
        assert_eq!(semver("0.1"), "0.1.0");
        assert_eq!(toml_string("C:\\a\"b"), "\"C:\\\\a\\\"b\"");
        assert_eq!(numeric_cmp("2.10.0", "2.9.1"), std::cmp::Ordering::Greater);
    }
}
