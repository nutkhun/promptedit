//! Media files: probing with ffprobe, and making a playable copy of files the engine can't
//! decode (Editroom/Engine/MediaStore.swift `probe` and `makePlayable`).
//!
//! FFmpeg runs as a separate program (a Tauri sidecar), as in Editroom, which keeps it LGPL.

use promptedit_core::{Id, MediaAsset, MediaKind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where a bundled tool lives: next to the app's executable in a build, in
/// `src-tauri/binaries` during development, or `PROMPTEDIT_<NAME>` to override.
pub fn tool(name: &str) -> PathBuf {
    if let Ok(p) = std::env::var(format!("PROMPTEDIT_{}", name.to_uppercase())) {
        return PathBuf::from(p);
    }
    let exe_name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let p = dir.join(&exe_name);
        if p.exists() {
            return p;
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{}{}", env!("TARGET_TRIPLE"), std::env::consts::EXE_SUFFIX));
    if dev.exists() {
        return dev;
    }
    PathBuf::from(exe_name)
}

fn command(name: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(tool(name));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// What ffprobe says about a file, as much as the app needs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub kind: MediaKind,
    pub duration: f64,
    /// Display size, after rotation.
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub has_audio: bool,
    /// Rotation to apply when drawing, in degrees clockwise (0, 90, 180, 270).
    pub rotation: i64,
    pub container: String,
    pub video_codec: Option<String>,
    /// WebCodecs codec string for the video stream, when there's one we can name.
    pub codec_string: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_rate: Option<i64>,
    pub audio_channels: Option<i64>,
    /// Colour primaries / transfer, for HDR tone mapping (e.g. "bt2020", "arib-std-b67").
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeOut {
    #[serde(default)]
    streams: Vec<FfStream>,
    format: Option<FfFormat>,
}

#[derive(Deserialize)]
struct FfFormat {
    format_name: Option<String>,
    duration: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FfStream {
    codec_type: String,
    codec_name: Option<String>,
    profile: Option<String>,
    level: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
    sample_rate: Option<String>,
    channels: Option<i64>,
    color_primaries: Option<String>,
    color_transfer: Option<String>,
    disposition: Option<serde_json::Value>,
    side_data_list: Option<Vec<serde_json::Value>>,
    tags: Option<serde_json::Value>,
    nb_frames: Option<String>,
}

fn rate(s: &Option<String>) -> f64 {
    let Some(s) = s else { return 0.0 };
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(0.0));
            if b > 0.0 { a / b } else { 0.0 }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

const IMAGE_CODECS: &[&str] = &["png", "mjpeg", "jpeg2000", "webp", "bmp", "tiff", "gif", "heic", "hevc_image", "jpegxl"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "bmp", "gif", "webp", "jxl"];

pub fn probe(path: &Path) -> Result<Probe, String> {
    let out = command("ffprobe")
        .args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format"])
        .arg(path)
        .output()
        .map_err(|e| format!("Couldn't run ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(format!("Couldn't read {}.", path.display()));
    }
    let parsed: FfprobeOut = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let container = parsed.format.as_ref().and_then(|f| f.format_name.clone()).unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();

    let is_attached_pic = |s: &FfStream| {
        s.disposition.as_ref().and_then(|d| d.get("attached_pic")).and_then(|v| v.as_i64()) == Some(1)
    };
    let video = parsed.streams.iter().find(|s| s.codec_type == "video" && !is_attached_pic(s));
    let audio = parsed.streams.iter().find(|s| s.codec_type == "audio");

    let format_duration = parsed.format.as_ref().and_then(|f| f.duration.as_ref()).and_then(|d| d.parse::<f64>().ok());
    let still = video.is_some_and(|v| {
        IMAGE_EXTENSIONS.contains(&ext.as_str())
            || (v.codec_name.as_deref().is_some_and(|c| IMAGE_CODECS.contains(&c))
                && (container.contains("image2") || container.ends_with("_pipe") || v.nb_frames.as_deref() == Some("1")))
    });

    let kind = if still {
        MediaKind::Image
    } else if video.is_some() {
        MediaKind::Video
    } else if audio.is_some() {
        MediaKind::Audio
    } else {
        return Err("No picture or sound in this file.".into());
    };

    let mut p = Probe {
        kind,
        duration: 0.0,
        width: 0,
        height: 0,
        fps: 0.0,
        has_audio: audio.is_some(),
        rotation: 0,
        container: container.clone(),
        video_codec: None,
        codec_string: None,
        audio_codec: audio.and_then(|a| a.codec_name.clone()),
        audio_rate: audio.and_then(|a| a.sample_rate.as_ref()?.parse().ok()),
        audio_channels: audio.and_then(|a| a.channels),
        color_primaries: None,
        color_transfer: None,
    };

    if let Some(v) = video {
        let rotation = rotation_of(v);
        let (w, h) = (v.width.unwrap_or(0), v.height.unwrap_or(0));
        let quarter = rotation % 180 != 0;
        p.width = if quarter { h } else { w };
        p.height = if quarter { w } else { h };
        p.rotation = rotation;
        p.fps = {
            let a = rate(&v.avg_frame_rate);
            if a > 0.0 && a < 1000.0 { a } else { rate(&v.r_frame_rate) }
        };
        p.video_codec = v.codec_name.clone();
        p.codec_string = codec_string(v);
        p.color_primaries = v.color_primaries.clone();
        p.color_transfer = v.color_transfer.clone();
    }

    p.duration = match kind {
        MediaKind::Image => 0.0,
        MediaKind::Video => video
            .and_then(|v| v.duration.as_ref()?.parse::<f64>().ok())
            .or(format_duration)
            .unwrap_or(0.0),
        MediaKind::Audio => audio
            .and_then(|a| a.duration.as_ref()?.parse::<f64>().ok())
            .or(format_duration)
            .unwrap_or(0.0),
    };
    if kind != MediaKind::Image && !(p.duration.is_finite() && p.duration > 0.0) {
        return Err("This file has no length.".into());
    }
    Ok(p)
}

fn rotation_of(v: &FfStream) -> i64 {
    let from_side = v.side_data_list.iter().flatten().find_map(|sd| sd.get("rotation").and_then(|r| r.as_f64()));
    let from_tag = v.tags.as_ref().and_then(|t| t.get("rotate")).and_then(|r| r.as_str()?.parse::<f64>().ok());
    let deg = from_side.or(from_tag).unwrap_or(0.0);
    // ffprobe's display-matrix rotation is counter-clockwise; we store clockwise.
    let cw = (-deg).rem_euclid(360.0);
    ((cw / 90.0).round() as i64 % 4) * 90
}

/// A WebCodecs codec string (RFC 6381) for the stream, when it's a codec WebCodecs knows.
fn codec_string(v: &FfStream) -> Option<String> {
    let codec = v.codec_name.as_deref()?;
    let profile = v.profile.as_deref().unwrap_or("").to_lowercase();
    let level = v.level.unwrap_or(-99);
    match codec {
        "h264" => {
            let p = if profile.contains("high 4:4:4") {
                0xF4
            } else if profile.contains("high 4:2:2") {
                0x7A
            } else if profile.contains("high 10") {
                0x6E
            } else if profile.contains("high") {
                0x64
            } else if profile.contains("main") {
                0x4D
            } else {
                0x42
            };
            let l = if level > 0 { level } else { 51 };
            Some(format!("avc1.{p:02X}00{l:02X}"))
        }
        "hevc" => {
            let p = if profile.contains("main 10") { 2 } else { 1 };
            let l = if level > 0 { level } else { 153 };
            Some(format!("hvc1.{p}.4.L{l}.B0"))
        }
        "vp9" => Some("vp09.00.10.08".into()),
        "vp8" => Some("vp8".into()),
        "av1" => Some("av01.0.08M.08".into()),
        _ => None,
    }
}

/// Containers the engine's demuxer reads directly.
pub fn container_is_native(p: &Probe) -> bool {
    p.container.split(',').any(|c| matches!(c, "mov" | "mp4" | "m4a" | "3gp" | "3g2" | "mj2"))
}

/// A stable name for a converted copy: same file, same name on every launch (FNV-1a, as Editroom).
fn copy_name(src: &Path) -> String {
    let meta = std::fs::metadata(src).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let stamp = format!("{}|{size}|{modified}", src.display());
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in stamp.bytes() {
        hash = (hash ^ b as u64).wrapping_mul(0x100000001b3);
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "media".into());
    format!("{stem}-{}.mov", radix36(hash))
}

fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut s = Vec::new();
    while n > 0 {
        s.push(D[(n % 36) as usize]);
        n /= 36;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

fn run_ffmpeg(args: &[&std::ffi::OsStr]) -> bool {
    command("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Hardware H.264 encoders to try for a playable copy, best first, then software ones.
fn h264_encoders() -> &'static [&'static [&'static str]] {
    if cfg!(target_os = "macos") {
        &[&["-c:v", "h264_videotoolbox", "-q:v", "70"]]
    } else if cfg!(windows) {
        &[
            &["-c:v", "h264_nvenc", "-cq", "21"],
            &["-c:v", "h264_qsv", "-global_quality", "21"],
            &["-c:v", "h264_amf", "-quality", "quality"],
            &["-c:v", "h264_mf", "-b:v", "40M"],
            &["-c:v", "libopenh264", "-b:v", "40M"],
        ]
    } else {
        &[&["-c:v", "libx264", "-crf", "18"], &["-c:v", "libopenh264", "-b:v", "40M"]]
    }
}

/// Rewraps (or, failing that, transcodes) a file into a QuickTime file the engine decodes.
/// `transcode` skips the rewrap, for codecs the engine can't decode at all. Returns the copy.
pub fn make_playable(src: &Path, cache_dir: &Path, transcode: bool) -> Option<PathBuf> {
    std::fs::create_dir_all(cache_dir).ok()?;
    let out = cache_dir.join(copy_name(src));
    if out.exists() && probe(&out).is_ok() {
        return Some(out);
    }
    let s = src.as_os_str();
    let o = out.as_os_str();
    fn os<'a>(v: &[&'a str]) -> Vec<&'a std::ffi::OsStr> {
        v.iter().map(|s| std::ffi::OsStr::new(*s)).collect()
    }
    let base = || {
        let mut a = os(&["-y", "-i"]);
        a.push(s);
        a.extend(os(&["-map", "0:v:0?", "-map", "0:a:0?"]));
        a
    };
    if !transcode {
        // 1. Stream copy into a QuickTime container (instant for H.264/HEVC inside MKV etc).
        //    Sound is decoded by FFmpeg separately, so any sound codec can stay as it is,
        //    but a copy QuickTime can't hold falls back to AAC.
        for tag in [&["-tag:v", "hvc1"][..], &[][..]] {
            let mut a = base();
            a.extend(os(&["-c", "copy"]));
            a.extend(os(tag));
            a.push(o);
            if run_ffmpeg(&a) && probe(&out).is_ok() {
                return Some(out);
            }
            let mut a = base();
            a.extend(os(&["-c:v", "copy"]));
            a.extend(os(tag));
            a.extend(os(&["-c:a", "aac", "-b:a", "256k"]));
            a.push(o);
            if run_ffmpeg(&a) && probe(&out).is_ok() {
                return Some(out);
            }
        }
    }
    // 2. Full transcode, hardware encoder first. Keyframes every second keep scrubbing quick.
    for enc in h264_encoders() {
        let mut a = base();
        a.extend(os(enc));
        a.extend(os(&["-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-b:a", "256k"]));
        a.push(o);
        if run_ffmpeg(&a) && probe(&out).is_ok() {
            return Some(out);
        }
    }
    let _ = std::fs::remove_file(&out);
    None
}

/// A library item for a probed file.
pub fn asset_for(path: &Path, p: &Probe) -> MediaAsset {
    MediaAsset {
        id: Id::new(),
        path: path.to_string_lossy().into_owned(),
        relative_path: None,
        playable_path: None,
        // Editroom names an item after its file, without the extension.
        name: path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        kind: p.kind,
        duration: p.duration,
        width: p.width,
        height: p.height,
        fps: p.fps,
        has_audio: p.has_audio,
        bookmark: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_clip(dir: &Path, name: &str, extra: &[&str]) -> PathBuf {
        let out = dir.join(name);
        let mut a: Vec<&str> = vec![
            "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2", "-f", "lavfi", "-i",
            "sine=frequency=440:duration=2",
        ];
        a.extend(extra);
        let status = command("ffmpeg").args(["-hide_banner", "-loglevel", "error"]).args(&a).arg(&out).status();
        assert!(status.unwrap().success(), "ffmpeg made {name}");
        out
    }

    #[test]
    fn probes_and_converts() {
        let dir = std::env::temp_dir().join(format!("promptedit-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mp4 = make_clip(&dir, "a.mp4", &["-c:v", "mpeg4", "-c:a", "aac"]);
        let p = probe(&mp4).unwrap();
        assert_eq!(p.kind, MediaKind::Video);
        assert_eq!((p.width, p.height), (640, 360));
        assert!((p.fps - 25.0).abs() < 0.01);
        assert!((p.duration - 2.0).abs() < 0.1);
        assert!(p.has_audio);
        assert!(container_is_native(&p));

        let mkv = make_clip(&dir, "b.mkv", &["-c:v", "mpeg4", "-c:a", "flac"]);
        let p = probe(&mkv).unwrap();
        assert!(!container_is_native(&p));
        let copy = make_playable(&mkv, &dir.join("converted"), false).expect("rewrapped");
        let q = probe(&copy).unwrap();
        assert!(container_is_native(&q));
        assert_eq!(q.video_codec.as_deref(), Some("mpeg4"), "picture copied, not re-encoded");

        let wav = dir.join("c.wav");
        assert!(command("ffmpeg").args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1"]).arg(&wav).status().unwrap().success());
        assert_eq!(probe(&wav).unwrap().kind, MediaKind::Audio);
        std::fs::remove_dir_all(&dir).ok();
    }
}
