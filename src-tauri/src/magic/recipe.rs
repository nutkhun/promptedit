//! Reading a typed request into settings for Local Magic (Editroom's `LocalRecipe` and `LocalBrain`).
//!
//! Editroom asks Apple's on-device model to fill in a `RecipeOut` and then checks every field
//! against the words of the request (`checked`). PromptEdit asks a local model through Ollama's
//! HTTP API on this computer, when one is running, with the same instructions and a JSON schema
//! for the same fields; without one, a keyword reader fills the fields from the same vocabularies
//! `checked` uses. Either way `checked` and `apply_media` run after, unchanged.

use promptedit_core::{Id, MediaAsset, MediaKind, Project};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pace {
    #[default]
    Unchanged,
    Calm,
    Fast,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Music {
    #[default]
    Unchanged,
    Off,
    Add,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Frame {
    #[default]
    Unchanged,
    Vertical,
    Horizontal,
    Square,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Recipe {
    pub seconds: Option<f64>,
    pub pace: Pace,
    /// A built-in look for every shot; "none" takes looks off; None leaves colour alone.
    pub look: Option<String>,
    pub music: Music,
    pub frame: Frame,
    pub cannot_do: String,
    pub keep_only: HashSet<Id>,
    pub take_out: HashSet<Id>,
    pub media_names: Vec<String>,
    /// "Nothing else on the timeline": with keep_only, titles, overlays and music go too.
    pub clear_rest: bool,
    /// Where the things they asked for show in each file.
    pub moments: HashMap<Id, Vec<f64>>,
    pub shown: Vec<Id>,
    pub asked: String,
    pub whole_library: bool,
    pub shots: Option<usize>,
    pub every: bool,
    pub only_asked: bool,
    pub speed: Option<f64>,
    pub sound_effects: bool,
    pub asked_judgement: bool,
    pub title: Option<String>,
    pub title_at_end: bool,
    pub level_audio: bool,
    pub level_gains: HashMap<Id, f64>,
    pub level_silent: Vec<String>,
}

impl Recipe {
    /// Asks for nothing Local can do: it shouldn't edit anything.
    pub fn is_empty(&self) -> bool {
        self.seconds.is_none()
            && self.pace == Pace::Unchanged
            && self.look.is_none()
            && self.music == Music::Unchanged
            && self.frame == Frame::Unchanged
            && self.keep_only.is_empty()
            && self.take_out.is_empty()
            && self.speed.is_none()
            && !self.sound_effects
            && !self.level_audio
            && self.title.is_none()
            && !self.whole_library
            && self.shots.is_none()
    }
    pub fn only_levels(&self) -> bool {
        self.level_audio
            && self.seconds.is_none()
            && self.pace == Pace::Unchanged
            && self.music == Music::Unchanged
            && self.frame == Frame::Unchanged
            && self.keep_only.is_empty()
            && self.take_out.is_empty()
            && self.speed.is_none()
            && !self.sound_effects
    }
    pub fn is_focused(&self) -> bool {
        !self.keep_only.is_empty() || !self.take_out.is_empty() || self.only_asked
    }
    /// "20s, fast, Mono, no music, vertical", for the note.
    pub fn summary(&self) -> String {
        let mut parts = vec![];
        if let Some(s) = self.seconds {
            parts.push(format!("{}s", s as i64));
        }
        match self.pace {
            Pace::Calm => parts.push("calm".into()),
            Pace::Fast => parts.push("fast".into()),
            Pace::Unchanged => {}
        }
        if let Some(l) = &self.look {
            parts.push(if l == "none" { "no look".into() } else { l.clone() });
        }
        match self.music {
            Music::Off => parts.push("no music".into()),
            Music::Add => parts.push("music added".into()),
            Music::Unchanged => {}
        }
        match self.frame {
            Frame::Vertical => parts.push("vertical".into()),
            Frame::Horizontal => parts.push("horizontal".into()),
            Frame::Square => parts.push("square".into()),
            Frame::Unchanged => {}
        }
        if let Some(s) = self.speed {
            parts.push(format!("speed ×{}", crate::mcp::tools::fmt_g(s)));
        }
        parts.join(", ")
    }
}

pub const LOOKS: [&str; 9] = ["Warm film", "Golden hour", "Film print", "Teal and orange", "Pastel", "Bleach bypass", "Mono", "Cool night", "Faded"];

fn has(t: &str, words: &[&str]) -> bool {
    words.iter().any(|w| t.contains(w))
}

/// A general request to make it better, which Local's own improvement is for.
pub fn is_general(request: &str) -> bool {
    has(
        &request.to_lowercase(),
        &["improve", "better", "tighten", "tidy", "clean", "polish", "fix", "best", "nicer", "good", "shorter", "trim", "cut it down", "make it work", "edit it", "magic", "beat", "rhythm", "recut", "re-cut", "re-edit"],
    )
}

pub fn asks_judgement(request: &str) -> bool {
    let t = request.to_lowercase();
    t.contains('?')
        || has(&t, &["do you think", "should i", "should we", "would it", "if so", "if you think", "worth", "any good", "makes sense", "if it fits", "where it fits", "if needed", "only if"])
}

/// How many shots or clips they asked for: "at least 10 clips", "12 shots", "ten cuts".
pub fn shot_count(request: &str) -> Option<usize> {
    let mut t = request.to_lowercase();
    for (w, n) in [("two", 2), ("three", 3), ("four", 4), ("five", 5), ("six", 6), ("seven", 7), ("eight", 8), ("nine", 9), ("ten", 10), ("eleven", 11), ("twelve", 12), ("fifteen", 15), ("twenty", 20), ("thirty", 30)] {
        t = Regex::new(&format!(r"\b{w}\b")).unwrap().replace_all(&t, n.to_string()).into_owned();
    }
    let re = Regex::new(r"(\d+)\s*(\+\s*)?(different |unique |separate |short |quick |fast )?(clips|shots|cuts|scenes|videos)").unwrap();
    let n: usize = re.captures(&t)?.get(1)?.as_str().parse().ok()?;
    (2..=200).contains(&n).then_some(n)
}

pub fn wants_every(request: &str) -> bool {
    let t = request.to_lowercase();
    let things = "(clips|videos|shots|footage|media|files)";
    Regex::new(&format!(r"\b(all|every one of|each of)\s+(of\s+)?(the\s+|my\s+|our\s+)?{things}")).unwrap().is_match(&t)
        || Regex::new(r"\b(every|each)\s+(single\s+)?(clip|video|shot|file)\b").unwrap().is_match(&t)
}

pub fn wants_library(request: &str) -> bool {
    has(
        &request.to_lowercase(),
        &["most of the clips", "most clips", "all the clips", "all clips", "all of the clips", "all my clips", "every clip", "more clips", "more shots", "other clips", "other shots", "the rest of the clips", "whole library", "all my media", "media folder", "all the media", "all of my", "from scratch", "start over", "make a new", "create a new", "new video", "new cut", "new edit", "create ", "montage"],
    )
}

/// Words they put in quotes: "…" or “…”, or '…' / ‘…’ only as a pair around words.
pub fn quoted_words(request: &str) -> Option<String> {
    let patterns = [r#""([^"]{1,120})""#, r"“([^”]{1,120})”"];
    for p in patterns {
        if let Some(c) = Regex::new(p).unwrap().captures(request) {
            let w = c.get(1)?.as_str().trim().to_string();
            if !w.is_empty() {
                return Some(w);
            }
        }
    }
    // '…' only around words: opened after a space (or at the start) and closed before a space or
    // punctuation, so an apostrophe inside a word doesn't count.
    for (open, close) in [('\'', '\''), ('‘', '’')] {
        let chars: Vec<(usize, char)> = request.char_indices().collect();
        for (k, (i, c)) in chars.iter().enumerate() {
            if *c != open || (k > 0 && !chars[k - 1].1.is_whitespace()) {
                continue;
            }
            for (m, (j, d)) in chars.iter().enumerate().skip(k + 1) {
                let next = chars.get(m + 1).map(|x| x.1);
                if *d == close && next.is_none_or(|n| n.is_whitespace() || ".,!?;:".contains(n)) {
                    let w = request[i + open.len_utf8()..*j].trim();
                    if !w.is_empty() && w.chars().count() <= 120 {
                        return Some(w.to_string());
                    }
                    break;
                }
            }
        }
    }
    None
}

/// The title they asked for: their quoted words, or "" for placeholder words to type over.
pub fn title_asked(request: &str) -> Option<String> {
    let t = request.to_lowercase();
    let quoted = quoted_words(request).is_some();
    let asks = (quoted && t.contains("caption"))
        || has(&t, &["title", "heading", "text on", "words on", "add text", "put text", "some text", "call it", "name it", "text saying", "text that says"]);
    let refuses = has(&t, &["no title", "without a title", "without title", "no text", "without text", "remove the title", "take out the title"]);
    if !asks || refuses {
        return None;
    }
    Some(quoted_words(request).unwrap_or_default())
}

pub fn wants_sound_effects(request: &str) -> bool {
    has(&request.to_lowercase(), &["sfx", "sound effect", "sound fx", "soundfx", "fx sound", "whoosh", "swoosh", "foley", "sound design"])
}

pub fn wants_levels(request: &str) -> bool {
    let t = request.to_lowercase();
    let about = has(&t, &["audio", "sound", "volume", "loud", "level", "clip", "voice", "music", "db"]);
    let even = has(&t, &["equaliz", "equalis", "normaliz", "normalis", "even out", "same level", "same volume", "same loudness", "same output", "consistent", "match", "balance", "level out", "level the", "levels the same", "too quiet and"]);
    about && even
}

pub fn speed(request: &str) -> Option<f64> {
    let t = request.to_lowercase();
    let about = has(&t, &["speed", "faster", "slower", "fast", "slow", "sped", "timelapse", "time lapse", "playback"]);
    if has(&t, &["slow motion", "slow-mo", "slowmo"]) {
        return Some(0.5);
    }
    if has(&t, &["double speed", "twice as fast"]) {
        return Some(2.0);
    }
    if has(&t, &["half speed", "half as fast"]) {
        return Some(0.5);
    }
    if has(&t, &["normal speed", "real time", "realtime"]) {
        return Some(1.0);
    }
    if !about {
        return None;
    }
    if let Some(c) = Regex::new(r"(\d+(\.\d+)?)\s*%").unwrap().captures(&t) {
        return c[1].parse::<f64>().ok().map(|n| (n / 100.0).clamp(0.05, 100.0));
    }
    if let Some(c) = Regex::new(r"(\d+(\.\d+)?)\s*(x|times)\b").unwrap().captures(&t) {
        return c[1].parse::<f64>().ok().map(|n| n.clamp(0.05, 100.0));
    }
    None
}

/// Library items a request names: "IMG_1607", "img_1607", "IMG_1607.mov" or just "1607".
pub fn named(request: &str, media: &[MediaAsset]) -> Vec<MediaAsset> {
    let text = request.to_lowercase();
    let words: HashSet<String> = text.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-').filter(|w| !w.is_empty()).map(String::from).collect();
    media
        .iter()
        .filter(|a| {
            let name = a.name.to_lowercase();
            let bare = std::path::Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if bare.chars().count() >= 3 {
                // The whole name as its own word(s), not inside another ("intro" isn't in "introduce").
                let mut from = 0;
                while let Some(i) = text[from..].find(&bare) {
                    let s = from + i;
                    let e = s + bare.len();
                    let before = text[..s].chars().next_back().is_some_and(char::is_alphanumeric);
                    let after = text[e..].chars().next().is_some_and(char::is_alphanumeric);
                    if !before && !after {
                        return true;
                    }
                    from = s + bare.len().max(1);
                }
            }
            // A number in the name on its own, like "1607" for IMG_1607 (three digits or more).
            bare.split(|c: char| !c.is_ascii_digit()).filter(|n| n.len() >= 3).any(|n| words.contains(n))
        })
        .cloned()
        .collect()
}

/// Media named in a request, kept only or taken out (Editroom's `applyMedia`).
pub fn apply_media(r: &mut Recipe, named: &[MediaAsset], action: &str, request: &str, pointed: &HashSet<Id>, has_edit: bool) {
    if named.is_empty() {
        return;
    }
    let text = request.to_lowercase();
    let only = has(&text, &["only", "just ", "nothing else", "nothing but", "except", "solely", "keep ", "use the ", "using the "]);
    let remove = has(&text, &["remove", "take out", "without", "delete", "drop", "get rid", "cut out", "no more", "lose "]);
    let explicit = named.iter().all(|a| pointed.contains(&a.id));
    let everyday = named.iter().all(|a| {
        std::path::Path::new(&a.name).file_stem().map(|s| s.to_string_lossy().chars().all(|c| c.is_alphabetic() || c == ' ')).unwrap_or(false)
    });
    if everyday && !explicit && !only && !remove {
        return;
    }
    let among_others = has(&text, &["also", " too", "include", "as well", "most", "all ", "every", "the rest", "other"]);
    let picked = if !explicit && action == "remove" && !remove { "only" } else { action };
    let fallback = if has_edit {
        "unchanged"
    } else if !explicit {
        picked
    } else if !among_others && action != "remove" {
        "only"
    } else {
        "unchanged"
    };
    let mode = if only && !remove {
        "only"
    } else if remove && !only {
        "remove"
    } else {
        fallback
    };
    let ids: HashSet<Id> = named.iter().map(|a| a.id).collect();
    match mode {
        "only" => r.keep_only = ids,
        "remove" => r.take_out = ids,
        _ => return,
    }
    r.media_names = named.iter().map(|a| a.name.clone()).collect();
    r.clear_rest = mode == "only" && has(&text, &["nothing else", "everything else", "anything else", "on the timeline", "on timeline"]);
    let lower: Vec<String> = named.iter().map(|a| a.name.to_lowercase()).collect();
    if lower.iter().any(|n| r.cannot_do.to_lowercase().contains(n.as_str())) {
        r.cannot_do.clear();
    }
}

const LENGTH_WORDS: [&str; 8] = ["second", "sec", "minute", "min", "long", "short", "length", "s "];
const PACE_WORDS: [&str; 14] = ["pace", "pacing", "calm", "slow", "relax", "chill", "gentle", "fast", "quick", "punch", "snappy", "energ", "rhythm", "tempo"];
const LOOK_WORDS: [&str; 26] = ["look", "grade", "colour", "color", "film", "warm", "cool", "mono", "black and white", "b&w", "bw", "vintage", "fade", "pastel", "teal", "orange", "golden", "night", "bleach", "filter", "tone", "cinematic", "moody", "natural", "lut", "print"];
const MUSIC_WORDS: [&str; 7] = ["music", "song", "soundtrack", "track", "tune", "audio", "beat"];
const FRAME_WORDS: [&str; 17] = ["vertical", "portrait", "tiktok", "tik tok", "reel", "shorts", "story", "stories", "phone", "horizontal", "landscape", "widescreen", "youtube", "square", "instagram", "9:16", "16:9"];

/// A setting only stands if the request talks about that kind of thing; a "can't do" only if it's
/// about something they said that the settings don't cover (Editroom's `checked`).
pub fn checked(r: &Recipe, request: &str) -> Recipe {
    let text = request.to_lowercase();
    let says = |w: &[&str]| has(&text, w);
    let mut out = r.clone();
    let timed = Regex::new(r"\d+(\.\d+)?\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b|\d+:\d\d").unwrap().is_match(&text);
    let worded = says(&["long", "length", "duration"]) && text.chars().any(|c| c.is_ascii_digit());
    if out.seconds.is_some() && !(timed || worded) {
        out.seconds = None;
    }
    if out.pace != Pace::Unchanged && !says(&PACE_WORDS) {
        out.pace = Pace::Unchanged;
    }
    if out.look.is_some() && !says(&LOOK_WORDS) {
        out.look = None;
    }
    if out.music != Music::Unchanged && !says(&MUSIC_WORDS) {
        out.music = Music::Unchanged;
    }
    if out.music == Music::Off && !says(&["no ", "without", "remove", "off", "mute", "silent", "drop", "take out"]) {
        out.music = Music::Unchanged;
    }
    if out.frame != Frame::Unchanged && !(says(&FRAME_WORDS) || text.contains("1:1")) {
        out.frame = Frame::Unchanged;
    }
    let mut handled: Vec<&str> = vec![];
    if out.music != Music::Unchanged {
        handled.extend(MUSIC_WORDS);
    }
    if out.look.is_some() {
        handled.extend(LOOK_WORDS);
    }
    if out.frame != Frame::Unchanged {
        handled.extend(FRAME_WORDS);
    }
    if out.pace != Pace::Unchanged {
        handled.extend(PACE_WORDS);
    }
    if out.seconds.is_some() {
        handled.extend(LENGTH_WORDS);
    }
    let request_words: HashSet<String> = text.split(|c: char| !c.is_alphabetic()).filter(|w| w.chars().count() >= 4).map(String::from).collect();
    let kept: Vec<String> = r
        .cannot_do
        .split(',')
        .flat_map(|p| p.split(" and "))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .filter(|part| {
            let p = part.to_lowercase();
            let shares = p.split(|c: char| !c.is_alphabetic()).filter(|w| w.chars().count() >= 4).any(|w| {
                let pre: String = w.chars().take(5).collect();
                request_words.iter().any(|rw| rw.starts_with(&pre))
            });
            shares && !handled.iter().any(|h| p.contains(h))
        })
        .map(String::from)
        .collect();
    out.cannot_do = kept.join(", ");
    out
}

// MARK: Readers

/// The fields a reader fills in (Editroom's `@Generable RecipeOut`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RecipeOut {
    pub seconds: i64,
    pub pace: String,
    pub look: String,
    pub music: String,
    pub frame: String,
    pub cannot_do: String,
    pub media_action: String,
}

/// Editroom's instructions for the on-device model, verbatim but for the app.
pub fn instructions(media: &[MediaAsset]) -> String {
    format!(
        "You turn a person's request for editing their video into settings. Set a field ONLY if their words ask for it; every other field stays \"unchanged\" (seconds stays 0). Most requests change one or two fields. The editor can only: set a length, make the pacing calm or fast, put one colour look on every shot or take looks off, turn music off or add music from their library, and make the frame vertical, horizontal or square. If they ask for something else (sound effects, a title or text, a particular story, effects), write just that in cannotDo, in their words; otherwise leave cannotDo empty. Never mention anything they didn't ask for. Their media files are: {}. If they name files to use only those, mediaAction is \"only\"; to take them out, \"remove\". Naming files isn't something to put in cannotDo.",
        media.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
    )
}

/// The JSON schema the local model's reply is held to (the `@Guide`s as enums and a range).
pub fn schema() -> serde_json::Value {
    let mut looks = vec!["unchanged", "none"];
    looks.extend(LOOKS);
    serde_json::json!({
        "type": "object",
        "description": "Settings for editing a video, from the person's request",
        "properties": {
            "seconds": {"type": "integer", "minimum": 0, "maximum": 900, "description": "How long the video should be, in seconds; 0 if they didn't say"},
            "pace": {"type": "string", "enum": ["unchanged", "calm", "fast"], "description": "Pacing: calm (longer, slower shots), fast (short, punchy shots), or unchanged"},
            "look": {"type": "string", "enum": looks, "description": "One colour look for every shot, none to take looks off, or unchanged"},
            "music": {"type": "string", "enum": ["unchanged", "off", "add"], "description": "Music: off to remove it, add to put a song from their library under it, or unchanged"},
            "frame": {"type": "string", "enum": ["unchanged", "vertical", "horizontal", "square"], "description": "Frame shape: vertical (for phones, Reels, TikTok, Shorts), horizontal, square, or unchanged"},
            "cannotDo": {"type": "string", "description": "What they asked for that these settings can't do, in a few plain words; empty if nothing"},
            "mediaAction": {"type": "string", "enum": ["unchanged", "only", "remove"], "description": "If they name media files: only (use just those), remove (take those out), or unchanged"},
        },
        "required": ["seconds", "pace", "look", "music", "frame", "cannotDo", "mediaAction"],
    })
}

/// Ollama on this computer (`OLLAMA_HOST`, else 127.0.0.1:11434). Only localhost is used, so the
/// request never leaves the machine.
pub fn ollama_base() -> String {
    let host = std::env::var("OLLAMA_HOST").ok().filter(|h| h.starts_with("127.0.0.1") || h.starts_with("localhost") || h.starts_with("http://127.0.0.1") || h.starts_with("http://localhost"));
    match host {
        Some(h) if h.starts_with("http") => h.trim_end_matches('/').to_string(),
        Some(h) => format!("http://{h}"),
        None => "http://127.0.0.1:11434".into(),
    }
}

/// Which local model reads requests: `PROMPTEDIT_LOCAL_MODEL`, else the first installed one,
/// preferring small instruct models. None when Ollama isn't running or has no models.
pub fn local_model() -> Option<String> {
    let tags = http::get(format!("{}/api/tags", ollama_base()), Duration::from_millis(1500)).ok()?;
    let names: Vec<String> = tags["models"].as_array()?.iter().filter_map(|m| m["name"].as_str().map(String::from)).collect();
    if let Ok(want) = std::env::var("PROMPTEDIT_LOCAL_MODEL") {
        return names.iter().find(|n| **n == want || n.starts_with(&format!("{want}:"))).cloned();
    }
    let prefer = ["qwen2.5:3b", "llama3.2:3b", "qwen2.5", "llama3.2", "phi3", "gemma2", "mistral", "llama3"];
    prefer.iter().find_map(|p| names.iter().find(|n| n.starts_with(p)).cloned()).or_else(|| names.first().cloned())
}

/// JSON over HTTP to localhost, blocking (tools and Magic run on their own threads). The request is
/// built inside the runtime, since reqwest arms its timeouts as the request is made.
mod http {
    use serde_json::Value;
    use std::time::Duration;
    async fn send(url: String, body: Option<Value>, timeout: Duration) -> Result<Value, String> {
        let client = ::reqwest::Client::builder().timeout(timeout).no_proxy().build().map_err(|e| e.to_string())?;
        let req = match body {
            Some(b) => client.post(url).json(&b),
            None => client.get(url),
        };
        req.send().await.map_err(|e| e.to_string())?.json::<Value>().await.map_err(|e| e.to_string())
    }
    pub fn get(url: String, timeout: Duration) -> Result<Value, String> {
        crate::mcp::tools::block_on(send(url, None, timeout))
    }
    pub fn post(url: String, body: Value, timeout: Duration) -> Result<Value, String> {
        crate::mcp::tools::block_on(send(url, Some(body), timeout))
    }
}

/// Asks the local model to fill in the fields.
pub fn read_with_model(model: &str, request: &str, media: &[MediaAsset]) -> Result<RecipeOut, String> {
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "format": schema(),
        "options": {"temperature": 0},
        "messages": [
            {"role": "system", "content": instructions(media)},
            {"role": "user", "content": request},
        ],
    });
    let reply = http::post(format!("{}/api/chat", ollama_base()), body, Duration::from_secs(90)).map_err(|e| format!("The local model couldn't read that: {e}"))?;
    let content = reply["message"]["content"].as_str().ok_or("The local model didn't answer.")?;
    serde_json::from_str(content).map_err(|e| format!("The local model couldn't read that: {e}"))
}

/// The keyword reader: the fields from the words of the request alone, so Local works with no model.
pub fn read_with_keywords(request: &str) -> RecipeOut {
    let t = request.to_lowercase();
    let mut out = RecipeOut { pace: "unchanged".into(), look: "unchanged".into(), music: "unchanged".into(), frame: "unchanged".into(), media_action: "unchanged".into(), ..Default::default() };
    // Length: "30s", "30 seconds", "2 minutes", "1:30".
    if let Some(c) = Regex::new(r"(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b").unwrap().captures(&t) {
        let n: f64 = c[1].parse().unwrap_or(0.0);
        let mins = c[2].starts_with('m');
        out.seconds = ((if mins { n * 60.0 } else { n }).round() as i64).clamp(0, 900);
    } else if let Some(c) = Regex::new(r"\b(\d+):(\d\d)\b").unwrap().captures(&t) {
        out.seconds = (c[1].parse::<i64>().unwrap_or(0) * 60 + c[2].parse::<i64>().unwrap_or(0)).clamp(0, 900);
    }
    if has(&t, &["calm", "slow", "relax", "chill", "gentle", "laid back", "longer shots"]) && !has(&t, &["slow motion", "slow-mo", "slowmo"]) {
        out.pace = "calm".into();
    }
    if has(&t, &["fast", "quick", "punch", "snappy", "energ", "faster", "short shots"]) {
        out.pace = "fast".into();
    }
    if let Some(l) = LOOKS.iter().find(|l| t.contains(&l.to_lowercase())) {
        out.look = (*l).to_string();
    } else if has(&t, &["black and white", "b&w", "monochrome", "greyscale", "grayscale"]) {
        out.look = "Mono".into();
    } else if has(&t, &["no look", "no grade", "remove the look", "take the look", "looks off", "no colour", "no color", "natural colour", "natural color"]) {
        out.look = "none".into();
    } else if has(&t, &["warm", "cosy", "cozy"]) {
        out.look = "Warm film".into();
    } else if has(&t, &["vintage", "retro", "film look", "filmic"]) {
        out.look = "Film print".into();
    } else if has(&t, &["cinematic", "blockbuster"]) {
        out.look = "Teal and orange".into();
    } else if has(&t, &["night", "cold", "cool look"]) {
        out.look = "Cool night".into();
    } else if has(&t, &["sunset", "golden"]) {
        out.look = "Golden hour".into();
    }
    if has(&t, &["no music", "without music", "remove the music", "music off", "mute the music", "drop the music", "take out the music", "no song", "silent"]) {
        out.music = "off".into();
    } else if has(&t, &["add music", "add a song", "with music", "some music", "put music", "music under", "a soundtrack", "add the song", "to music", "over music", "over the music", "to the music"]) {
        out.music = "add".into();
    }
    if has(&t, &["vertical", "portrait", "tiktok", "tik tok", "reel", "shorts", "stories", "9:16", "phone"]) {
        out.frame = "vertical".into();
    } else if has(&t, &["square", "1:1"]) {
        out.frame = "square".into();
    } else if has(&t, &["horizontal", "landscape", "widescreen", "16:9", "youtube"]) {
        out.frame = "horizontal".into();
    }
    if has(&t, &["only", "just "]) {
        out.media_action = "only".into();
    } else if has(&t, &["remove", "take out", "without", "drop", "get rid"]) {
        out.media_action = "remove".into();
    }
    out
}

/// Which reader Local uses, and why prompts may be limited (shown in the Local tab).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStatus {
    /// The local model in use, if any.
    pub model: Option<String>,
    /// Said in the Local tab when there's no local model.
    pub note: Option<String>,
}

