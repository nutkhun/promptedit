//! Each file's sound, decoded once into raw PCM the engine streams with Range requests
//! (f32 little-endian, 48 kHz, stereo interleaved: 8 bytes per frame).
//!
//! - Forward: `ffmpeg -map 0:a:0 -ac 2 -ar 48000 -f f32le` (only the first audio track is used,
//!   as in Editroom, spec §10.2; mono is upmixed to both sides).
//! - Reversed (spec §7): the forward PCM written back to front in blocks, streaming, so a long
//!   file never sits in memory (`areverse` would buffer the whole stream).
//! - Speed ≠ 1 (spec §10.4, pitch kept): the PCM time-stretched with ffmpeg's `atempo`
//!   (WSOLA). Editroom uses Apple's spectral algorithm; at extreme speeds the artefacts differ.

use super::{cache_name, run_ffmpeg, temp_beside};
use serde::Serialize;
use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
const FRAME_BYTES: u64 = 4 * CHANNELS as u64;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pcm {
    pub path: String,
    pub frames: u64,
    pub rate: u32,
    pub channels: u32,
    /// Seconds of sound in the file.
    pub duration: f64,
}

fn info(path: &Path) -> Result<Pcm, String> {
    let bytes = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    let frames = bytes / FRAME_BYTES;
    Ok(Pcm {
        path: path.to_string_lossy().into_owned(),
        frames,
        rate: RATE,
        channels: CHANNELS,
        duration: frames as f64 / RATE as f64,
    })
}

fn folder(cache: &Path) -> Result<PathBuf, String> {
    let dir = cache.join("Audio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The forward, reversed and/or stretched PCM of `src`'s first audio track, made on first use.
pub fn pcm(cache: &Path, src: &Path, reversed: bool, speed: f64) -> Result<Pcm, String> {
    if !(speed.is_finite() && speed > 0.0) {
        return Err("Bad speed.".into());
    }
    let dir = folder(cache)?;
    let name = cache_name(src);
    let forward = dir.join(format!("{name}.f32"));
    if !forward.exists() {
        decode(src, &forward)?;
    }
    let base = if reversed {
        let rev = dir.join(format!("{name}-rev.f32"));
        if !rev.exists() {
            reverse(&forward, &rev)?;
        }
        rev
    } else {
        forward
    };
    if (speed - 1.0).abs() < 1e-9 {
        return info(&base);
    }
    let stretched = dir.join(format!("{name}{}-x{:.5}.f32", if reversed { "-rev" } else { "" }, speed));
    if !stretched.exists() {
        stretch(&base, &stretched, speed)?;
    }
    info(&stretched)
}

fn decode(src: &Path, out: &Path) -> Result<(), String> {
    let tmp = temp_beside(out);
    let mut a: Vec<&OsStr> = vec![OsStr::new("-y"), OsStr::new("-i"), src.as_os_str()];
    let rate = RATE.to_string();
    for s in ["-map", "0:a:0", "-vn", "-ac", "2", "-ar", rate.as_str(), "-f", "f32le", "-c:a", "pcm_f32le"] {
        a.push(OsStr::new(s));
    }
    a.push(tmp.as_os_str());
    let r = run_ffmpeg(&a);
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(if e.is_empty() { "This file's sound couldn't be read.".into() } else { e });
    }
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())
}

/// Writes `src`'s frames in reverse order, a block at a time.
pub(crate) fn reverse(src: &Path, out: &Path) -> Result<(), String> {
    const BLOCK: u64 = 256 * 1024; // frames
    let mut input = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let frames = input.metadata().map_err(|e| e.to_string())?.len() / FRAME_BYTES;
    let tmp = temp_beside(out);
    let mut output = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
    let mut buf = vec![0u8; (BLOCK * FRAME_BYTES) as usize];
    let mut end = frames;
    while end > 0 {
        let start = end.saturating_sub(BLOCK);
        let n = ((end - start) * FRAME_BYTES) as usize;
        input.seek(SeekFrom::Start(start * FRAME_BYTES)).map_err(|e| e.to_string())?;
        input.read_exact(&mut buf[..n]).map_err(|e| e.to_string())?;
        for frame in buf[..n].chunks_exact(FRAME_BYTES as usize).rev() {
            output.write_all(frame).map_err(|e| e.to_string())?;
        }
        end = start;
    }
    output.flush().map_err(|e| e.to_string())?;
    drop(output);
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())
}

