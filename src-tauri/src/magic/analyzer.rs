//! What a video or photo looks like over time, and a song's beat, measured on this computer with no
//! network and no key (Editroom's `MediaAnalyzer`). Frames and sound come from the FFmpeg sidecar;
//! the maths is Editroom's: luma, Laplacian-variance sharpness, motion, Hasler–Süsstrunk colourfulness,
//! and beat tracking from spectral flux with a tempo prior around 120 BPM.
//!
//! Parity gap: Editroom also counts faces (Vision) and Apple's aesthetics score per frame. PromptEdit
//! has no face or aesthetics model yet, so `faces` is 0 and `aesthetic` is None, which the scorer
//! treats as Editroom does on Macs without the aesthetics API (a constant 0.12).

use crate::mcp::frames::{self, ffmpeg};
use crate::mcp::notes::cache_name;
use promptedit_core::{MediaAsset, MediaKind};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

pub const VERSION: u32 = 2;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Sample {
    pub time: f64,
    /// Average brightness, 0...1.
    pub luma: f64,
    /// Detail: variance of edges. Blurry frames are low.
    pub sharpness: f64,
    /// Change since the previous sample: shaky or fast-panning stretches are high.
    pub motion: f64,
    /// How colourful, 0...1.5.
    pub color: f64,
    pub faces: i64,
    pub aesthetic: Option<f64>,
    /// A screenshot or document rather than a photo of the world.
    pub utility: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClipAnalysis {
    pub duration: f64,
    /// Seconds since 1970 that it was filmed (the file's creation date).
    pub created: Option<f64>,
    pub samples: Vec<Sample>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MusicAnalysis {
    pub duration: f64,
    pub bpm: f64,
    pub beats: Vec<f64>,
    /// Index into `beats` of the first beat of a bar; bars are four beats.
    pub bar_phase: usize,
    /// Loudness of each beat, 0...1.
    pub energy: Vec<f32>,
}

impl MusicAnalysis {
    pub fn period(&self) -> f64 {
        60.0 / self.bpm
    }
    pub fn is_bar_start(&self, beat: usize) -> bool {
        (beat as i64 - self.bar_phase as i64).rem_euclid(4) == 0
    }
}

fn folder() -> PathBuf {
    crate::mcp::cache_dir().join("Analysis")
}

fn cache_file(source: &Path, kind: &str) -> PathBuf {
    folder().join(format!("{}-{kind}-v{VERSION}.json", cache_name(source, false)))
}

fn cached<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn store<T: Serialize>(v: &T, p: &Path) {
    let _ = std::fs::create_dir_all(folder());
    if let Ok(b) = serde_json::to_vec(v) {
        let _ = std::fs::write(p, b);
    }
}

fn source(a: &MediaAsset) -> PathBuf {
    let p = PathBuf::from(&a.path);
    if p.exists() { p } else { a.playable_path.as_ref().map(PathBuf::from).unwrap_or(p) }
}

// MARK: Clips

pub fn clip(a: &MediaAsset) -> Option<ClipAnalysis> {
    let path = source(a);
    let cache = cache_file(&path, "clip");
    if let Some(hit) = cached(&cache) {
        return Some(hit);
    }
    let result = if a.kind == MediaKind::Image { photo(&path) } else { video(&path, a.duration) }?;
    store(&result, &cache);
    Some(result)
}

fn created(path: &Path) -> Option<f64> {
    let m = std::fs::metadata(path).ok()?;
    let t = m.created().or_else(|_| m.modified()).ok()?;
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs_f64())
}

fn photo(path: &Path) -> Option<ClipAnalysis> {
    let img = frames::frame(path, 0.0, 320, 320, true)?;
    let small = image::imageops::resize(&img, W as u32, H as u32, image::imageops::FilterType::Triangle);
    let mut m = FrameMeasure::default();
    let s = m.sample(small.as_raw(), 0.0);
    Some(ClipAnalysis { duration: 5.0, created: created(path), samples: vec![s] })
}

const W: usize = 160;
const H: usize = 90;

fn video(path: &Path, duration: f64) -> Option<ClipAnalysis> {
    if duration <= 0.2 {
        return None;
    }
    let step = (duration / 60.0).max(0.25);
    let mut child = ffmpeg()
        .args(["-v", "error", "-nostdin", "-ss", &format!("{:.3}", step / 2.0)])
        .arg("-i")
        .arg(path)
        .args(["-an", "-vf", &format!("fps=1/{step:.6},scale={W}:{H}"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let mut measure = FrameMeasure::default();
    let mut samples = vec![];
    let mut buf = vec![0u8; W * H * 3];
    let mut i = 0usize;
    while out.read_exact(&mut buf).is_ok() {
        let t = step / 2.0 + i as f64 * step;
        if t > duration - 0.04 {
            break;
        }
        samples.push(measure.sample(&buf, t));
        i += 1;
    }
    let _ = child.kill();
    let _ = child.wait();
    if samples.is_empty() {
        return None;
    }
    Some(ClipAnalysis { duration, created: created(path), samples })
}

/// Brightness, detail, colour and change from one small frame (160×90 RGB) to the next.
#[derive(Default)]
struct FrameMeasure {
    previous: Option<Vec<u8>>,
}

impl FrameMeasure {
    fn sample(&mut self, rgb: &[u8], time: f64) -> Sample {
        let gray: Vec<u8> = rgb.chunks_exact(3).map(|p| (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64).round() as u8).collect();
        let luma = gray.iter().map(|&v| v as f64).sum::<f64>() / (W * H) as f64 / 255.0;
        // Laplacian variance: a standard measure of focus.
        let mut lap = Vec::with_capacity((W - 2) * (H - 2));
        for y in 1..H - 1 {
            let row = y * W;
            for x in 1..W - 1 {
                let c = gray[row + x] as f64 * 4.0;
                let n = gray[row + x - 1] as f64 + gray[row + x + 1] as f64 + gray[row - W + x] as f64 + gray[row + W + x] as f64;
                lap.push(n - c);
            }
        }
        let mean = lap.iter().sum::<f64>() / lap.len() as f64;
        let variance = lap.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / lap.len() as f64;
        let motion = match &self.previous {
            Some(prev) => gray.iter().zip(prev).map(|(a, b)| (*a as i64 - *b as i64).abs()).sum::<i64>() as f64 / (W * H) as f64 / 255.0,
            None => 0.0,
        };
        self.previous = Some(gray);
        // Colourfulness (Hasler and Süsstrunk), on a 48×27 copy.
        let img = image::RgbImage::from_raw(W as u32, H as u32, rgb.to_vec()).unwrap_or_default();
        let small = image::imageops::resize(&img, 48, 27, image::imageops::FilterType::Triangle);
        let (mut rg, mut yb) = (vec![], vec![]);
        for p in small.pixels() {
            let (r, g, b) = (p[0] as f64, p[1] as f64, p[2] as f64);
            rg.push(r - g);
            yb.push(0.5 * (r + g) - b);
        }
        let stats = |a: &[f64]| {
            let m = a.iter().sum::<f64>() / a.len().max(1) as f64;
            (m, (a.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / a.len().max(1) as f64).sqrt())
        };
        let ((mrg, srg), (myb, syb)) = (stats(&rg), stats(&yb));
        let color = ((srg * srg + syb * syb).sqrt() + 0.3 * (mrg * mrg + myb * myb).sqrt()) / 110.0;
        Sample { time, luma, sharpness: variance, motion, color: color.min(1.5), faces: 0, aesthetic: None, utility: None }
    }
}

// MARK: Music

pub fn music(a: &MediaAsset) -> Option<MusicAnalysis> {
    let path = source(a);
    let cache = cache_file(&path, "beat");
    if let Some(hit) = cached(&cache) {
        return Some(hit);
    }
    let samples = read_mono(&path, 22050)?;
    let result = beats(&samples, 22050.0)?;
    store(&result, &cache);
    Some(result)
}

/// The whole file as one channel of floats at `rate`.
pub fn read_mono(path: &Path, rate: u32) -> Option<Vec<f32>> {
    let out = ffmpeg()
        .args(["-v", "error", "-nostdin"])
        .arg("-i")
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", &rate.to_string(), "-f", "f32le", "-"])
        .stdout(Stdio::piped())
        .output()
        .ok()?;
    let v: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    (!v.is_empty()).then_some(v)
}

/// In-place radix-2 FFT of `re`/`im` (length a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * cr - im[b] * ci, re[b] * ci + im[b] * cr);
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                (cr, ci) = (cr * wr - ci * wi, cr * wi + ci * wr);
            }
        }
        len <<= 1;
    }
}

