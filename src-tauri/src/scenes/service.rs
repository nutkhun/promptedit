//! The tagging queue (Editroom's `SceneTagStore`): one file at a time on a background thread,
//! states the UI can poll or follow by event, tags kept on disk, and the picture model's download.
//! The MCP tools reach it through `SceneTagProvider`.

use super::cache;
use super::clip::Clip;
use super::frames;
use super::model;
use super::score::{self, Labels, Scorer};
use crate::mcp::providers::SceneTags;
use crate::transcribe::state::ModelState;
use promptedit_core::{Id, MediaAsset, MediaKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Background work waits this long after an import, so the pictures someone is looking at
/// (posters, the timeline) come first (spec 02-engine §15.1, "+3 s").
const AUTO_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct Dirs {
    /// `<app_data>/Models`
    pub models: PathBuf,
    /// `<app_config>/scenes.json`
    pub settings: PathBuf,
    /// `<app_cache>/Scenes`
    pub tags: PathBuf,
}

/// A file's tagging, serialised like the transcription contract's states.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SceneState {
    None,
    Queued,
    /// Waiting for the picture model, which the person hasn't downloaded yet.
    NeedsModel,
    Working { progress: f64 },
    Ready { tags: usize },
    Failed { message: String },
}

impl SceneState {
    pub fn is_pending(&self) -> bool {
        matches!(self, SceneState::Queued | SceneState::NeedsModel | SceneState::Working { .. })
    }
}

/// What Settings › General › Picture search saves.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Look at imported files in the background (once the model is here).
    pub enabled: bool,
    /// The person said "Not now" to the download prompt in Media search: don't ask again there.
    pub declined: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: true, declined: false }
    }
}

impl Settings {
    fn load(file: &Path) -> Settings {
        std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save(&self, file: &Path) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = file.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| e.to_string())
    }
}

/// `scene_settings_get`'s answer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub enabled: bool,
    pub declined: bool,
    pub model: ModelInfo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub label: &'static str,
    #[serde(rename = "sizeMB")]
    pub size_mb: u64,
    pub state: ModelState,
}

pub type Emitter = Box<dyn Fn(&str, Value) + Send + Sync>;
/// The library as it is now (the app reads the open document).
pub type Library = Box<dyn Fn() -> Vec<MediaAsset> + Send + Sync>;
/// One library item by id, without copying the whole library (the MCP tools ask per item).
pub type Find = Box<dyn Fn(Id) -> Option<MediaAsset> + Send + Sync>;

struct Job {
    picture: PathBuf,
    cache: PathBuf,
    still: bool,
    duration: f64,
    state: SceneState,
    not_before: Instant,
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    jobs: HashMap<Id, Job>,
    queue: VecDeque<Id>,
    working: Option<Id>,
    /// Downloading, or failed this session; `None` when resting (here or not).
    download: Option<ModelState>,
    /// Tags read from disk, by cache file, so searching doesn't reread them.
    loaded: HashMap<PathBuf, SceneTags>,
    /// Library items seen through commands, for the dev server (which has no `Library`).
    known: HashMap<Id, MediaAsset>,
}

pub struct Service {
    dirs: Dirs,
    inner: Mutex<Inner>,
    wake: Condvar,
    cancel: AtomicBool,
    emit: RwLock<Option<Emitter>>,
    library: RwLock<Option<Library>>,
    find: RwLock<Option<Find>>,
}

/// Only pictures have scene tags: videos and photos, not sound files.
fn has_picture(a: &MediaAsset) -> bool {
    a.kind != MediaKind::Audio
}

impl Service {
    pub fn new(dirs: Dirs) -> Arc<Service> {
        let settings = Settings::load(&dirs.settings);
        Arc::new(Service {
            dirs,
            inner: Mutex::new(Inner { settings, ..Default::default() }),
            wake: Condvar::new(),
            cancel: AtomicBool::new(false),
            emit: RwLock::new(None),
            library: RwLock::new(None),
            find: RwLock::new(None),
        })
    }

    pub fn dirs(&self) -> &Dirs {
        &self.dirs
    }

    pub fn set_emitter(&self, e: Emitter) {
        *self.emit.write().unwrap() = Some(e);
    }