/// `atempo` factors whose product is `speed`, each within 0.5…2 (the range every ffmpeg accepts).
pub(crate) fn atempo_chain(speed: f64) -> String {
    let mut s = speed;
    let mut parts = vec![];
    while s > 2.0 {
        parts.push(2.0);
        s /= 2.0;
    }
    while s < 0.5 {
        parts.push(0.5);
        s /= 0.5;
    }
    parts.push(s);
    parts.iter().map(|f| format!("atempo={f:.6}")).collect::<Vec<_>>().join(",")
}

fn stretch(src: &Path, out: &Path, speed: f64) -> Result<(), String> {
    let tmp = temp_beside(out);
    let rate = RATE.to_string();
    let filter = atempo_chain(speed);
    let mut a: Vec<&OsStr> = vec![];
    for s in ["-y", "-f", "f32le", "-ar", rate.as_str(), "-ac", "2", "-i"] {
        a.push(OsStr::new(s));
    }
    a.push(src.as_os_str());
    for s in ["-af", filter.as_str(), "-f", "f32le", "-c:a", "pcm_f32le"] {
        a.push(OsStr::new(s));
    }
    a.push(tmp.as_os_str());
    if let Err(e) = run_ffmpeg(&a) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())
}

/// Reads interleaved f32 frames `[start, start+count)` of a PCM cache file (zeros past its end).
pub fn read_frames(file: &mut std::fs::File, start: u64, count: usize) -> std::io::Result<Vec<f32>> {
    let total = file.metadata()?.len() / FRAME_BYTES;
    let mut out = vec![0f32; count * CHANNELS as usize];
    if start >= total {
        return Ok(out);
    }
    let n = ((total - start) as usize).min(count);
    let mut bytes = vec![0u8; n * FRAME_BYTES as usize];
    file.seek(SeekFrom::Start(start * FRAME_BYTES))?;
    file.read_exact(&mut bytes)?;
    for (o, b) in out.iter_mut().zip(bytes.chunks_exact(4)) {
        *o = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_multiplies_to_speed() {
        for s in [0.1, 0.25, 0.5, 0.8, 1.5, 2.0, 3.0, 8.0, 32.0] {
            let product: f64 = atempo_chain(s)
                .split(',')
                .map(|p| p.trim_start_matches("atempo=").parse::<f64>().unwrap())
                .inspect(|f| assert!((0.5 - 1e-9..=2.0 + 1e-9).contains(f)))
                .product();
            assert!((product - s).abs() < 1e-4, "{s}: {product}");
        }
    }

    #[test]
    fn decodes_reverses_and_stretches() {
        let dir = std::env::temp_dir().join(format!("promptedit-audio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("tone.wav");
        // 1 s: silence for the first half, a tone in the second.
        assert!(std::process::Command::new(crate::media::tool("ffmpeg"))
            .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=if(gte(t\\,0.5)\\,0.5*sin(2*PI*440*t)\\,0):s=44100:d=1"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let fwd = pcm(&dir, &src, false, 1.0).unwrap();
        assert_eq!(fwd.rate, 48000);
        assert!((fwd.duration - 1.0).abs() < 0.01, "{}", fwd.duration);
        let mut f = std::fs::File::open(&fwd.path).unwrap();
        let head = read_frames(&mut f, 0, 1000).unwrap();
        assert!(head.iter().all(|v| v.abs() < 1e-4), "forward starts silent");

        let rev = pcm(&dir, &src, true, 1.0).unwrap();
        assert_eq!(rev.frames, fwd.frames);
        let mut r = std::fs::File::open(&rev.path).unwrap();
        let rhead = read_frames(&mut r, 0, 4800).unwrap();
        assert!(rhead.iter().any(|v| v.abs() > 0.1), "reversed starts with the tone");
        // Frame i of the reversal is frame (n-1-i) of the original.
        let last = read_frames(&mut f, fwd.frames - 10, 10).unwrap();
        let first = read_frames(&mut r, 0, 10).unwrap();
        for i in 0..10 {
            assert_eq!(first[i * 2], last[(9 - i) * 2]);
        }

        let fast = pcm(&dir, &src, false, 2.0).unwrap();
        assert!((fast.duration - 0.5).abs() < 0.03, "{}", fast.duration);
        std::fs::remove_dir_all(&dir).ok();
    }
}
