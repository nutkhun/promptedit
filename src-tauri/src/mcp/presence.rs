//! Agent cursors (Editroom's `AgentPresence` and `MCPTools.color`): after a live agent's edit, the UI
//! parks that agent's cursor, with its name, where the edit happened, for 12 seconds. The server
//! sends `agent-presence` events; `src/ui/magic/AgentCursors.tsx` draws them.

use serde::Serialize;

/// Claude in its orange, OpenAI's agents in their green, anyone else in a colour of their own.
pub fn color(name: &str) -> String {
    match name {
        "Claude" => "#D97857".into(),
        "Codex" | "ChatGPT" => "#0FA380".into(),
        "Local" => "#F2F2F2".into(),
        _ => {
            let h = super::notes::fnv1a64(name);
            let (r, g, b) = hsb((h % 360) as f64 / 360.0, 0.65, 0.95);
            format!("#{:02X}{:02X}{:02X}", (r * 255.0).round() as u8, (g * 255.0).round() as u8, (b * 255.0).round() as u8)
        }
    }
}

fn hsb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - f * s), v * (1.0 - (1.0 - f) * s));
    match (i as i64).rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

/// One edit by an agent, for its cursor.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub name: String,
    pub color: String,
    /// What the cursor's tag says ("✂ Cut", "Trim", "−12 dB").
    pub label: String,
    /// Timeline seconds where it happened, and the track ("V1"), if it was on the timeline.
    pub time: Option<f64>,
    pub track: Option<String>,
    pub clip_ids: Vec<String>,
    /// How long the cursor stays (seconds); Editroom's 12.
    pub linger: f64,
}

impl Presence {
    pub fn new(name: &str, label: &str) -> Self {
        Presence { name: name.into(), color: color(name), label: label.into(), time: None, track: None, clip_ids: vec![], linger: 12.0 }
    }
}
