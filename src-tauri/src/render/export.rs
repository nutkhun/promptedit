//! The end of an export (spec §16). The webview renders and encodes the picture (WebCodecs) and
//! mixes the sound; both arrive here in pieces and are written to a job folder. `finish` then:
//! - applies the loudness gain (spec §13) to the mix,
//! - MP4: muxes the encoded stream (`-c:v copy`, tagged BT.709) with AAC sound encoded from 16-bit
//!   PCM (so the mix is hard-clipped at 0 dBFS, as Editroom's) into a faststart MP4,
//! - WAV: writes 24-bit 48 kHz stereo PCM,
//! - MP3: encodes the mix with LAME at a constant 192 or 320 kb/s,
//! - MOV (ProRes): the frames arrived raw and were encoded as they came (`prores`, started by
//!   `video_start` once the mix and its gain are known); waits for FFmpeg to finish the file,
//! and moves the result to the chosen path, so a cancelled or failed export leaves nothing behind.

use super::loudness::{Loudness, Meter};
use super::prores::{Pipe, VideoOptions};
use super::{b64, run_ffmpeg, temp_beside};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Job {
    dir: PathBuf,
    out: PathBuf,
    video: Option<BufWriter<File>>,
    audio: Option<BufWriter<File>>,
    /// ProRes: FFmpeg encoding the frames as they arrive.
    pipe: Option<Pipe>,
    /// When the webview last sent anything (see `reap`).
    touched: Instant,
}

fn jobs() -> &'static Mutex<HashMap<u64, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Job>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

/// A job nobody has sent anything to for this long was left behind (the webview reloaded or
/// closed mid-export); every frame and every piece of sound counts as activity.
const ABANDONED: Duration = Duration::from_secs(10 * 60);

/// Cancels abandoned jobs now and then, so a ProRes encoder doesn't wait forever and then
/// finish a partial file beside the person's export.
fn start_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            reap(ABANDONED);
        });
    });
}

fn reap(after: Duration) {
    let stale: Vec<u64> = jobs().lock().unwrap().iter().filter(|(_, j)| j.touched.elapsed() >= after).map(|(&k, _)| k).collect();
    for job in stale {
        cancel(job);
    }
}

