//! The transcription queue (Editroom's `Transcripts`): one file at a time on a background thread,
//! states the UI can poll or follow by event, a transcript cache on disk, and the speech model
//! downloads. MCP tools reach it through `TranscriptProvider`.

use super::cache;
use super::models::{self, ModelId, Settings};
use super::state::{ModelState, TranscriptState};
use super::whisper::{CANCELLED, Engine};
use crate::mcp::providers::Transcript;
use promptedit_core::{Id, MediaAsset};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Where things are kept.
#[derive(Clone, Debug)]
pub struct Dirs {
    /// `<app_data>/Models`
    pub models: PathBuf,
    /// `<app_config>/transcription.json`
    pub settings: PathBuf,
    /// `<app_cache>/Transcripts`
    pub transcripts: PathBuf,
}

/// Sends an event to the UI (Tauri only): name and payload.
pub type Emitter = Box<dyn Fn(&str, Value) + Send + Sync>;
/// Whether a library item is still in the project (a removed one isn't heard).
pub type Wanted = Box<dyn Fn(Id) -> bool + Send + Sync>;

struct Job {
    sound: PathBuf,
    cache: PathBuf,
    duration: f64,
    state: TranscriptState,
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    /// What this session knows per item: pending, failed, or heard.
    jobs: HashMap<Id, Job>,
    /// Waiting their turn (including those waiting for the model), next first.
    queue: VecDeque<Id>,
    working: Option<Id>,
    /// Models being downloaded, or whose download failed (this session).
    downloads: HashMap<ModelId, ModelState>,
    /// Words in transcripts on disk, by cache file, so polling doesn't reread them.
    counts: HashMap<PathBuf, usize>,
}

pub struct Service {
    dirs: Dirs,
    inner: Mutex<Inner>,
    /// Wakes the worker: a job was queued, or the model arrived or changed.
    wake: Condvar,
    /// Wakes `ready` waiters: a job finished.
    finished: Condvar,
    /// Stops the file being heard now (its item was removed).
    cancel: AtomicBool,
    emit: RwLock<Option<Emitter>>,
    wanted: RwLock<Option<Wanted>>,
}

impl Service {
    pub fn new(dirs: Dirs) -> Arc<Service> {
        let settings = Settings::load(&dirs.settings);
        Arc::new(Service {
            dirs,
            inner: Mutex::new(Inner { settings, ..Default::default() }),
            wake: Condvar::new(),
            finished: Condvar::new(),
            cancel: AtomicBool::new(false),
            emit: RwLock::new(None),
            wanted: RwLock::new(None),
        })
    }

    pub fn dirs(&self) -> &Dirs {
        &self.dirs
    }

    pub fn set_emitter(&self, e: Emitter) {
        *self.emit.write().unwrap() = Some(e);
    }

    pub fn set_wanted(&self, w: Wanted) {
        *self.wanted.write().unwrap() = Some(w);
    }

    fn emit(&self, event: &str, payload: Value) {
        if let Some(e) = self.emit.read().unwrap().as_ref() {
            e(event, payload);
        }
    }

    fn emit_transcript(&self, asset: Id, s: &TranscriptState) {
        let mut v = serde_json::to_value(s).unwrap_or_default();
        v["asset"] = json!(asset);
        self.emit("transcript-state", v);
    }

    fn emit_model(&self, model: ModelId, s: &ModelState) {
        let mut v = serde_json::to_value(s).unwrap_or_default();
        v["model"] = json!(model);
        self.emit("transcription-model", v);
    }

    fn is_wanted(&self, asset: Id) -> bool {
        self.wanted.read().unwrap().as_ref().is_none_or(|w| w(asset))
    }