    pub fn set_find(&self, f: Find) {
        *self.find.write().unwrap() = Some(f);
    }

    pub fn set_library(&self, l: Library) {
        *self.library.write().unwrap() = Some(l);
    }

    /// Items the dev server has seen (it has no `Library`): what `tags(id)` can find.
    pub fn remember(&self, assets: &[MediaAsset]) {
        let mut inner = self.inner.lock().unwrap();
        inner.known = assets.iter().map(|a| (a.id, a.clone())).collect();
    }

    /// What `remember` was last given (tests add to it rather than replace it).
    #[cfg(test)]
    pub fn library_snapshot(&self) -> Vec<MediaAsset> {
        self.inner.lock().unwrap().known.values().cloned().collect()
    }

    fn library(&self) -> Vec<MediaAsset> {
        match self.library.read().unwrap().as_ref() {
            Some(l) => l(),
            None => self.inner.lock().unwrap().known.values().cloned().collect(),
        }
    }

    pub fn asset(&self, id: Id) -> Option<MediaAsset> {
        if let Some(f) = self.find.read().unwrap().as_ref() {
            return f(id);
        }
        self.library().into_iter().find(|a| a.id == id)
    }

    fn emit(&self, event: &str, payload: Value) {
        if let Some(e) = self.emit.read().unwrap().as_ref() {
            e(event, payload);
        }
    }

    fn emit_state(&self, asset: Id, s: &SceneState) {
        let mut v = serde_json::to_value(s).unwrap_or_default();
        v["asset"] = json!(asset);
        self.emit("scene-tags-state", v);
    }

