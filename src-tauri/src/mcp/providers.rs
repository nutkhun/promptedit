//! What the tools use from other parts of PromptEdit that live elsewhere: transcripts (whisper),
//! scene tags (CLIP), and the export queue (WebGL renderer in the UI). Each is registered by its
//! module when it exists; until then the tools say plainly that it isn't available.

use promptedit_core::{Id, MediaAsset};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, RwLock};

// MARK: Transcripts

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// What's said in a file, in file seconds (Editroom's `Transcript`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Transcript {
    pub words: Vec<Word>,
    pub language: String,
}

impl Transcript {
    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }
    pub fn text(&self) -> String {
        self.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
    }
    /// Stretches of talking: words closer than `gap` seconds run together.
    pub fn speech(&self, gap: f64) -> Vec<(f64, f64)> {
        let mut out: Vec<(f64, f64)> = vec![];
        for w in &self.words {
            match out.last_mut() {
                Some(last) if w.start - last.1 < gap => last.1 = last.1.max(w.end),
                _ => out.push((w.start, w.end)),
            }
        }
        out
    }
    /// Sentences (or runs of talking, if there's no punctuation), with their times.
    pub fn sentences(&self, gap: f64) -> Vec<(f64, f64, String)> {
        let mut out: Vec<(f64, f64, Vec<String>)> = vec![];
        for w in &self.words {
            let ends = out.last().and_then(|l| l.2.last()).is_none_or(|t| t.ends_with('.') || t.ends_with('?') || t.ends_with('!'));
            match out.last_mut() {
                Some(last) if !ends && w.start - last.1 < gap => {
                    last.1 = w.end;
                    last.2.push(w.text.clone());
                }
                _ => out.push((w.start, w.end, vec![w.text.clone()])),
            }
        }
        out.into_iter().map(|(a, b, t)| (a, b, t.join(" "))).collect()
    }
    pub fn tokens(s: &str) -> Vec<String> {
        s.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|t| !t.is_empty()).map(String::from).collect()
    }
    /// Where these words are said, in order, with a few words either side.
    pub fn occurrences(&self, phrase: &str) -> Vec<(f64, f64, String)> {
        let want = Self::tokens(phrase);
        if want.is_empty() || self.words.len() < want.len() {
            return vec![];
        }
        let have: Vec<String> = self.words.iter().map(|w| Self::tokens(&w.text).into_iter().next().unwrap_or_default()).collect();
        let mut out = vec![];
        for i in 0..=(self.words.len() - want.len()) {
            if have[i..i + want.len()] == want[..] {
                let from = i.saturating_sub(4);
                let to = (i + want.len() + 5).min(self.words.len());
                let context = self.words[from..to].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
                out.push((self.words[i].start, self.words[i + want.len() - 1].end, context));
            }
        }
        out
    }
}

/// Hears files. `ready` waits for (or makes) a file's transcript; `cached` answers at once.
pub trait TranscriptProvider: Send + Sync {
    fn cached(&self, asset: &MediaAsset) -> Option<Transcript>;
    fn ready(&self, asset: &MediaAsset) -> Option<Transcript>;
}

// MARK: Scene tags

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub confidence: f64,
    /// Seconds in the file where it shows.
    pub times: Vec<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SceneTags {
    /// Best first.
    pub tags: Vec<Tag>,
}

impl SceneTags {
    pub fn top(&self, n: usize) -> Vec<String> {
        self.tags.iter().take(n).map(|t| t.name.clone()).collect()
    }
    pub fn matching(&self, word: &str) -> Vec<&Tag> {
        let w = word.to_lowercase();
        self.tags.iter().filter(|t| t.name.to_lowercase().split(|c: char| !c.is_alphanumeric()).any(|p| p == w || p.starts_with(&w))).collect()
    }
    pub fn shows(&self, word: &str) -> bool {
        !self.matching(word).is_empty()
    }
}

pub trait SceneTagProvider: Send + Sync {
    fn tags(&self, asset: Id) -> Option<SceneTags>;
}

#[derive(Default)]
struct Registry {
    transcripts: Option<Box<dyn TranscriptProvider>>,
    scene_tags: Option<Box<dyn SceneTagProvider>>,
}

static REGISTRY: RwLock<Registry> = RwLock::new(Registry { transcripts: None, scene_tags: None });

pub fn set_transcripts(p: Box<dyn TranscriptProvider>) {
    REGISTRY.write().unwrap().transcripts = Some(p);
}
pub fn set_scene_tags(p: Box<dyn SceneTagProvider>) {
    REGISTRY.write().unwrap().scene_tags = Some(p);
}
pub fn transcripts_available() -> bool {
    REGISTRY.read().unwrap().transcripts.is_some()
}
pub fn transcript_cached(a: &MediaAsset) -> Option<Transcript> {
    REGISTRY.read().unwrap().transcripts.as_ref().and_then(|t| t.cached(a))
}
pub fn transcript_ready(a: &MediaAsset) -> Option<Transcript> {
    REGISTRY.read().unwrap().transcripts.as_ref().and_then(|t| t.ready(a))
}
pub fn scene_tags(a: Id) -> Option<SceneTags> {
    REGISTRY.read().unwrap().scene_tags.as_ref().and_then(|t| t.tags(a))
}

// MARK: Exports

/// Export settings as the export tool takes them; the UI's export pipeline maps them to its own.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub id: String,
    pub file: String,
    /// "video" (MP4) or "audio" (WAV).
    pub format: String,
    pub shape: String,
    pub height: Option<i64>,
    pub codec: String,
    pub quality: String,
    pub include_audio: bool,
    pub loudness: Option<f64>,
    pub range_only: bool,
    pub reframe_x: f64,
    pub reframe_y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ExportStatus {
    Waiting,
    Running,
    Done,
    Failed(String),
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportItem {
    pub request: ExportRequest,
    pub status: ExportStatus,
    pub progress: f64,
}

/// Exports started by agents. The tool sends `mcp-export` to the UI, which runs it through the
/// export pipeline and reports back with the `mcp_export_update` command.
#[derive(Default)]
pub struct Exports(pub Mutex<Vec<ExportItem>>);

impl Exports {
    pub fn add(&self, r: ExportRequest) {
        self.0.lock().unwrap().push(ExportItem { request: r, status: ExportStatus::Waiting, progress: 0.0 });
    }
    pub fn update(&self, id: &str, status: ExportStatus, progress: f64) {
        if let Some(i) = self.0.lock().unwrap().iter_mut().find(|i| i.request.id == id) {
            i.status = status;
            i.progress = progress;
        }
    }
    pub fn items(&self) -> Vec<ExportItem> {
        self.0.lock().unwrap().clone()
    }
    pub fn has_file(&self, file: &str) -> bool {
        self.0.lock().unwrap().iter().any(|i| i.request.file == file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(words: &[(f64, f64, &str)]) -> Transcript {
        Transcript { words: words.iter().map(|(a, b, s)| Word { start: *a, end: *b, text: s.to_string() }).collect(), language: "en".into() }
    }

    #[test]
    fn sentences_and_occurrences() {
        let tr = t(&[(0.0, 0.3, "Hello"), (0.35, 0.6, "there."), (0.7, 1.0, "Big"), (1.1, 1.4, "dog")]);
        let s = tr.sentences(0.8);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].2, "Hello there.");
        assert_eq!(tr.occurrences("big DOG").len(), 1);
        assert_eq!(tr.speech(0.45), vec![(0.0, 1.4)]);
    }
}
