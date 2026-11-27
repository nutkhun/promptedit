//! Reading a tool's arguments, with Editroom's error messages. Numbers may be JSON integers or
//! doubles everywhere (Swift bridges both to Double).

use super::ToolError;
use promptedit_core::{Clip, Id, MediaAsset, Project, Rgba, TrackKind};
use serde_json::Value;

pub fn num(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(Value::as_f64)
}

pub fn int(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)))
}

pub fn num_req(args: &Value, key: &str) -> Result<f64, ToolError> {
    num(args, key).ok_or_else(|| format!("{key} is needed, in seconds.").into())
}

pub fn string<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

pub fn boolean(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

pub fn strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// A library item by its id (any case) or its exact name.
pub fn asset_arg(args: &Value, p: &Project) -> Result<MediaAsset, ToolError> {
    let s = string(args, "asset_id").ok_or("asset_id is needed (see list_media).")?;
    let id: Option<Id> = s.parse().ok();
    p.assets
        .iter()
        .find(|a| Some(a.id) == id || a.name == s)
        .cloned()
        .ok_or_else(|| format!("No library item with id {s}. list_media has them.").into())
}

pub fn clip_arg(args: &Value, p: &Project) -> Result<Clip, ToolError> {
    let s = string(args, "clip_id").ok_or("clip_id is needed (see get_project).")?;
    let c = s.parse::<Id>().ok().and_then(|id| p.clip(id)).ok_or_else(|| ToolError(format!("No clip with id {s}. get_project has them.")))?;
    if p.is_locked(c.track_id) {
        return Err("That clip is on a locked track.".into());
    }
    Ok(c.clone())
}

/// `V1`/`A2` (1-based, any case) to a track id of that kind.
pub fn track_arg(name: &str, p: &Project, kind: TrackKind) -> Result<Id, ToolError> {
    let n = name.trim().to_uppercase();
    let prefix = if kind == TrackKind::Video { "V" } else { "A" };
    let i = n.strip_prefix(prefix).and_then(|r| r.parse::<usize>().ok()).filter(|i| *i >= 1).ok_or_else(|| {
        ToolError(format!(
            "{name} isn't a {}.",
            if kind == TrackKind::Video { "video track (V1, V2…)" } else { "audio track (A1, A2…)" }
        ))
    })?;
    let tracks = p.tracks(kind);
    if i > tracks.len() {
        return Err(format!("There's no {n}; there are {}. add_track adds one.", tracks.len()).into());
    }
    if tracks[i - 1].locked {
        return Err(format!("{n} is locked.").into());
    }
    Ok(tracks[i - 1].id)
}

/// `#RRGGBB` or `RRGGBB`; None when not given.
pub fn color_arg(v: Option<&Value>) -> Result<Option<Rgba>, ToolError> {
    let Some(s) = v.and_then(Value::as_str).map(str::trim) else { return Ok(None) };
    let h = s.strip_prefix('#').unwrap_or(s);
    let n = (h.len() == 6).then(|| u32::from_str_radix(h, 16).ok()).flatten().ok_or("Colours are hex, like #FF4A1C.")?;
    Ok(Some(Rgba { r: (n >> 16 & 255) as f64 / 255.0, g: (n >> 8 & 255) as f64 / 255.0, b: (n & 255) as f64 / 255.0, a: 1.0 }))
}

/// Clip ids in the project's own order (so results don't depend on hashing).
pub fn ordered(p: &Project, ids: &std::collections::HashSet<Id>) -> Vec<Id> {
    p.clips.iter().filter(|c| ids.contains(&c.id)).map(|c| c.id).collect()
}

pub fn one(id: Id) -> std::collections::HashSet<Id> {
    [id].into_iter().collect()
}