    fn emit_model(&self, s: &ModelState) {
        self.emit("scene-model", serde_json::to_value(s).unwrap_or_default());
    }

    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::Builder::new().name("scene-tags".into()).spawn(move || me.work()).expect("scene tags thread");
    }

    // MARK: Tags

    /// The tags on disk, if the file has been looked at. Never starts work.
    pub fn cached(&self, asset: &MediaAsset) -> Option<SceneTags> {
        let files = cache::candidates(&self.dirs.tags, asset);
        if let Some(t) = files.iter().find_map(|f| self.inner.lock().unwrap().loaded.get(f).cloned()) {
            return Some(t);
        }
        files.into_iter().find_map(|file| {
            let t = cache::load(&file)?;
            self.inner.lock().unwrap().loaded.insert(file, t.clone());
            Some(t)
        })
    }

    pub fn state(&self, asset: &MediaAsset) -> SceneState {
        if !has_picture(asset) {
            return SceneState::None;
        }
        let files = cache::candidates(&self.dirs.tags, asset);
        if let Some(j) = self.inner.lock().unwrap().jobs.get(&asset.id)
            && files.contains(&j.cache)
            && (j.state.is_pending() || matches!(j.state, SceneState::Failed { .. }))
        {
            return j.state.clone();
        }
        match self.cached(asset) {
            Some(t) => SceneState::Ready { tags: t.tags.len() },
            None => SceneState::None,
        }
    }

    pub fn model_installed(&self) -> bool {
        model::installed(&self.dirs.models)
    }

    /// Queues a file to be looked at, after `delay`. Nothing happens if it's done or underway; a
    /// failed file is tried again only when `retry`.
    pub fn queue(&self, asset: &MediaAsset, delay: Duration, retry: bool) -> SceneState {
        let now = self.state(asset);
        match &now {
            SceneState::None => {}
            SceneState::Failed { .. } if retry => {}
            _ => return now,
        }
        if !has_picture(asset) {
            return now;
        }
        let state = if self.model_installed() { SceneState::Queued } else { SceneState::NeedsModel };
        let picture = cache::picture_path(asset);
        let job = Job {
            cache: cache::file_for(&self.dirs.tags, &picture),
            picture,
            still: asset.kind == MediaKind::Image,
            duration: asset.duration,
            state: state.clone(),
            not_before: Instant::now() + delay,
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.known.insert(asset.id, asset.clone());
            inner.queue.retain(|&id| id != asset.id);
            inner.queue.push_back(asset.id);
            inner.jobs.insert(asset.id, job);
        }
        self.wake.notify_all();
        self.emit_state(asset.id, &state);
        state
    }

    /// Background looking after import or open: only when the model is already here (it's never
    /// downloaded without the person agreeing) and tagging is on; failed files aren't retried.
    pub fn auto_queue(&self, assets: &[MediaAsset]) {
        if !self.model_installed() || !self.inner.lock().unwrap().settings.enabled {
            return;
        }
        for a in assets.iter().filter(|a| has_picture(a)) {
            self.queue(a, AUTO_DELAY, false);
        }
    }

    /// Every library item that hasn't been looked at, as after the model arrives.
    pub fn queue_library(&self) {
        let assets = self.library();
        for a in assets.iter().filter(|a| has_picture(a)) {
            self.queue(a, Duration::ZERO, false);
        }
    }

    // MARK: Settings and the model

    pub fn model_state(&self) -> ModelState {
        let inner = self.inner.lock().unwrap();
        match &inner.download {
            Some(s) => s.clone(),
            None if self.model_installed() => ModelState::Ready,
            None => ModelState::Missing,
        }
    }

    pub fn settings(&self) -> SettingsView {
        let s = self.inner.lock().unwrap().settings.clone();
        SettingsView {
            enabled: s.enabled,
            declined: s.declined,
            model: ModelInfo { label: model::LABEL, size_mb: model::SIZE_MB, state: self.model_state() },
        }
    }

    pub fn set_settings(&self, enabled: Option<bool>, declined: Option<bool>) -> Result<SettingsView, String> {
        let turned_on = {
            let mut inner = self.inner.lock().unwrap();
            let mut s = inner.settings.clone();
            s.enabled = enabled.unwrap_or(s.enabled);
            s.declined = declined.unwrap_or(s.declined);
            let on = s.enabled && !inner.settings.enabled;
            if s != inner.settings {
                s.save(&self.dirs.settings)?;
                inner.settings = s;
            }
            on
        };
        self.wake.notify_all();
        if turned_on && self.model_installed() {
            self.queue_library();
        }
        Ok(self.settings())
    }

    /// Starts downloading the model unless it's here or on its way. Once it's here, everything in
    /// the library is looked at.
    pub fn download(self: &Arc<Self>) -> ModelState {
        if let s @ (ModelState::Ready | ModelState::Downloading { .. }) = self.model_state() {
            return s;
        }
        let start = ModelState::Downloading { progress: 0.0 };
        self.inner.lock().unwrap().download = Some(start.clone());
        self.emit_model(&start);
        let me = self.clone();
        std::thread::Builder::new().name("picture-model-download".into()).spawn(move || me.run_download()).expect("download thread");
        start
    }

    fn run_download(&self) {
        let mut shown = -1.0;
        let mut last = Instant::now();
        let result = model::download(&self.dirs.models, |p| {
            if p - shown >= 0.001 && (last.elapsed() >= Duration::from_millis(250) || p >= 1.0) {
                shown = p;
                last = Instant::now();
                let s = ModelState::Downloading { progress: p };
                self.inner.lock().unwrap().download = Some(s.clone());
                self.emit_model(&s);
            }
        });
        let state = match result {
            Ok(()) => ModelState::Ready,
            Err(message) => ModelState::Failed { message },
        };
        self.inner.lock().unwrap().download = if state == ModelState::Ready { None } else { Some(state.clone()) };
        self.emit_model(&state);
        if state == ModelState::Ready {
            self.refresh_waiting();
            self.queue_library();
            self.wake.notify_all();
        }
    }

    /// Files waiting for the model go to `queued` once it's here.
    fn refresh_waiting(&self) {
        let mut changed = vec![];
        {
            let mut inner = self.inner.lock().unwrap();
            let ids: Vec<Id> = inner.queue.iter().copied().collect();
            for id in ids {
                if let Some(j) = inner.jobs.get_mut(&id)
                    && j.state == SceneState::NeedsModel
                {
                    j.state = SceneState::Queued;
                    changed.push(id);
                }
            }
        }
        for id in changed {
            self.emit_state(id, &SceneState::Queued);
        }
    }

    fn is_wanted(&self, id: Id) -> bool {
        match self.library.read().unwrap().as_ref() {
            Some(l) => l().iter().any(|a| a.id == id),
            None => true,
        }
    }

    // MARK: Worker

    /// The next job that's due, or how long until one is.
    fn next_job(&self, inner: &mut Inner) -> Result<(Id, PathBuf, PathBuf, bool, f64), Option<Duration>> {
        if !inner.settings.enabled || !self.model_installed() {
            return Err(None);
        }
        let now = Instant::now();
        let mut soonest: Option<Duration> = None;
        for (i, id) in inner.queue.iter().enumerate() {
            let Some(j) = inner.jobs.get(id) else { continue };
            if j.not_before <= now {
                let id = inner.queue.remove(i).unwrap();
                let j = inner.jobs.get_mut(&id).unwrap();
                j.state = SceneState::Working { progress: 0.0 };
                inner.working = Some(id);
                return Ok((id, j.picture.clone(), j.cache.clone(), j.still, j.duration));
            }
            let wait = j.not_before - now;
            soonest = Some(soonest.map_or(wait, |s| s.min(wait)));
        }
        Err(soonest)
    }

    fn work(&self) {
        let mut engine: Option<(Clip, Scorer)> = None;
        loop {
            let (id, picture, cache_file, still, duration) = {
                let mut inner = self.inner.lock().unwrap();
                loop {
                    match self.next_job(&mut inner) {
                        Ok(job) => break job,
                        Err(wait) => {
                            // Idle for a minute: let the model's memory go.
                            let limit = wait.unwrap_or(Duration::from_secs(60)).min(Duration::from_secs(60));
                            let (guard, timeout) = self.wake.wait_timeout(inner, limit).unwrap();
                            inner = guard;
                            if timeout.timed_out() && wait.is_none() && inner.queue.is_empty() {
                                engine = None;
                            }
                        }
                    }
                }
            };
            self.cancel.store(false, Ordering::SeqCst);
            let result = if !self.is_wanted(id) {
                Err(None)
            } else {
                self.emit_state(id, &SceneState::Working { progress: 0.0 });
                self.look(&mut engine, id, &picture, still, duration)
            };
            let state = match result {
                Ok(t) => match cache::save(&cache_file, &t) {
                    Ok(()) => {
                        let n = t.tags.len();
                        self.inner.lock().unwrap().loaded.insert(cache_file.clone(), t);
                        SceneState::Ready { tags: n }
                    }
                    Err(e) => SceneState::Failed { message: format!("Couldn't save what's in the picture: {e}") },
                },
                Err(None) => SceneState::None,
                Err(Some(message)) => SceneState::Failed { message },
            };
            {
                let mut inner = self.inner.lock().unwrap();
                inner.working = None;
                if matches!(state, SceneState::Failed { .. }) {
                    if let Some(j) = inner.jobs.get_mut(&id) {
                        j.state = state.clone();
                    }
                } else {
                    inner.jobs.remove(&id);
                }
            }
            self.emit_state(id, &state);
        }
    }

    /// The model in memory, and the label sentences embedded (once, then from disk).
    fn load_engine(&self) -> Result<(Clip, Scorer), String> {
        let m = &self.dirs.models;
        let labels = Labels::builtin();
        let file = model::embeddings_file(m);
        if let Some(e) = model::load_embeddings(&file, &labels) {
            return Ok((Clip::vision(&model::path(m, &model::VISION))?, Scorer::new(labels, e)?));
        }
        let mut clip = Clip::with_text(&model::path(m, &model::VISION), &model::path(m, &model::TEXT), &model::path(m, &model::TOKENIZER))?;
        let e = clip.embed_text(&labels.sentences())?;
        model::save_embeddings(&file, &labels, &e)?;
        // The text side's memory goes: it's only needed for this.
        drop(clip);
        Ok((Clip::vision(&model::path(m, &model::VISION))?, Scorer::new(labels, e)?))
    }

    /// Looks at one file: `Err(None)` when it was taken out of the library meanwhile.
    fn look(&self, engine: &mut Option<(Clip, Scorer)>, id: Id, picture: &Path, still: bool, duration: f64) -> Result<SceneTags, Option<String>> {
        if engine.is_none() {
            *engine = Some(self.load_engine().map_err(Some)?);
        }
        let (clip, scorer) = engine.as_mut().unwrap();
        let times: Vec<Option<f64>> = if still { vec![None] } else { score::frame_times(duration).into_iter().map(Some).collect() };
        let mut seen = vec![];
        let mut checked = Instant::now();
        for (i, t) in times.iter().enumerate() {
            if checked.elapsed() >= Duration::from_secs(2) {
                checked = Instant::now();
                if !self.is_wanted(id) {
                    return Err(None);
                }
            }
            let Some(rgb) = frames::frame(picture, *t) else { continue };
            let e = clip.embed_image(&rgb).map_err(Some)?;
            seen.push((t.unwrap_or(0.0), scorer.classify(&e)));
            let s = SceneState::Working { progress: (i + 1) as f64 / times.len() as f64 };
            if let Some(j) = self.inner.lock().unwrap().jobs.get_mut(&id) {
                j.state = s.clone();
            }
            self.emit_state(id, &s);
        }
        if seen.is_empty() {
            return Err(Some("Couldn't read pictures from this file.".into()));
        }
        Ok(score::gather(&seen))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn service(tag: &str) -> (Arc<Service>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("promptedit-scenes-svc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dirs = Dirs { models: dir.join("Models"), settings: dir.join("scenes.json"), tags: dir.join("Scenes") };
        (Service::new(dirs), dir)
    }

    fn asset(path: &Path, kind: &str) -> MediaAsset {
        serde_json::from_value(json!({
            "id": promptedit_core::Id::new(), "path": path, "name": "a", "kind": kind,
            "duration": 4.0, "width": 64, "height": 36, "fps": 30.0, "hasAudio": false
        }))
        .unwrap()
    }

    #[test]
    fn states_serialise_like_the_contract() {
        let v = |s: &SceneState| serde_json::to_value(s).unwrap();
        assert_eq!(v(&SceneState::NeedsModel), json!({"state": "needsModel"}));
        assert_eq!(v(&SceneState::Ready { tags: 3 }), json!({"state": "ready", "tags": 3}));
        assert_eq!(v(&SceneState::Working { progress: 0.5 }), json!({"state": "working", "progress": 0.5}));
    }

    #[test]
    fn queues_without_the_model_and_reads_tags_from_disk() {
        let (s, dir) = service("queue");
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        std::fs::write(&clip, b"x").unwrap();
        let a = asset(&clip, "video");
        assert_eq!(s.state(&a), SceneState::None);
        // No model: waits for it; background queueing does nothing at all.
        let b = asset(&clip, "video");
        s.auto_queue(std::slice::from_ref(&b));
        assert_eq!(s.state(&b), SceneState::None);
        assert_eq!(s.queue(&a, Duration::ZERO, false), SceneState::NeedsModel);
        assert_eq!(s.state(&a), SceneState::NeedsModel);
        // Sound files have no picture.
        let song = asset(&clip, "audio");
        assert_eq!(s.queue(&song, Duration::ZERO, false), SceneState::None);
        // Tags on disk (from an earlier session) are ready, and known by id.
        let file = cache::file_for(&s.dirs().tags, &clip);
        let t: SceneTags = serde_json::from_value(json!({"tags": [{"name": "beach", "confidence": 0.8, "times": [1.0]}]})).unwrap();
        cache::save(&file, &t).unwrap();
        let c = asset(&clip, "video");
        assert_eq!(s.state(&c), SceneState::Ready { tags: 1 });
        s.remember(std::slice::from_ref(&c));
        assert_eq!(s.cached(&s.asset(c.id).unwrap()).unwrap().tags[0].name, "beach");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn settings_are_saved() {
        let (s, dir) = service("settings");
        let v = serde_json::to_value(s.settings()).unwrap();
        assert_eq!(v, json!({"enabled": true, "declined": false, "model": {"label": "CLIP ViT-B/32", "sizeMB": 156, "state": {"state": "missing"}}}));
        s.set_settings(Some(false), Some(true)).unwrap();
        assert_eq!(Settings::load(&dir.join("scenes.json")), Settings { enabled: false, declined: true });
        std::fs::remove_dir_all(&dir).ok();
    }
}
