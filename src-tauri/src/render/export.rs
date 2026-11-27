//! The end of an export (spec §16). The webview renders and encodes the picture (WebCodecs) and
//! mixes the sound; both arrive here in pieces and are written to a job folder. `finish` then:
//! - applies the loudness gain (spec §13) to the mix,
//! - MP4: muxes the encoded stream (`-c:v copy`, tagged BT.709) with AAC sound encoded from 16-bit
//!   PCM (so the mix is hard-clipped at 0 dBFS, as Editroom's) into a faststart MP4,
//! - WAV: writes 24-bit 48 kHz stereo PCM,
//! and moves the result to the chosen path, so a cancelled or failed export leaves nothing behind.

use super::loudness::{Loudness, Meter};
use super::{b64, run_ffmpeg, temp_beside};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

struct Job {
    dir: PathBuf,
    out: PathBuf,
    video: Option<BufWriter<File>>,
    audio: Option<BufWriter<File>>,
}

fn jobs() -> &'static Mutex<HashMap<u64, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Job>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

#[derive(Serialize)]
pub struct Begun {
    pub job: u64,
}

pub fn begin(cache: &Path, out: &str) -> Result<Begun, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let out = PathBuf::from(out);
    if out.parent().is_some_and(|p| !p.as_os_str().is_empty() && !p.is_dir()) {
        return Err("The folder to export to doesn't exist.".into());
    }
    let job = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = cache.join("Export").join(format!("job-{}-{job}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    jobs().lock().unwrap().insert(job, Job { dir, out, video: None, audio: None });
    Ok(Begun { job })
}

const VIDEO_FILE: &str = "video.es";
const AUDIO_FILE: &str = "mix.f32";

/// Appends base64 `data` to the job's encoded picture (`stream = "video"`) or f32 stereo
/// 48 kHz mix (`"audio"`).
pub fn append(job: u64, stream: &str, data: &str) -> Result<(), String> {
    let bytes = b64::decode(data)?;
    let mut jobs = jobs().lock().unwrap();
    let j = jobs.get_mut(&job).ok_or("This export was cancelled.")?;
    let (slot, name) = match stream {
        "video" => (&mut j.video, VIDEO_FILE),
        "audio" => (&mut j.audio, AUDIO_FILE),
        _ => return Err(format!("Unknown stream {stream}")),
    };
    if slot.is_none() {
        *slot = Some(BufWriter::new(File::create(j.dir.join(name)).map_err(|e| e.to_string())?));
    }
    slot.as_mut().unwrap().write_all(&bytes).map_err(|e| e.to_string())
}

fn flush(j: &mut Job) -> Result<(), String> {
    for w in [&mut j.video, &mut j.audio].into_iter().flatten() {
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Streams the mix's interleaved f32 samples through `f`, a block at a time.
fn each_block(path: &Path, mut f: impl FnMut(&[f32]) -> Result<(), String>) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 8 * 48000];
    let mut samples = Vec::with_capacity(buf.len() / 4);
    let mut carry = 0usize;
    loop {
        let n = file.read(&mut buf[carry..]).map_err(|e| e.to_string())?;
        let have = carry + n;
        let whole = have / 8 * 8;
        samples.clear();
        samples.extend(buf[..whole].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
        if !samples.is_empty() {
            f(&samples)?;
        }
        buf.copy_within(whole..have, 0);
        carry = have - whole;
        if n == 0 {
            return Ok(());
        }
    }
}

/// BS.1770 integrated loudness and sample peak of the mix sent so far (None: silent or too short).
pub fn loudness(job: u64) -> Result<Option<Loudness>, String> {
    let path = {
        let mut jobs = jobs().lock().unwrap();
        let j = jobs.get_mut(&job).ok_or("This export was cancelled.")?;
        flush(j)?;
        if j.audio.is_none() {
            return Ok(None);
        }
        j.dir.join(AUDIO_FILE)
    };
    let mut m = Meter::default();
    each_block(&path, |s| {
        m.push(s);
        Ok(())
    })?;
    Ok(m.finish())
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FinishOptions {
    /// "mp4" (picture + AAC sound) or "wav" (sound only, 24-bit).
    pub container: String,
    /// "h264" or "hevc" for MP4.
    #[serde(default)]
    pub codec: Option<String>,
    /// Frame rate as a fraction (e.g. 30000/1001).
    #[serde(default)]
    pub fps_num: u32,
    #[serde(default = "one")]
    pub fps_den: u32,
    /// AAC bit rate in kb/s (256 High, 160 Web).
    #[serde(default = "aac_default")]
    pub audio_kbps: u32,
    /// Loudness normalisation gain, dB, applied to the whole mix.
    #[serde(default)]
    pub gain_db: f64,
}

fn one() -> u32 {
    1
}
fn aac_default() -> u32 {
    256
}

/// Writes the mix as a canonical 48 kHz stereo WAV with `bits` 16 or 24, gain applied, clipped.
fn write_wav(mix: &Path, out: &Path, bits: u16, gain_db: f64) -> Result<(), String> {
    let frames = std::fs::metadata(mix).map_err(|e| e.to_string())?.len() / 8;
    let bytes_per_sample = (bits / 8) as u32;
    let data_len = (frames as u64 * 2 * bytes_per_sample as u64) as u32;
    let mut w = BufWriter::new(File::create(out).map_err(|e| e.to_string())?);
    let mut header = Vec::with_capacity(44);
    header.extend(b"RIFF");
    header.extend((36 + data_len).to_le_bytes());
    header.extend(b"WAVEfmt ");
    header.extend(16u32.to_le_bytes());
    header.extend(1u16.to_le_bytes()); // PCM
    header.extend(2u16.to_le_bytes());
    header.extend(48000u32.to_le_bytes());
    header.extend((48000 * 2 * bytes_per_sample).to_le_bytes());
    header.extend(((2 * bytes_per_sample) as u16).to_le_bytes());
    header.extend(bits.to_le_bytes());
    header.extend(b"data");
    header.extend(data_len.to_le_bytes());
    w.write_all(&header).map_err(|e| e.to_string())?;
    let g = if gain_db.abs() < 1e-9 { 1.0 } else { 10f64.powf(gain_db / 20.0) };
    let mut out_bytes = Vec::new();
    each_block(mix, |s| {
        out_bytes.clear();
        for &x in s {
            let v = x as f64 * g;
            if bits == 16 {
                let q = (v * 32768.0).round().clamp(-32768.0, 32767.0) as i16;
                out_bytes.extend(q.to_le_bytes());
            } else {
                let q = (v * 8388608.0).round().clamp(-8388608.0, 8388607.0) as i32;
                out_bytes.extend(&q.to_le_bytes()[..3]);
            }
        }
        w.write_all(&out_bytes).map_err(|e| e.to_string())
    })?;
    w.flush().map_err(|e| e.to_string())
}

/// Finishes the file and returns its path. The job is gone afterwards, whatever happens.
pub fn finish(job: u64, o: FinishOptions) -> Result<String, String> {
    let mut j = jobs().lock().unwrap().remove(&job).ok_or("This export was cancelled.")?;
    let r = finish_job(&mut j, &o);
    let _ = std::fs::remove_dir_all(&j.dir);
    r
}

fn finish_job(j: &mut Job, o: &FinishOptions) -> Result<String, String> {
    flush(j)?;
    let has_audio = j.audio.is_some();
    let has_video = j.video.is_some();
    j.video = None;
    j.audio = None;
    let mix = j.dir.join(AUDIO_FILE);
    let tmp = temp_beside(&j.out);
    match o.container.as_str() {
        "wav" => {
            if !has_audio {
                return Err("There's no sound to export.".into());
            }
            write_wav(&mix, &tmp, 24, o.gain_db)?;
        }
        "mp4" => {
            if !has_video {
                return Err("No frames were rendered.".into());
            }
            let hevc = o.codec.as_deref() == Some("hevc");
            let rate = format!("{}/{}", o.fps_num.max(1), o.fps_den.max(1));
            let es = j.dir.join(VIDEO_FILE);
            let wav = j.dir.join("mix.wav");
            if has_audio {
                write_wav(&mix, &wav, 16, o.gain_db)?;
            }
            let kbps = format!("{}k", o.audio_kbps);
            // Rec.709 in the stream's own VUI, so players don't guess (spec §16 colour tags).
            let bsf = if hevc {
                "hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"
            } else {
                "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"
            };
            // `-r` on the input (not the raw demuxer's `-framerate`, which mistimes streams
            // without VUI timing): one frame every 1/fps, as encoded.
            let mux = |with_bsf: bool| {
                let s = |v: &'static str| OsStr::new(v);
                let mut a: Vec<&OsStr> = vec![s("-y"), s("-f"), s(if hevc { "hevc" } else { "h264" }), s("-r"), OsStr::new(&rate), s("-i"), es.as_os_str()];
                if has_audio {
                    a.extend([s("-i"), wav.as_os_str()]);
                }
                a.extend([s("-map"), s("0:v:0")]);
                if has_audio {
                    a.extend([s("-map"), s("1:a:0"), s("-c:a"), s("aac"), s("-b:a"), OsStr::new(&kbps)]);
                }
                a.extend([s("-c:v"), s("copy")]);
                if with_bsf {
                    a.extend([s("-bsf:v"), s(bsf)]);
                }
                if hevc {
                    a.extend([s("-tag:v"), s("hvc1")]);
                }
                a.extend([
                    s("-color_primaries"), s("bt709"), s("-color_trc"), s("bt709"), s("-colorspace"), s("bt709"),
                    s("-movflags"), s("+faststart+write_colr"), s("-f"), s("mp4"), tmp.as_os_str(),
                ]);
                run_ffmpeg(&a)
            };
            // Some encoders' parameter sets can't be rewritten by the metadata filter; the
            // container's colour tags still say BT.709 then.
            if let Err(e) = mux(true).or_else(|_| mux(false)) {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("Couldn't write the movie: {e}"));
            }
        }
        other => return Err(format!("Unknown export format {other}")),
    }
    std::fs::rename(&tmp, &j.out)
        .or_else(|_| std::fs::copy(&tmp, &j.out).map(|_| ()).and_then(|_| std::fs::remove_file(&tmp)))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Couldn't save to {}: {e}", j.out.display())
        })?;
    Ok(j.out.to_string_lossy().into_owned())
}

