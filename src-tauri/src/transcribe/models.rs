//! Speech models and settings (docs/spec/05-captions-contract.md "Speech models"): which whisper
//! model and language to use, kept in `<app_config>/transcription.json`, and the model files,
//! downloaded once into `<app_data>/Models/` when the person asks.

use super::state::ModelState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelId {
    Fast,
    Balanced,
    Best,
}

impl ModelId {
    pub const ALL: [ModelId; 3] = [ModelId::Fast, ModelId::Balanced, ModelId::Best];

    pub fn label(self) -> &'static str {
        match self {
            ModelId::Fast => "Fast",
            ModelId::Balanced => "Balanced",
            ModelId::Best => "Best (slow on older PCs)",
        }
    }

    pub fn file(self) -> &'static str {
        match self {
            ModelId::Fast => "ggml-base.bin",
            ModelId::Balanced => "ggml-small.bin",
            ModelId::Best => "ggml-large-v3-turbo-q5_0.bin",
        }
    }

    /// Download size in MB (10^6 bytes), as Settings shows it.
    pub fn size_mb(self) -> u64 {
        match self {
            ModelId::Fast => 148,
            ModelId::Balanced => 488,
            ModelId::Best => 574,
        }
    }

    pub fn url(self) -> String {
        format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", self.file())
    }

    pub fn parse(s: &str) -> Option<ModelId> {
        serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
    }
}

/// What Settings › Captions saves.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub model: ModelId,
    /// `auto` (whisper detects it) or a whisper language code ("en", "de", …).
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { model: ModelId::Balanced, language: "auto".into() }
    }
}

impl Settings {
    pub fn load(file: &Path) -> Settings {
        let mut s: Settings = std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if !valid_language(&s.language) {
            s.language = "auto".into();
        }
        s
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| e.to_string())
    }
}

/// `auto`, or a language whisper knows.
pub fn valid_language(code: &str) -> bool {
    super::whisper::quiet();
    code == "auto" || whisper_rs::get_lang_id(code).is_some()
}

/// The model's file, if it has been downloaded (a download only gets this name once it's whole).
pub fn installed(models_dir: &Path, model: ModelId) -> Option<PathBuf> {
    let p = models_dir.join(model.file());
    p.is_file().then_some(p)
}

/// A ggml model file starts with the magic number 0x67676d6c ("ggml"), little-endian.
fn has_ggml_magic(path: &Path) -> bool {
    use std::io::Read;
    let mut b = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut b)).is_ok() && u32::from_le_bytes(b) == 0x6767_6d6c
}

/// Downloads `model` into `models_dir`: streamed into `<file>.part`, checked (whole, the size we
/// expect, a ggml file), then renamed, so a half-downloaded model is never used. Blocking (runs its
/// own small async runtime); `progress` gets 0…1.
pub fn download(models_dir: &Path, model: ModelId, mut progress: impl FnMut(f64)) -> Result<PathBuf, String> {
    std::fs::create_dir_all(models_dir).map_err(|e| format!("Couldn't make the models folder: {e}"))?;
    let target = models_dir.join(model.file());
    let part = models_dir.join(format!("{}.part", model.file()));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    let result = rt.block_on(fetch(&model.url(), &part, model.size_mb() * 1_000_000, &mut progress));
    if let Err(e) = result {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    if !has_ggml_magic(&part) {
        let _ = std::fs::remove_file(&part);
        return Err("The downloaded speech model isn't a model file.".into());
    }
    std::fs::rename(&part, &target).map_err(|e| format!("Couldn't save the speech model: {e}"))?;
    Ok(target)
}

async fn fetch(url: &str, part: &Path, expected: u64, progress: &mut impl FnMut(f64)) -> Result<(), String> {
    let offline = |e: reqwest::Error| {
        if e.is_connect() || e.is_timeout() {
            "Couldn't reach huggingface.co to download the speech model. Check the internet connection.".to_string()
        } else {
            format!("The speech model download stopped: {e}")
        }
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // A stalled connection fails instead of hanging forever; a slow one is fine.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(offline)?;
    if !resp.status().is_success() {
        return Err(format!("Couldn't download the speech model (the server said {}).", resp.status()));
    }
    let total = resp.content_length();
    // The size the server gives has to be about the size we expect (a captive portal or error page
    // isn't half a gigabyte).
    if let Some(t) = total
        && ((t as f64) < expected as f64 * 0.9 || (t as f64) > expected as f64 * 1.1)
    {
        return Err(format!("The speech model on the server isn't the expected size ({} MB).", t / 1_000_000));
    }
    let size = total.unwrap_or(expected).max(1);
    let mut file = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(part).map_err(|e| e.to_string())?);
    let mut got: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(offline)?;
        file.write_all(&chunk).map_err(|e| format!("Couldn't save the speech model: {e}"))?;
        got += chunk.len() as u64;
        progress((got as f64 / size as f64).min(1.0));
    }
    file.flush().map_err(|e| format!("Couldn't save the speech model: {e}"))?;
    drop(file);
    match total {
        Some(t) if got != t => Err(format!("The speech model download was cut short ({} of {} MB).", got / 1_000_000, t / 1_000_000)),
        None if (got as f64) < expected as f64 * 0.9 => Err("The speech model download was cut short.".into()),
        _ => Ok(()),
    }
}

/// What the Settings pane lists for each model.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: ModelId,
    pub label: &'static str,
    #[serde(rename = "sizeMB")]
    pub size_mb: u64,
    pub downloaded: bool,
}

/// `transcription_settings_get`'s answer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub model: ModelId,
    pub language: String,
    pub models: Vec<ModelInfo>,
}

pub fn view(settings: &Settings, models_dir: &Path) -> SettingsView {
    SettingsView {
        model: settings.model,
        language: settings.language.clone(),
        models: ModelId::ALL
            .iter()
            .map(|&id| ModelInfo { id, label: id.label(), size_mb: id.size_mb(), downloaded: installed(models_dir, id).is_some() })
            .collect(),
    }
}

/// A model's state when nothing is downloading it.
pub fn resting_state(models_dir: &Path, model: ModelId) -> ModelState {
    if installed(models_dir, model).is_some() { ModelState::Ready } else { ModelState::Missing }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_settings() {
        assert_eq!(ModelId::parse("balanced"), Some(ModelId::Balanced));
        assert_eq!(ModelId::parse("huge"), None);
        assert_eq!(serde_json::to_value(ModelId::Best).unwrap(), "best");
        let dir = std::env::temp_dir().join(format!("promptedit-models-{}", std::process::id()));
        let file = dir.join("transcription.json");
        assert_eq!(Settings::load(&file), Settings::default());
        let s = Settings { model: ModelId::Fast, language: "de".into() };
        s.save(&file).unwrap();
        assert_eq!(Settings::load(&file), s);
        std::fs::write(&file, br#"{"model":"best","language":"klingon"}"#).unwrap();
        assert_eq!(Settings::load(&file), Settings { model: ModelId::Best, language: "auto".into() });
        assert!(valid_language("en") && valid_language("auto") && !valid_language("xx"));
        let v = serde_json::to_value(view(&s, &dir)).unwrap();
        assert_eq!(v["models"][0], serde_json::json!({"id": "fast", "label": "Fast", "sizeMB": 148, "downloaded": false}));
        std::fs::remove_dir_all(&dir).ok();
    }
}
