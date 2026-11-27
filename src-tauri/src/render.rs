//! Media work the webview can't do itself, for the engine in `src/engine`: sound pulled out of
//! files once as raw PCM (so Web Audio can stream it with Range requests), waveforms, loudness
//! measurement (BS.1770) and the export's final mux. See docs/spec/02-engine.md §7, §10, §11, §13, §16.
//!
//! Every command is available both as a Tauri command and through `dispatch` (the browser dev
//! server). Results that are big (PCM, waveforms) are written to cache files and returned as paths;
//! the webview reads them with `fileURL`, which supports Range requests.

pub mod audio;
mod b64;
pub mod export;
pub mod loudness;
pub mod waveform;

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

/// ffmpeg (the bundled sidecar, see `media::tool`), without a console window on Windows.
pub(crate) fn ffmpeg() -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(crate::media::tool("ffmpeg"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    c
}

/// Runs ffmpeg to completion; the error carries ffmpeg's own message.
pub(crate) fn run_ffmpeg(args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let out = ffmpeg().args(args).output().map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// A cache file name that changes when the file does: `<stem>-<fnv1a64(path|size|mtime) base36>`
/// (Editroom's `cacheName`, spec §15.4; byte-compatible names aren't needed, only the same rule).
pub(crate) fn cache_name(src: &Path) -> String {
    let meta = std::fs::metadata(src).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stamp = format!("{}|{size}|{modified}", src.display());
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in stamp.bytes() {
        hash = (hash ^ b as u64).wrapping_mul(0x100000001b3);
    }
    let stem: String = src
        .file_stem()
        .map(|s| s.to_string_lossy().chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' ')).take(60).collect())
        .unwrap_or_else(|| "media".into());
    format!("{stem}-{}", radix36(hash))
}

fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = Vec::new();
    loop {
        s.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

/// A temporary name next to `path`, unique to this process and call, for write-then-rename.
pub(crate) fn temp_beside(path: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let mut name = path.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    name.push(format!(".{}-{n}.tmp", std::process::id()));
    path.with_file_name(name)
}

fn ok<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// The render commands by name, for `crate::dispatch` (the dev server). None: not one of ours.
pub fn dispatch(cache_dir: &Path, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string).ok_or(format!("Missing {k}"));
    let f = |k: &str| args.get(k).and_then(Value::as_f64);
    let u = |k: &str| args.get(k).and_then(Value::as_u64).ok_or(format!("Missing {k}"));
    let r = match cmd {
        "audio_pcm" => (|| {
            let path = s("path")?;
            let reversed = args.get("reversed").and_then(Value::as_bool).unwrap_or(false);
            ok(audio::pcm(cache_dir, Path::new(&path), reversed, f("speed").unwrap_or(1.0))?)
        })(),
        "audio_waveform" => (|| ok(waveform::waveform(cache_dir, Path::new(&s("path")?))?))(),
        "export_begin" => (|| ok(export::begin(cache_dir, &s("path")?)?))(),
        "export_append" => (|| {
            export::append(u("job")?, &s("stream")?, &s("data")?)?;
            Ok(Value::Null)
        })(),
        "export_loudness" => (|| ok(export::loudness(u("job")?)?))(),
        "export_finish" => (|| {
            let opts: export::FinishOptions =
                serde_json::from_value(args.get("options").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?;
            ok(export::finish(u("job")?, opts)?)
        })(),
        "export_cancel" => (|| {
            export::cancel(u("job")?);
            Ok(Value::Null)
        })(),
        _ => return None,
    };
    Some(r)
}

// ---- Tauri commands (the same functions; blocking work runs off the main thread) ----

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Decodes a file's first audio track once to f32le 48 kHz stereo (optionally reversed and/or
/// time-stretched with pitch kept) and returns the cache file.
#[tauri::command]
pub async fn audio_pcm(app: tauri::AppHandle, path: String, reversed: Option<bool>, speed: Option<f64>) -> Result<audio::Pcm, String> {
    let cache = cache_dir(&app)?;
    blocking(move || audio::pcm(&cache, Path::new(&path), reversed.unwrap_or(false), speed.unwrap_or(1.0))).await
}

/// Waveform peaks/left/right/rms at 200 per second, as Editroom's `.wave` cache file.
#[tauri::command]
pub async fn audio_waveform(app: tauri::AppHandle, path: String) -> Result<waveform::WaveInfo, String> {
    let cache = cache_dir(&app)?;
    blocking(move || waveform::waveform(&cache, Path::new(&path))).await
}

#[tauri::command]
pub async fn export_begin(app: tauri::AppHandle, path: String) -> Result<export::Begun, String> {
    let cache = cache_dir(&app)?;
    blocking(move || export::begin(&cache, &path)).await
}

#[tauri::command]
pub async fn export_append(job: u64, stream: String, data: String) -> Result<(), String> {
    blocking(move || export::append(job, &stream, &data)).await
}

#[tauri::command]
pub async fn export_loudness(job: u64) -> Result<Option<loudness::Loudness>, String> {
    blocking(move || export::loudness(job)).await
}

#[tauri::command]
pub async fn export_finish(job: u64, options: export::FinishOptions) -> Result<String, String> {
    blocking(move || export::finish(job, options)).await
}

#[tauri::command]
pub fn export_cancel(job: u64) {
    export::cancel(job)
}