/// Stops a job and deletes everything it wrote.
pub fn cancel(job: u64) {
    if let Some(j) = jobs().lock().unwrap().remove(&job) {
        let _ = std::fs::remove_dir_all(&j.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for c in bytes.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                if i <= c.len() {
                    s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    s.push('=');
                }
            }
        }
        s
    }

    #[test]
    fn wav_export_with_gain_and_mp4_mux() {
        let dir = std::env::temp_dir().join(format!("promptedit-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 1 s of a −20 dBFS 997 Hz tone.
        let mut pcm = vec![];
        for i in 0..48000 {
            let v = (0.1 * (2.0 * std::f64::consts::PI * 997.0 * i as f64 / 48000.0).sin()) as f32;
            pcm.extend(v.to_le_bytes());
            pcm.extend(v.to_le_bytes());
        }
        let out = dir.join("out.wav");
        let job = begin(&dir, out.to_str().unwrap()).unwrap().job;
        for piece in pcm.chunks(9000 * 8 + 3) {
            append(job, "audio", &b64(piece)).unwrap();
        }
        let l = loudness(job).unwrap().unwrap();
        assert!((l.lufs + 20.0).abs() < 0.2, "{l:?}");
        let opts = FinishOptions { container: "wav".into(), codec: None, fps_num: 0, fps_den: 1, audio_kbps: 256, gain_db: 6.0 };
        finish(job, opts).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(bytes.len(), 44 + 48000 * 2 * 3);
        assert_eq!(&bytes[0..4], b"RIFF");
        let peak = bytes[44..].chunks_exact(3).map(|b| ((i32::from_le_bytes([0, b[0], b[1], b[2]])) >> 8).abs()).max().unwrap();
        // 0.1 * 10^(6/20) ≈ 0.1995 of full scale.
        assert!((peak as f64 / 8388608.0 - 0.1995).abs() < 0.002, "{peak}");

        // MP4: a raw H.264 stream from ffmpeg, muxed with the mix.
        let es = dir.join("in.h264");
        assert!(std::process::Command::new(crate::media::tool("ffmpeg"))
            .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1", "-c:v", "libx264", "-bf", "0", "-f", "h264"])
            .arg(&es)
            .status()
            .unwrap()
            .success());
        let mp4 = dir.join("out.mp4");
        let job = begin(&dir, mp4.to_str().unwrap()).unwrap().job;
        append(job, "video", &b64(&std::fs::read(&es).unwrap())).unwrap();
        append(job, "audio", &b64(&pcm)).unwrap();
        let opts = FinishOptions { container: "mp4".into(), codec: Some("h264".into()), fps_num: 30, fps_den: 1, audio_kbps: 256, gain_db: 0.0 };
        finish(job, opts).unwrap();
        let p = crate::media::probe(&mp4).unwrap();
        assert_eq!((p.width, p.height), (320, 240));
        assert!((p.duration - 1.0).abs() < 0.05, "{}", p.duration);
        assert!(p.has_audio);
        assert_eq!(p.color_primaries.as_deref(), Some("bt709"));

        // Cancel removes the job's files.
        let job = begin(&dir, dir.join("never.mp4").to_str().unwrap()).unwrap().job;
        append(job, "video", "AAAA").unwrap();
        cancel(job);
        assert!(append(job, "video", "AAAA").is_err());
        assert!(!dir.join("never.mp4").exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