pub fn reader_status() -> ReaderStatus {
    match local_model() {
        Some(m) => ReaderStatus { model: Some(m), note: None },
        None => ReaderStatus {
            model: None,
            note: Some("No local model is running, so Local reads your words by keyword: length, pace, look, music, vertical or square, and files by name. For a smarter Local, install Ollama with a small model (like qwen2.5:3b).".into()),
        },
    }
}

/// Reads a request into a recipe (Editroom's `LocalBrain.recipe`, with the reader swapped).
pub fn recipe(request: &str, p: &Project, pointed: &HashSet<Id>, has_edit: bool) -> Result<(Recipe, Option<String>), String> {
    let media = &p.assets;
    let words: Vec<String> = crate::mcp::providers::Transcript::tokens(request).into_iter().filter(|w| w.chars().count() >= 3 && !NOT_THINGS.contains(&w.as_str())).collect();
    let showing = showing(&words, media);
    let named_list: Vec<MediaAsset> = media
        .iter()
        .filter(|a| pointed.contains(&a.id) || named(request, std::slice::from_ref(a)).len() == 1)
        .cloned()
        .chain(showing.iter().filter(|a| !pointed.contains(&a.id) && named(request, std::slice::from_ref(a)).len() != 1).cloned())
        .collect();
    let model = local_model();
    let out = match &model {
        Some(m) => read_with_model(m, request, media).unwrap_or_else(|_| read_with_keywords(request)),
        None => read_with_keywords(request),
    };
    let mut r = Recipe {
        seconds: (out.seconds > 0).then_some(out.seconds as f64),
        pace: match out.pace.as_str() {
            "calm" => Pace::Calm,
            "fast" => Pace::Fast,
            _ => Pace::Unchanged,
        },
        look: (out.look != "unchanged" && !out.look.is_empty()).then(|| out.look.clone()),
        music: match out.music.as_str() {
            "off" => Music::Off,
            "add" => Music::Add,
            _ => Music::Unchanged,
        },
        frame: match out.frame.as_str() {
            "vertical" => Frame::Vertical,
            "horizontal" => Frame::Horizontal,
            "square" => Frame::Square,
            _ => Frame::Unchanged,
        },
        cannot_do: out.cannot_do.trim().to_string(),
        ..Default::default()
    };
    // A look the model made up isn't one Local can put on.
    if r.look.as_deref().is_some_and(|l| l != "none" && !LOOKS.contains(&l)) {
        r.look = None;
    }
    r = checked(&r, request);
    apply_media(&mut r, &named_list, &out.media_action, request, pointed, has_edit);
    r.shown = showing.iter().map(|a| a.id).collect();
    Ok((r, model))
}