/// Finds the tempo and beats: an onset envelope from spectral flux, tempo by autocorrelation
/// (favouring common tempos), the best-fitting beat grid, nudged beat by beat to the onsets, and
/// which beat starts each bar (where the bass hits hardest).
pub fn beats(x: &[f32], rate: f64) -> Option<MusicAnalysis> {
    let (n, hop) = (1024usize, 512usize);
    if x.len() <= n * 8 || (x.len() as f64) <= rate * 6.0 {
        return None;
    }
    // vDSP's normalised Hann window, and its real FFT's scale (twice the plain DFT).
    let window: Vec<f32> = (0..n).map(|i| 0.8165 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos())).collect();
    let frames = (x.len() - n) / hop;
    let half = n / 2;
    let low_bins = ((150.0 / (rate / n as f64)) as usize).max(2);
    let mut prev = vec![0f32; half];
    let (mut flux, mut low, mut rms) = (vec![0f32; frames], vec![0f32; frames], vec![0f32; frames]);
    let (mut re, mut im) = (vec![0f32; n], vec![0f32; n]);
    for f in 0..frames {
        let src = &x[f * hop..f * hop + n];
        let mut level = 0f32;
        for i in 0..n {
            re[i] = src[i] * window[i];
            im[i] = 0.0;
            level += re[i] * re[i];
        }
        rms[f] = (level / n as f32).sqrt();
        fft(&mut re, &mut im);
        let (mut total, mut bass) = (0f32, 0f32);
        for k in 1..half {
            let mag = 2.0 * (re[k] * re[k] + im[k] * im[k]).sqrt();
            let v = (100.0 * mag).ln_1p();
            let d = v - prev[k];
            if d > 0.0 {
                total += d;
                if k < low_bins {
                    bass += d;
                }
            }
            prev[k] = v;
        }
        flux[f] = total;
        low[f] = bass;
    }
    // Onset strength above its local average.
    let fps = rate / hop as f64;
    let detrend = |a: &[f32]| -> Vec<f32> {
        let r = ((fps * 0.25) as usize).max(1);
        let mut prefix = vec![0f32; a.len() + 1];
        for i in 0..a.len() {
            prefix[i + 1] = prefix[i] + a[i];
        }
        (0..a.len())
            .map(|i| {
                let (lo, hi) = (i.saturating_sub(r), (i + r + 1).min(a.len()));
                (a[i] - (prefix[hi] - prefix[lo]) / (hi - lo) as f32).max(0.0)
            })
            .collect()
    };
    let env = detrend(&flux);
    let bass_env = detrend(&low);
    // Tempo: autocorrelation, weighted toward 120 BPM over about an octave.
    let mut best = (120.0f64, f64::NEG_INFINITY);
    for bpm10 in (700..=1800).step_by(2) {
        let bpm = bpm10 as f64 / 10.0;
        let lag = 60.0 / bpm * fps;
        let l0 = lag as usize;
        let frac = (lag - l0 as f64) as f32;
        if env.len() < l0 + 2 {
            continue;
        }
        let mut s = 0f32;
        let mut count = 0;
        for i in 0..(env.len() - l0 - 1) {
            s += env[i] * (env[i + l0] * (1.0 - frac) + env[i + l0 + 1] * frac);
            count += 1;
        }
        let octave = (bpm / 120.0).log2();
        let w = s as f64 / count.max(1) as f64 * (-0.5 * octave * octave / (0.9 * 0.9)).exp();
        if w > best.1 {
            best = (bpm, w);
        }
    }
    let period = 60.0 / best.0 * fps;
    // Grid phase that lines up with the most onset strength, the bass counting as much as the rest.
    let env_top = env.iter().cloned().fold(0f32, f32::max).max(1e-6);
    let bass_top = bass_env.iter().cloned().fold(0f32, f32::max).max(1e-6);
    let pulse: Vec<f32> = env.iter().zip(&bass_env).map(|(a, b)| a / env_top + b / bass_top).collect();
    let (mut phase, mut phase_score) = (0.0f64, -1f32);
    let mut p = 0.0;
    while p < period {
        let mut s = 0f32;
        let mut t = p;
        while (t as usize) < pulse.len() {
            s += pulse[t as usize];
            t += period;
        }
        if s > phase_score {
            phase_score = s;
            phase = p;
        }
        p += 0.5;
    }
    // Follow the music: each beat may move a little toward the strongest onset near where it's expected.
    let mut beat_frames = vec![phase];
    let mut t = phase;
    loop {
        let predicted = t + period;
        if predicted as usize >= pulse.len().saturating_sub(1) {
            break;
        }
        let lo = (predicted - period * 0.08).max(0.0) as usize;
        let hi = ((predicted + period * 0.08) as usize).min(pulse.len() - 1);
        let (mut at, mut top) = (predicted, 0f32);
        for (i, v) in pulse.iter().enumerate().take(hi + 1).skip(lo) {
            if *v > top {
                top = *v;
                at = i as f64;
            }
        }
        t = if top > 0.0 { predicted + (at - predicted) * 0.5 } else { predicted };
        beat_frames.push(t);
    }
    // Most songs keep strict time: fit one straight grid through the tracked beats; where a song
    // really drifts (live playing), keep the tracked beats, lightly smoothed.
    if beat_frames.len() > 8 {
        let k = beat_frames.len() as f64;
        let mean_i = (k - 1.0) / 2.0;
        let mean_t = beat_frames.iter().sum::<f64>() / k;
        let (mut num, mut den) = (0.0, 0.0);
        for (i, b) in beat_frames.iter().enumerate() {
            num += (i as f64 - mean_i) * (b - mean_t);
            den += (i as f64 - mean_i).powi(2);
        }
        let slope = num / den;
        let intercept = mean_t - slope * mean_i;
        let fitted: Vec<f64> = (0..beat_frames.len()).map(|i| intercept + slope * i as f64).collect();
        let residual = (beat_frames.iter().zip(&fitted).map(|(a, b)| (a - b).powi(2)).sum::<f64>() / k).sqrt() / fps;
        beat_frames = if residual < 0.03 {
            fitted.into_iter().filter(|v| *v >= 0.0).collect()
        } else {
            (0..beat_frames.len())
                .map(|i| {
                    let (lo, hi) = (i.saturating_sub(1), (i + 1).min(beat_frames.len() - 1));
                    beat_frames[lo..=hi].iter().sum::<f64>() / (hi - lo + 1) as f64
                })
                .collect()
        };
    }
    let bpm = if beat_frames.len() > 1 {
        60.0 / ((beat_frames.last().unwrap() - beat_frames[0]) / (beat_frames.len() - 1) as f64 / fps)
    } else {
        best.0
    };
    // Bars start where the bass lands hardest.
    let (mut bar_phase, mut bar_score) = (0usize, -1f32);
    for m in 0..4 {
        let mut s = 0f32;
        for (i, b) in beat_frames.iter().enumerate() {
            if i % 4 != m {
                continue;
            }
            let k = (b.round() as usize).min(bass_env.len() - 1);
            s += bass_env[k] + 0.25 * env[k.min(env.len() - 1)];
        }
        if s > bar_score {
            bar_score = s;
            bar_phase = m;
        }
    }
    // Loudness of each beat.
    let mut energy: Vec<f32> = beat_frames
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let lo = *b as usize;
            let next = beat_frames.get(i + 1).copied().unwrap_or(b + period);
            let hi = (next as usize).min(rms.len());
            if hi <= lo { 0.0 } else { rms[lo..hi].iter().sum::<f32>() / (hi - lo) as f32 }
        })
        .collect();
    let top = energy.iter().cloned().fold(0f32, f32::max);
    if top > 0.0 {
        energy.iter_mut().for_each(|e| *e /= top);
    }
    // Frame times are for the middle of each analysis window.
    let offset = (n / 2) as f64 / rate;
    Some(MusicAnalysis {
        duration: x.len() as f64 / rate,
        bpm,
        beats: beat_frames.iter().map(|b| b / fps + offset).collect(),
        bar_phase,
        energy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_steady_beat() {
        // Clicks at 120 BPM for 12 seconds.
        let rate = 22050.0;
        let mut x = vec![0f32; (rate * 12.0) as usize];
        let mut t = 0.25;
        while t < 12.0 {
            let i = (t * rate) as usize;
            for k in 0..400 {
                if i + k < x.len() {
                    x[i + k] = ((k as f32) * 0.3).sin() * (1.0 - k as f32 / 400.0);
                }
            }
            t += 0.5;
        }
        let m = beats(&x, rate).expect("a beat");
        assert!((m.bpm - 120.0).abs() < 3.0, "bpm {}", m.bpm);
        assert!(m.beats.len() > 18);
    }

    #[test]
    fn measures_frames() {
        let mut m = FrameMeasure::default();
        let flat = vec![128u8; W * H * 3];
        let s = m.sample(&flat, 0.0);
        assert!((s.luma - 128.0 / 255.0).abs() < 0.01);
        assert!(s.sharpness < 1e-9 && s.color < 1e-6);
        let mut noisy = flat.clone();
        for (i, v) in noisy.iter_mut().enumerate() {
            *v = if (i / 3) % 2 == 0 { 255 } else { 0 };
        }
        let s2 = m.sample(&noisy, 0.5);
        assert!(s2.sharpness > 1000.0 && s2.motion > 0.1);
    }
}
