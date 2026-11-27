//! What someone points at when they ask Magic for something (Editroom's `MagicPointers`,
//! `MagicMention` and `MagicTimes`): the playhead, the selection and the in/out range when they
//! pressed Make it; `@playhead`, `@selected`, `@in-out`, `@<file>`, `@clip:<label>`, `@marker:<name>`
//! typed in the box; and times typed in the request ("between 0:05 and 0:08").
//!
//! Ranges here are byte ranges into the text (the UI does its own highlighting).

use promptedit_core::{Clip, ClipKind, Id, MarkerTint, MediaAsset, Project};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pointers {
    pub playhead: f64,
    /// Selected clips, in timeline order.
    pub selected: Vec<Id>,
    pub range: Option<(f64, f64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mention {
    Playhead,
    Selected,
    Range,
    Media(Id),
    Clip(Id),
    Marker(Id),
}

#[derive(Clone, Debug)]
pub struct ClipLabel {
    pub id: Id,
    pub name: String,
    pub kind: ClipKind,
    pub track: String,
    pub start: f64,
}

#[derive(Clone, Debug)]
pub struct MarkerLabel {
    pub id: Id,
    pub name: String,
    pub time: f64,
    pub tint: MarkerTint,
}

/// Where a track sits for sorting: video tracks top to bottom, then audio.
pub fn track_order(p: &Project, id: Id) -> usize {
    if let Some(i) = p.video_tracks.iter().position(|t| t.id == id) {
        return p.video_tracks.len() - i;
    }
    p.video_tracks.len() + 1 + p.audio_tracks.iter().position(|t| t.id == id).unwrap_or(0)
}

fn track_name(p: &Project, c: &Clip) -> String {
    crate::mcp::json::track_name(c.track_id, p)
}

pub fn marker_labels(p: &Project) -> Vec<MarkerLabel> {
    let mut seen: std::collections::HashMap<String, usize> = Default::default();
    p.marker_list()
        .into_iter()
        .map(|m| {
            let own = m.name.trim().to_string();
            let b = if own.is_empty() {
                let t = crate::mcp::json::tint_name(m.tint);
                t[..1].to_uppercase() + &t[1..] + " marker"
            } else {
                own
            };
            let n = seen.entry(b.to_lowercase()).or_insert(0);
            *n += 1;
            MarkerLabel { id: m.id, name: if *n == 1 { b } else { format!("{b}·{n}") }, time: m.time, tint: m.tint }
        })
        .collect()
}

/// Clips as `@clip:` names them; a video's own sound isn't listed apart from it.
pub fn clip_labels(p: &Project) -> Vec<ClipLabel> {
    let video_links: std::collections::HashSet<Id> = p.clips.iter().filter(|c| c.kind != ClipKind::Audio).filter_map(|c| c.link_id).collect();
    let mut clips: Vec<&Clip> = p.clips.iter().filter(|c| !(c.kind == ClipKind::Audio && c.link_id.is_some_and(|l| video_links.contains(&l)))).collect();
    clips.sort_by(|a, b| (a.start, track_order(p, a.track_id)).partial_cmp(&(b.start, track_order(p, b.track_id))).unwrap());
    let mut seen: std::collections::HashMap<String, usize> = Default::default();
    clips
        .into_iter()
        .map(|c| {
            let n = p.name_of(c).trim().to_string();
            let b = if c.kind == ClipKind::Text && n.chars().count() > 24 { n.chars().take(22).collect::<String>().trim().to_string() + "…" } else { n };
            let k = seen.entry(b.to_lowercase()).or_insert(0);
            *k += 1;
            ClipLabel { id: c.id, name: if *k == 1 { b } else { format!("{b}·{k}") }, kind: c.kind, track: track_name(p, c), start: c.start }
        })
        .collect()
}

/// A time as a clock ("0:12.4", "1:02:03.5") that `times` reads back as the same place.
pub fn clock(t: f64) -> String {
    let t = ((t * 100.0).round() / 100.0).max(0.0);
    let (h, m) = ((t as i64) / 3600, (t as i64) % 3600 / 60);
    let mut sec = format!("{:05.2}", t % 60.0);
    while sec.ends_with('0') {
        sec.pop();
    }
    if sec.ends_with('.') {
        sec.pop();
    }
    if h > 0 { format!("{h}:{m:02}:{sec}") } else { format!("{m}:{sec}") }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Every mention in the text, in order, with its byte range. A file's name counts with or without
/// its extension; the longest name that fits wins.
pub fn find(text: &str, media: &[MediaAsset], clips: &[ClipLabel], markers: &[MarkerLabel]) -> Vec<(std::ops::Range<usize>, Mention)> {
    if !text.contains('@') {
        return vec![];
    }
    let mut names: Vec<(String, Mention)> =
        vec![("playhead".into(), Mention::Playhead), ("selected".into(), Mention::Selected), ("in-out".into(), Mention::Range)];
    for a in media {
        names.push((a.name.clone(), Mention::Media(a.id)));
        let bare = std::path::Path::new(&a.name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if !bare.is_empty() && bare != a.name {
            names.push((bare, Mention::Media(a.id)));
        }
    }
    let by_len = |v: &mut Vec<(String, Mention)>| v.sort_by_key(|n| std::cmp::Reverse(n.0.chars().count()));
    let marker_names: Vec<(String, Mention)> = markers.iter().map(|m| (m.name.clone(), Mention::Marker(m.id))).collect();
    by_len(&mut names);
    // Markers by name too ("@Jump"); a file of the same name wins (stable sort keeps files first).
    let mut with_markers = names.clone();
    with_markers.extend(marker_names.clone());
    by_len(&mut with_markers);
    let mut clip_names: Vec<(String, Mention)> = clips.iter().map(|c| (c.name.clone(), Mention::Clip(c.id))).collect();
    by_len(&mut clip_names);
    let mut sorted_markers = marker_names;
    by_len(&mut sorted_markers);
    let lower = text.to_lowercase();
    // Lowercasing can change byte lengths for some scripts; fall back to exact matching then.
    let same_len = lower.len() == text.len();
    let starts = |word: &str, at: usize| -> bool {
        let w = word.to_lowercase();
        if same_len { lower.get(at..).is_some_and(|r| r.starts_with(&w)) } else { text.get(at..).is_some_and(|r| r.starts_with(word)) }
    };
    let mut out = vec![];
    let mut i = 0;
    while let Some(rel) = text.get(i..).and_then(|r| r.find('@')) {
        let at = i + rel;
        i = at + 1;
        // Not the middle of an address ("me@example.com").
        if text[..at].chars().next_back().is_some_and(is_word) {
            continue;
        }
        let mut from = i;
        let pool: Vec<(String, Mention)> = if starts("marker:", i) {
            from += 7;
            sorted_markers.clone()
        } else if starts("media:", i) {
            from += 6;
            names.iter().filter(|n| matches!(n.1, Mention::Media(_))).cloned().collect()
        } else if starts("clip:", i) {
            from += 5;
            clip_names.clone()
        } else {
            with_markers.clone()
        };
        for (name, m) in pool {
            if !starts(&name, from) {
                continue;
            }
            let end = from + name.len();
            // The whole name: "@intro" isn't "@introduction".
            if text.get(end..).and_then(|r| r.chars().next()).is_some_and(is_word) {
                continue;
            }
            out.push((at..end, m));
            i = end;
            break;
        }
    }
    out
}

/// The request with each marker it names written as the marker's time.
pub fn markers_as_times(text: &str, p: &Project) -> String {
    let marks = marker_labels(p);
    if marks.is_empty() {
        return text.to_string();
    }
    let mut s = text.to_string();
    for (r, m) in find(text, &p.assets, &clip_labels(p), &marks).into_iter().rev() {
        if let Mention::Marker(id) = m
            && let Some(l) = marks.iter().find(|l| l.id == id)
        {
            s.replace_range(r, &clock(l.time));
        }
    }
    s
}

/// The request in plain words, for a reader that doesn't know about mentions.
pub fn plain(text: &str, p: &Project) -> String {
    let clips = clip_labels(p);
    let marks = marker_labels(p);
    let mut s = text.to_string();
    for (r, m) in find(text, &p.assets, &clips, &marks).into_iter().rev() {
        let words = match m {
            Mention::Playhead => "the playhead".to_string(),
            Mention::Selected => "the selected clips".into(),
            Mention::Range => "the marked range".into(),
            Mention::Media(id) => p.asset(Some(id)).map(|a| a.name.clone()).unwrap_or_else(|| text[r.clone()].to_string()),
            Mention::Clip(id) => format!("the clip {}", clips.iter().find(|c| c.id == id).map(|c| c.name.as_str()).unwrap_or("")),
            Mention::Marker(id) => marks.iter().find(|l| l.id == id).map(|l| clock(l.time)).unwrap_or_else(|| text[r.clone()].to_string()),
        };
        s.replace_range(r, &words);
    }
    s
}

// MARK: Times

#[derive(Clone, Debug, PartialEq)]
pub struct Typed {
    pub range: std::ops::Range<usize>,
    pub text: String,
    pub seconds: f64,
    /// "5s" or "5 seconds": only a time when it's part of a span.
    pub unit_only: bool,
}

static PATTERNS: LazyLock<[(Regex, bool); 4]> = LazyLock::new(|| {
    [
        // hh:mm:ss:ff, as the viewer shows it.
        (Regex::new(r"(\d{1,2}):(\d{2}):(\d{2})[;:](\d{2})").unwrap(), false),
        // h:mm:ss
        (Regex::new(r"(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)").unwrap(), false),
        // m:ss
        (Regex::new(r"(\d{1,3}):(\d{2}(?:\.\d+)?)").unwrap(), false),
        // 5s, 5 sec, 5 seconds
        (Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b").unwrap(), true),
    ]
});

/// Times typed in a request, in order.
pub fn times(text: &str, fps: f64) -> Vec<Typed> {
    let mut out: Vec<Typed> = vec![];
    let before_ok = |at: usize| !text[..at].chars().next_back().is_some_and(|c| c.is_ascii_digit() || c == ':' || c == '.');
    let after_ok = |end: usize| !text[end..].chars().next().is_some_and(|c| c.is_ascii_digit() || c == ':');
    for (k, (re, unit_only)) in PATTERNS.iter().enumerate() {
        for caps in re.captures_iter(text) {
            let m = caps.get(0).unwrap();
            // The lookarounds Editroom's patterns have: not inside a longer number or clock.
            if !before_ok(m.start()) || (!unit_only && !after_ok(m.end())) {
                continue;
            }
            // The first, longest pattern that matched there wins.
            if out.iter().any(|o| o.range.start < m.end() && m.start() < o.range.end) {
                continue;
            }
            let parts: Vec<f64> = (1..caps.len()).filter_map(|i| caps.get(i)?.as_str().parse().ok()).collect();
            let seconds = match k {
                0 => parts[0] * 3600.0 + parts[1] * 60.0 + parts[2] + parts[3] / fps.max(1.0),
                1 => parts[0] * 3600.0 + parts[1] * 60.0 + parts[2],
                2 => parts[0] * 60.0 + parts[1],
                _ => parts[0],
            };
            out.push(Typed { range: m.start()..m.end(), text: m.as_str().to_string(), seconds, unit_only: *unit_only });
        }
    }
    out.sort_by_key(|t| t.range.start);
    out
}

const CONNECTORS: [&str; 8] = ["and", "to", "-", "–", "—", "through", "until", "till"];

/// A span they typed: "between A and B", "from A to B" (or A to B / A–B with two clock times).
pub fn span(text: &str, fps: f64) -> Option<(f64, f64, String)> {
    let found = times(text, fps);
    for w in found.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if b.range.start < a.range.end {
            continue;
        }
        let gap = text[a.range.end..b.range.start].trim().to_lowercase();
        if !CONNECTORS.contains(&gap.as_str()) {
            continue;
        }
        let before: String = text[..a.range.start].to_lowercase();
        let tail: String = before.chars().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
        let introduced = tail.ends_with("between ") || tail.ends_with("from ");
        if !(introduced || (!a.unit_only && !b.unit_only)) || b.seconds <= a.seconds {
            continue;
        }
        let from = if introduced { if tail.ends_with("between ") { 8 } else { 5 } } else { 0 };
        let start = a.range.start - from;
        return Some((a.seconds, b.seconds, text[start..b.range.end].to_string()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use promptedit_core::MediaKind;

    fn asset(name: &str) -> MediaAsset {
        MediaAsset {
            id: Id::new(),
            path: format!("/m/{name}"),
            relative_path: None,
            playable_path: None,
            name: name.into(),
            kind: MediaKind::Video,
            duration: 10.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            bookmark: None,
        }
    }

    #[test]
    fn finds_mentions() {
        let a = asset("beach.mov");
        let b = asset("beach day.mov");
        let found = find("use @beach day and @selected, not me@example.com @beach.mov", &[a.clone(), b.clone()], &[], &[]);
        let ms: Vec<Mention> = found.iter().map(|f| f.1).collect();
        assert_eq!(ms, vec![Mention::Media(b.id), Mention::Selected, Mention::Media(a.id)]);
        assert!(find("@beachy", &[a], &[], &[]).is_empty(), "whole names only");
    }

    #[test]
    fn reads_times() {
        let t = times("cut 0:05 and 00:00:05:15 then 1:02:03", 30.0);
        assert_eq!(t.iter().map(|t| t.seconds).collect::<Vec<_>>(), vec![5.0, 5.5, 3723.0]);
        assert_eq!(span("speed up between 5s and 8 seconds", 30.0).map(|s| (s.0, s.1)), Some((5.0, 8.0)));
        assert_eq!(span("0:05 to 0:09", 30.0).unwrap().2, "0:05 to 0:09");
        assert!(span("make it 5s to 8s", 30.0).is_none());
        assert_eq!(clock(72.4), "1:12.4");
        assert_eq!(clock(3723.5), "1:02:03.5");
    }
}