/// Words in a request that aren't things a clip shows.
pub const NOT_THINGS: [&str; 55] = [
    "make", "the", "and", "use", "using", "only", "just", "clip", "clips", "shot", "shots", "video", "videos", "cut", "edit", "fast", "slow", "with", "out", "take", "remove", "keep", "all", "some", "more", "less", "seconds", "second", "minute", "music", "song", "look", "vertical", "square", "from", "into", "this", "that", "these", "show", "shows", "showing", "see", "want", "give", "put", "add", "where", "who", "any", "little", "big", "for", "film", "print",
];

/// The files that show what's asked for, by their scene tags (none until scene tags exist).
fn showing(words: &[String], media: &[MediaAsset]) -> Vec<MediaAsset> {
    let general = ["people", "person", "adult"];
    let scored: Vec<(MediaAsset, f64)> = media
        .iter()
        .filter(|a| a.kind != MediaKind::Audio)
        .map(|a| {
            let Some(t) = crate::mcp::providers::scene_tags(a.id) else { return (a.clone(), 0.0) };
            let s = words.iter().fold(0.0, |sum, w| {
                if !t.shows(w) {
                    return sum;
                }
                let tags = t.matching(w);
                let particular = tags.iter().filter(|x| !general.contains(&x.name.as_str())).map(|x| x.confidence).fold(f64::NAN, f64::max);
                sum + 1.0 + 0.5 * if particular.is_nan() { if tags.is_empty() { 1.0 } else { 0.0 } } else { particular }
            });
            (a.clone(), s)
        })
        .collect();
    let best = scored.iter().map(|s| s.1).fold(0.0, f64::max);
    if best <= 0.0 {
        return vec![];
    }
    scored.into_iter().filter(|s| s.1 == best).map(|s| s.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keywords_fill_the_fields() {
        let r = read_with_keywords("Make a fast 30 second vertical cut in black and white, no music");
        assert_eq!((r.seconds, r.pace.as_str(), r.look.as_str(), r.music.as_str(), r.frame.as_str()), (30, "fast", "Mono", "off", "vertical"));
        let r = read_with_keywords("a calm 2 minute edit with the Film print look");
        assert_eq!((r.seconds, r.pace.as_str(), r.look.as_str()), (120, "calm", "Film print"));
    }

    #[test]
    fn checked_drops_what_wasnt_asked() {
        let r = Recipe { seconds: Some(5.0), look: Some("Mono".into()), music: Music::Off, cannot_do: "a logo, music".into(), ..Default::default() };
        let c = checked(&r, "what's 5+5 with a logo");
        assert_eq!(c.seconds, None);
        assert_eq!(c.look, None);
        assert_eq!(c.music, Music::Unchanged);
        assert_eq!(c.cannot_do, "a logo");
    }

    #[test]
    fn heuristics() {
        assert_eq!(shot_count("at least ten clips"), Some(10));
        assert!(wants_every("use all of the videos"));
        assert_eq!(speed("make it 10x faster"), Some(10.0));
        assert_eq!(speed("slow motion please"), Some(0.5));
        assert_eq!(title_asked("add a title saying \"Summer\""), Some("Summer".into()));
        assert_eq!(title_asked("no title please"), None);
        assert_eq!(quoted_words("call it 'Our trip' now"), Some("Our trip".into()));
        assert_eq!(quoted_words("it doesn't matter"), None);
        assert!(wants_levels("make all audio clips the same output level"));
    }
}