/// Cancels every job (the app is quitting: stop the encoders rather than let them finish
/// partial files when their input closes).
pub fn cancel_all() {
    let all: Vec<u64> = jobs().lock().unwrap().keys().copied().collect();
    for job in all {
        cancel(job);
    }
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
    jobs().lock().unwrap().insert(job, Job { dir, out, video: None, audio: None, pipe: None, touched: Instant::now() });
    start_reaper();
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
    j.touched = Instant::now();
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

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoStart {
    #[serde(flatten)]
    pub video: VideoOptions,
    /// Loudness normalisation gain, dB, applied to the mix sent so far.
    #[serde(default)]
    pub gain_db: f64,
}

/// Starts encoding frames that arrive raw (ProRes), with the mix sent so far as the sound. Called
/// after the sound is mixed and measured, so its gain is known and the movie is made in one pass.
pub fn video_start(job: u64, o: VideoStart) -> Result<(), String> {
    let mut jobs = jobs().lock().unwrap();
    let j = jobs.get_mut(&job).ok_or("This export was cancelled.")?;
    j.touched = Instant::now();
    if j.pipe.is_some() {
        return Err("This export is already encoding.".into());
    }
    flush(j)?;
    let wav = j.dir.join("mix.wav");
    let audio = if j.audio.is_some() {
        j.audio = None;
        write_wav(&j.dir.join(AUDIO_FILE), &wav, 24, o.gain_db)?;
        Some(wav.as_path())
    } else {
        None
    };
    j.pipe = Some(Pipe::start(&o.video, audio, temp_beside(&j.out))?);
    Ok(())
}

/// Appends raw frame bytes (v210) to the job's encoder, in order.
pub fn append_frames(job: u64, bytes: &[u8]) -> Result<(), String> {
    // Written outside the job table's lock, so a busy encoder doesn't hold up a cancel.
    let w = {
        let mut jobs = jobs().lock().unwrap();
        let j = jobs.get_mut(&job).ok_or("This export was cancelled.")?;
        j.touched = Instant::now();
        j.pipe.as_ref().ok_or("This export isn't encoding frames.")?.writer()
    };
    w.write(bytes)
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
    /// "mp4" (picture + AAC sound), "mov" (ProRes + PCM, see `video_start`), "wav" (sound only,
    /// 24-bit) or "mp3" (sound only).
    pub container: String,
    /// "h264" or "hevc" for MP4.
    #[serde(default)]
    pub codec: Option<String>,
    /// Frame rate as a fraction (e.g. 30000/1001).
    #[serde(default)]
    pub fps_num: u32,
    #[serde(default = "one")]
    pub fps_den: u32,
    /// AAC bit rate in kb/s (256 High, 160 Web); MP3's (320 or 192).
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
    if o.container == "mov" {
        let tmp = j.pipe.take().ok_or("No frames were rendered.")?.finish()?;
        return save(&tmp, &j.out);
    }
    let tmp = temp_beside(&j.out);
    match o.container.as_str() {
        "wav" => {
            if !has_audio {
                return Err("There's no sound to export.".into());
            }
            write_wav(&mix, &tmp, 24, o.gain_db)?;
        }
        "mp3" => {
            if !has_audio {
                return Err("There's no sound to export.".into());
            }
            if !super::encoders::encoders().mp3 {
                return Err("This copy of FFmpeg can't make MP3s (it has no LAME encoder).".into());
            }
            // From 24-bit PCM with the gain applied (clipped at 0 dBFS, as every other export).
            let wav = j.dir.join("mix.wav");
            write_wav(&mix, &wav, 24, o.gain_db)?;
            let kbps = format!("{}k", if o.audio_kbps >= 256 { 320 } else { 192 });
            let s = OsStr::new;
            // `-b:a` alone is constant bit rate with LAME; the Xing/LAME header carries the
            // encoder delay, so players can trim it.
            let a = [s("-y"), s("-i"), wav.as_os_str(), s("-map"), s("0:a:0"), s("-c:a"), s("libmp3lame"), s("-b:a"), s(&kbps),
                s("-id3v2_version"), s("3"), s("-f"), s("mp3"), tmp.as_os_str()];
            if let Err(e) = run_ffmpeg(&a) {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("Couldn't write the MP3: {e}"));
            }
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
    save(&tmp, &j.out)
}

/// Moves the finished file into place (copying when it's on another volume) and returns its path.
fn save(tmp: &Path, out: &Path) -> Result<String, String> {
    std::fs::rename(tmp, out)
        .or_else(|_| std::fs::copy(tmp, out).map(|_| ()).and_then(|_| std::fs::remove_file(tmp)))
        .map_err(|e| {
            let _ = std::fs::remove_file(tmp);
            format!("Couldn't save to {}: {e}", out.display())
        })?;
    Ok(out.to_string_lossy().into_owned())
}

/// Stops a job and deletes everything it wrote (a running encoder is stopped as its `Pipe` drops).
pub fn cancel(job: u64) {
    let j = jobs().lock().unwrap().remove(&job);
    if let Some(j) = j {
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

    fn ffprobe_with(path: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new(crate::media::tool("ffprobe"))
            .args(["-v", "error", "-of", "default=nw=1:nk=1"])
            .args(args)
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().lines().collect::<Vec<_>>().join("|")
    }
    fn ffprobe(path: &Path, stream: &str, entries: &str) -> String {
        ffprobe_with(path, &["-select_streams", stream, "-show_entries", &format!("stream={entries}")])
    }
    fn ffprobe_format(path: &Path, entries: &str) -> String {
        ffprobe_with(path, &["-show_entries", &format!("format={entries}")])
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

        // ProRes: v210 frames (made by ffmpeg here, by the webview in the app) encoded as they
        // arrive, with the mix as 24-bit PCM, in a MOV. Every sidecar (and CI's ffmpeg) has both.
        let encoders = crate::render::encoders::encoders();
        assert!(encoders.prores.is_some() && encoders.mp3, "{encoders:?}");
        {
            let v210 = dir.join("in.v210");
            assert!(std::process::Command::new(crate::media::tool("ffmpeg"))
                .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1", "-c:v", "v210", "-f", "rawvideo"])
                .arg(&v210)
                .status()
                .unwrap()
                .success());
            let frames = std::fs::read(&v210).unwrap();
            assert_eq!(frames.len(), 30 * crate::render::prores::v210_frame_bytes(320, 240));
            let mov = dir.join("out.mov");
            let job = begin(&dir, mov.to_str().unwrap()).unwrap().job;
            append(job, "audio", &b64(&pcm)).unwrap();
            let video = VideoOptions { codec: "prores".into(), profile: Some("hq".into()), width: 320, height: 240, fps_num: 30, fps_den: 1 };
            video_start(job, VideoStart { video, gain_db: -6.0 }).unwrap();
            // Pieces that don't line up with frames are fine; the stream is just bytes.
            for piece in frames.chunks(100_003) {
                append_frames(job, piece).unwrap();
            }
            finish(job, FinishOptions { container: "mov".into(), codec: None, fps_num: 30, fps_den: 1, audio_kbps: 0, gain_db: 0.0 }).unwrap();
            let v = ffprobe(&mov, "v:0", "codec_name,profile,width,height,pix_fmt,color_primaries");
            assert_eq!(v, "prores|HQ|320|240|yuv422p10le|bt709", "{v}");
            assert_eq!(ffprobe(&mov, "a:0", "codec_name,sample_rate,channels"), "pcm_s24le|48000|2");
            let d: f64 = ffprobe_format(&mov, "duration").parse().unwrap();
            assert!((d - 1.0).abs() < 0.04, "{d}");

            // A frame cut short is an error, and leaves nothing behind.
            let bad = dir.join("bad.mov");
            let job = begin(&dir, bad.to_str().unwrap()).unwrap().job;
            let video = VideoOptions { codec: "prores".into(), profile: None, width: 320, height: 240, fps_num: 30, fps_den: 1 };
            video_start(job, VideoStart { video, gain_db: 0.0 }).unwrap();
            append_frames(job, &frames[..1000]).unwrap();
            assert!(finish(job, FinishOptions { container: "mov".into(), codec: None, fps_num: 30, fps_den: 1, audio_kbps: 0, gain_db: 0.0 }).is_err());
            assert!(!bad.exists());
            assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));

            // A job left behind (the webview went away mid-export) is stopped, and its partial
            // file deleted, once it has been quiet long enough.
            let left = dir.join("left.mov");
            let job = begin(&dir, left.to_str().unwrap()).unwrap().job;
            let video = VideoOptions { codec: "prores".into(), profile: None, width: 320, height: 240, fps_num: 30, fps_den: 1 };
            video_start(job, VideoStart { video, gain_db: 0.0 }).unwrap();
            append_frames(job, &frames[..frames.len() / 2]).unwrap();
            reap(Duration::ZERO);
            assert!(append_frames(job, &frames[..10]).is_err());
            assert!(!left.exists());
            assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        }

        // MP3: constant 192 kb/s from the gained mix.
        {
            let mp3 = dir.join("out.mp3");
            let job = begin(&dir, mp3.to_str().unwrap()).unwrap().job;
            append(job, "audio", &b64(&pcm)).unwrap();
            append(job, "audio", &b64(&pcm)).unwrap();
            finish(job, FinishOptions { container: "mp3".into(), codec: None, fps_num: 0, fps_den: 1, audio_kbps: 192, gain_db: 0.0 }).unwrap();
            assert_eq!(ffprobe(&mp3, "a:0", "codec_name,sample_rate,channels,bit_rate"), "mp3|48000|2|192000");
            let d: f64 = ffprobe_format(&mp3, "duration").parse().unwrap();
            assert!((d - 2.0).abs() < 0.06, "{d}");
        }

        // Cancel removes the job's files.
        let job = begin(&dir, dir.join("never.mp4").to_str().unwrap()).unwrap().job;
        append(job, "video", "AAAA").unwrap();
        cancel(job);
        assert!(append(job, "video", "AAAA").is_err());
        assert!(!dir.join("never.mp4").exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
