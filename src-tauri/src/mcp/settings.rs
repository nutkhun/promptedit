//! The settings the server itself needs (Editroom keeps them in UserDefaults): whether AI apps may
//! edit ("Let AI apps edit in PromptEdit", `agentsEnabled`) and whether the Claude app was
//! disconnected (`claudeAppDisconnected`). Kept in `<data dir>/agents.json`; everything else about
//! Magic is a UI preference kept by the UI.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentSettings {
    pub agents_enabled: bool,
    pub claude_app_disconnected: bool,
}

impl Default for AgentSettings {
    fn default() -> Self {
        AgentSettings { agents_enabled: true, claude_app_disconnected: false }
    }
}

static CACHE: Mutex<Option<AgentSettings>> = Mutex::new(None);

fn file() -> std::path::PathBuf {
    super::data_dir().join("agents.json")
}

pub fn get() -> AgentSettings {
    let mut c = CACHE.lock().unwrap();
    if let Some(s) = c.as_ref() {
        return s.clone();
    }
    let s: AgentSettings = std::fs::read(file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    *c = Some(s.clone());
    s
}

pub fn update(change: impl FnOnce(&mut AgentSettings)) -> AgentSettings {
    let mut s = get();
    change(&mut s);
    let path = file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&s) {
        let _ = std::fs::write(&path, bytes);
    }
    *CACHE.lock().unwrap() = Some(s.clone());
    s
}