    /// Starts the worker thread. Called once.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::Builder::new().name("transcribe".into()).spawn(move || me.work()).expect("transcription thread");
    }

    // MARK: Transcripts

    /// Where a new transcript of `asset` is saved: named after the file it's heard from.
    fn cache_file(&self, asset: &MediaAsset) -> PathBuf {
        cache::file_for(&self.dirs.transcripts, &cache::sound_path(asset))
    }

    /// The transcript on disk, if the file has been heard. Never starts work.
    pub fn cached(&self, asset: &MediaAsset) -> Option<Transcript> {
        cache::candidates(&self.dirs.transcripts, asset).into_iter().find_map(|file| {
            let t = cache::load(&file)?;
            self.inner.lock().unwrap().counts.insert(file, t.words.len());
            Some(t)
        })
    }

    pub fn state(&self, asset: &MediaAsset) -> TranscriptState {
        let files = cache::candidates(&self.dirs.transcripts, asset);
        let inner = self.inner.lock().unwrap();
        if let Some(j) = inner.jobs.get(&asset.id) {
            // A job for the same file as it is now; a changed file is a new job.
            if files.contains(&j.cache) && (j.state.is_pending() || matches!(j.state, TranscriptState::Failed { .. })) {
                return j.state.clone();
            }
        }
        if let Some(&n) = files.iter().find_map(|f| inner.counts.get(f)) {
            return TranscriptState::Ready { words: n };
        }
        drop(inner);
        match self.cached(asset) {
            Some(t) => TranscriptState::Ready { words: t.words.len() },
            None => TranscriptState::None,
        }
    }

    fn model_installed(&self, model: ModelId) -> bool {
        models::installed(&self.dirs.models, model).is_some()
    }

    /// Queues a file to be heard (`soon`: first in line). Nothing happens if it's heard or being
    /// heard. A failed file is tried again only when `retry` (the person asked again).
    pub fn queue(&self, asset: &MediaAsset, soon: bool, retry: bool) -> TranscriptState {
        let now = self.state(asset);
        match &now {
            TranscriptState::Ready { .. } => return now,
            TranscriptState::Failed { .. } if !retry => return now,
            TranscriptState::Working { .. } => return now,
            TranscriptState::Queued | TranscriptState::NeedsModel if !soon => return now,
            _ => {}
        }
        if !asset.has_audio || asset.kind == promptedit_core::MediaKind::Image {
            // Nothing to hear: an empty transcript, as Editroom saves for a file with no sound.
            let file = self.cache_file(asset);
            let t = Transcript { words: vec![], language: String::new() };
            let state = match cache::save(&file, &t) {
                Ok(()) => {
                    self.inner.lock().unwrap().counts.insert(file, 0);
                    TranscriptState::Ready { words: 0 }
                }
                Err(e) => TranscriptState::Failed { message: format!("Couldn't save the transcript: {e}") },
            };
            self.emit_transcript(asset.id, &state);
            return state;
        }
        let mut inner = self.inner.lock().unwrap();
        let state = if self.model_installed(inner.settings.model) { TranscriptState::Queued } else { TranscriptState::NeedsModel };
        inner.queue.retain(|&id| id != asset.id);
        if soon { inner.queue.push_front(asset.id) } else { inner.queue.push_back(asset.id) }
        let job = Job { sound: cache::sound_path(asset), cache: self.cache_file(asset), duration: asset.duration, state: state.clone() };
        inner.jobs.insert(asset.id, job);
        drop(inner);
        self.wake.notify_all();
        self.emit_transcript(asset.id, &state);
        state
    }

    /// Background hearing after import or open: only when the model is already here (a model is
    /// never downloaded without the person asking), and never retrying a failed file.
    pub fn auto_queue(&self, assets: &[MediaAsset]) {
        let model = self.inner.lock().unwrap().settings.model;
        if !self.model_installed(model) {
            return;
        }
        for a in assets.iter().filter(|a| a.has_audio && a.kind != promptedit_core::MediaKind::Image) {
            self.queue(a, false, false);
        }
    }

    /// The transcript, made now if it isn't yet (waiting up to `limit`), for agents. `None` if the
    /// file can't be heard: it failed this session, or the model isn't downloaded.
    pub fn ready(&self, asset: &MediaAsset, limit: Duration) -> Option<Transcript> {
        if let Some(t) = self.cached(asset) {
            return Some(t);
        }
        match self.state(asset) {
            TranscriptState::Failed { .. } => return None,
            TranscriptState::Working { .. } => {}
            _ => {
                if !self.model_installed(self.inner.lock().unwrap().settings.model) {
                    return None;
                }
                self.queue(asset, true, false);
            }
        }
        let deadline = Instant::now() + limit;
        let mut inner = self.inner.lock().unwrap();
        loop {
            let pending = inner.jobs.get(&asset.id).is_some_and(|j| j.state.is_pending());
            if !pending {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            inner = self.finished.wait_timeout(inner, left).unwrap().0;
        }
        drop(inner);
        self.cached(asset)
    }

    // MARK: Settings and models

    pub fn settings(&self) -> models::SettingsView {
        models::view(&self.inner.lock().unwrap().settings, &self.dirs.models)
    }

    pub fn set_settings(&self, model: Option<&str>, language: Option<&str>) -> Result<models::SettingsView, String> {
        let mut inner = self.inner.lock().unwrap();
        let mut s = inner.settings.clone();
        if let Some(m) = model {
            s.model = ModelId::parse(m).ok_or_else(|| format!("Unknown speech model {m}."))?;
        }
        if let Some(l) = language {
            let l = l.trim().to_lowercase();
            if !models::valid_language(&l) {
                return Err(format!("Unknown language {l}."));
            }
            s.language = l;
        }
        if s != inner.settings {
            s.save(&self.dirs.settings)?;
            let model_changed = s.model != inner.settings.model;
            inner.settings = s;
            if model_changed {
                let m = inner.settings.model;
                let state = self.model_state_locked(&inner, m);
                drop(inner);
                self.emit_model(m, &state);
                // Files waiting for a model may be able to go now, or have to wait.
                self.refresh_waiting();
                self.wake.notify_all();
                return Ok(self.settings());
            }
        }
        drop(inner);
        Ok(self.settings())
    }

    fn model_state_locked(&self, inner: &Inner, model: ModelId) -> ModelState {
        match inner.downloads.get(&model) {
            Some(s) => s.clone(),
            None => models::resting_state(&self.dirs.models, model),
        }
    }

    /// The chosen model's state, or `model`'s.
    pub fn model_state(&self, model: Option<ModelId>) -> ModelState {
        let inner = self.inner.lock().unwrap();
        let m = model.unwrap_or(inner.settings.model);
        self.model_state_locked(&inner, m)
    }

    /// Starts downloading a model (the chosen one by default) unless it's here or on its way.
    pub fn download(self: &Arc<Self>, model: Option<ModelId>) -> ModelState {
        let mut inner = self.inner.lock().unwrap();
        let m = model.unwrap_or(inner.settings.model);
        if let s @ (ModelState::Ready | ModelState::Downloading { .. }) = self.model_state_locked(&inner, m) {
            return s;
        }
        let start = ModelState::Downloading { progress: 0.0 };
        inner.downloads.insert(m, start.clone());
        drop(inner);
        self.emit_model(m, &start);
        let me = self.clone();
        std::thread::Builder::new()
            .name("speech-model-download".into())
            .spawn(move || me.run_download(m))
            .expect("download thread");
        start
    }

    fn run_download(&self, m: ModelId) {
        let mut shown = -1.0;
        let mut last = Instant::now();
        let result = models::download(&self.dirs.models, m, |p| {
            // A tenth of a percent, at most four times a second, is plenty for a progress bar.
            if p - shown >= 0.001 && (last.elapsed() >= Duration::from_millis(250) || p >= 1.0) {
                shown = p;
                last = Instant::now();
                let s = ModelState::Downloading { progress: p };
                self.inner.lock().unwrap().downloads.insert(m, s.clone());
                self.emit_model(m, &s);
            }
        });
        let state = match result {
            Ok(_) => ModelState::Ready,
            Err(message) => ModelState::Failed { message },
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if state == ModelState::Ready {
                inner.downloads.remove(&m);
            } else {
                inner.downloads.insert(m, state.clone());
            }
        }
        self.emit_model(m, &state);
        if state == ModelState::Ready {
            self.refresh_waiting();
            self.wake.notify_all();
        }
    }

    /// Files waiting for the model go to `queued` once it's here, and back to `needsModel` if the
    /// chosen model changes to one that isn't.
    fn refresh_waiting(&self) {
        let mut inner = self.inner.lock().unwrap();
        let have = self.model_installed(inner.settings.model);
        let next = if have { TranscriptState::Queued } else { TranscriptState::NeedsModel };
        let ids: Vec<Id> = inner.queue.iter().copied().collect();
        let mut changed = vec![];
        for id in ids {
            if let Some(j) = inner.jobs.get_mut(&id)
                && matches!(j.state, TranscriptState::Queued | TranscriptState::NeedsModel)
                && j.state != next
            {
                j.state = next.clone();
                changed.push(id);
            }
        }
        drop(inner);
        for id in changed {
            self.emit_transcript(id, &next);
        }
    }

    // MARK: Worker

    fn work(&self) {
        let mut engine: Option<Engine> = None;
        loop {
            // Next file, once there's one and a model to hear it with.
            let (id, sound, cache_file, duration, model, language) = {
                let mut inner = self.inner.lock().unwrap();
                loop {
                    let model = inner.settings.model;
                    if !inner.queue.is_empty() && self.model_installed(model) {
                        let id = inner.queue.pop_front().unwrap();
                        let Some(job) = inner.jobs.get_mut(&id) else { continue };
                        job.state = TranscriptState::Working { progress: 0.0 };
                        let picked = (id, job.sound.clone(), job.cache.clone(), job.duration, model, inner.settings.language.clone());
                        inner.working = Some(id);
                        break picked;
                    }
                    // Idle for a minute: let the model's memory go.
                    let (guard, timeout) = self.wake.wait_timeout(inner, Duration::from_secs(60)).unwrap();
                    inner = guard;
                    if timeout.timed_out() && inner.queue.is_empty() {
                        engine = None;
                    }
                }
            };
            self.cancel.store(false, Ordering::SeqCst);
            let result = if !self.is_wanted(id) {
                Err(CANCELLED.to_string())
            } else {
                self.emit_transcript(id, &TranscriptState::Working { progress: 0.0 });
                self.hear(&mut engine, id, &sound, duration, model, &language)
            };
            let state = match result {
                Ok(t) => match cache::save(&cache_file, &t) {
                    Ok(()) => TranscriptState::Ready { words: t.words.len() },
                    Err(e) => TranscriptState::Failed { message: format!("Couldn't save the transcript: {e}") },
                },
                Err(e) if e == CANCELLED => TranscriptState::None,
                Err(message) => TranscriptState::Failed { message },
            };
            {
                let mut inner = self.inner.lock().unwrap();
                inner.working = None;
                match &state {
                    TranscriptState::Ready { words } => {
                        inner.counts.insert(cache_file.clone(), *words);
                        inner.jobs.remove(&id);
                    }
                    TranscriptState::None => {
                        inner.jobs.remove(&id);
                    }
                    _ => {
                        if let Some(j) = inner.jobs.get_mut(&id) {
                            j.state = state.clone();
                        }
                    }
                }
            }
            self.finished.notify_all();
            self.emit_transcript(id, &state);
        }
    }

    fn hear(&self, engine: &mut Option<Engine>, id: Id, sound: &std::path::Path, duration: f64, model: ModelId, language: &str) -> Result<Transcript, String> {
        if engine.as_ref().is_none_or(|e| e.model != model) {
            *engine = None; // one model in memory at a time
            let path = models::installed(&self.dirs.models, model).ok_or("The speech model isn't downloaded.")?;
            *engine = Some(Engine::load(&path, model)?);
        }
        let engine = engine.as_ref().unwrap();
        let mut shown = 0.0;
        let mut progress = |p: f64| {
            if p - shown >= 0.01 {
                shown = p;
                let s = TranscriptState::Working { progress: p };
                if let Some(j) = self.inner.lock().unwrap().jobs.get_mut(&id) {
                    j.state = s.clone();
                }
                self.emit_transcript(id, &s);
            }
        };
        // Whether the item is still in the project, checked every two seconds (it takes the
        // document's lock).
        let checked = Mutex::new(Instant::now());
        let cancelled = || {
            if self.cancel.load(Ordering::Relaxed) {
                return true;
            }
            let mut at = checked.lock().unwrap();
            if at.elapsed() >= Duration::from_secs(2) {
                *at = Instant::now();
                if !self.is_wanted(id) {
                    self.cancel.store(true, Ordering::SeqCst);
                    return true;
                }
            }
            false
        };
        engine.transcribe(sound, duration, language, &mut progress, &cancelled)
    }
}
