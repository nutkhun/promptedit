//! Waveforms (Editroom `WaveformReader`, spec §11.1): the first audio track decoded at its own
//! rate and channel count, summed into 200 stretches per second. Saved in Editroom's `.wave`
//! layout: `u32 "ERWF", u32 version 1, f64 peaks per second, u32 count`, then peaks, left, right
//! and rms as `count` f32 each (all little-endian).

use super::{cache_name, temp_beside};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;

pub const PEAKS_PER_SECOND: f64 = 200.0;
const MAGIC: u32 = 0x4657_5245;
const VERSION: u32 = 1;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WaveInfo {
    pub path: String,
    pub count: u32,
    pub peaks_per_second: f64,
}

#[derive(Default, Debug, Clone, PartialEq)]
pub struct Waveform {
    pub peaks: Vec<f32>,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub rms: Vec<f32>,
}

/// The bucket loop, fed interleaved frames in pieces of any size (a bucket can span pieces).
pub struct Bucketer {
    channels: usize,
    frames_per_bucket: f64,
    fill: f64,
    peak: f32,
    l: f32,
    r: f32,
    squares: f32,
    pub out: Waveform,
}

impl Bucketer {
    pub fn new(rate: f64, channels: usize) -> Self {
        Bucketer {
            channels: channels.max(1),
            frames_per_bucket: rate / PEAKS_PER_SECOND,
            fill: 0.0,
            peak: 0.0,
            l: 0.0,
            r: 0.0,
            squares: 0.0,
            out: Waveform::default(),
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        let ch = self.channels;
        let frames = samples.len() / ch;
        let right = 1.min(ch - 1);
        let mut pos = 0;
        while pos < frames {
            let need = ((self.frames_per_bucket - self.fill).ceil() as i64).max(1) as usize;
            let take = need.min(frames - pos);
            for f in pos..pos + take {
                let frame = &samples[f * ch..f * ch + ch];
                // The frame's loudest channel.
                let m = frame.iter().fold(0f32, |a, x| a.max(x.abs()));
                self.peak = self.peak.max(m);
                self.squares += m * m;
                self.l = self.l.max(frame[0].abs());
                self.r = self.r.max(frame[right].abs());
            }
            self.fill += take as f64;
            pos += take;
            if self.fill >= self.frames_per_bucket - 1e-6 {
                self.out.peaks.push(self.peak);
                self.out.rms.push((self.squares / self.fill.max(1.0) as f32).sqrt());
                self.out.left.push(self.l);
                self.out.right.push(self.r);
                self.peak = 0.0;
                self.l = 0.0;
                self.r = 0.0;
                self.squares = 0.0;
                self.fill -= self.frames_per_bucket;
            }
        }
    }
}

pub fn encode(w: &Waveform) -> Vec<u8> {
    let n = w.peaks.len();
    let mut d = Vec::with_capacity(20 + 16 * n);
    d.extend(MAGIC.to_le_bytes());
    d.extend(VERSION.to_le_bytes());
    d.extend(PEAKS_PER_SECOND.to_le_bytes());
    d.extend((n as u32).to_le_bytes());
    for arr in [&w.peaks, &w.left, &w.right, &w.rms] {
        for v in arr.iter() {
            d.extend(v.to_le_bytes());
        }
    }
    d
}

fn valid(path: &Path) -> Option<u32> {
    let mut head = [0u8; 20];
    let mut f = std::fs::File::open(path).ok()?;
    f.read_exact(&mut head).ok()?;
    let len = f.metadata().ok()?.len();
    let magic = u32::from_le_bytes(head[0..4].try_into().unwrap());
    let version = u32::from_le_bytes(head[4..8].try_into().unwrap());
    let n = u32::from_le_bytes(head[16..20].try_into().unwrap());
    (magic == MAGIC && version == VERSION && n > 0 && len == 20 + 16 * n as u64).then_some(n)
}

/// The waveform cache for `src`, made on first use.
pub fn waveform(cache: &Path, src: &Path) -> Result<WaveInfo, String> {
    let dir = cache.join("Waveforms");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{}.wave", cache_name(src)));
    let info = |count| WaveInfo { path: out.to_string_lossy().into_owned(), count, peaks_per_second: PEAKS_PER_SECOND };
    if let Some(n) = valid(&out) {
        return Ok(info(n));
    }
    let probe = crate::media::probe(src)?;
    if !probe.has_audio {
        return Err("No sound in this file.".into());
    }
    let channels = probe.audio_channels.unwrap_or(2).max(1) as usize;
    let rate = probe.audio_rate.unwrap_or(48000).max(1) as f64;
    let mut child = super::ffmpeg()
        .arg("-i")
        .arg(src)
        .args(["-map", "0:a:0", "-vn", "-f", "f32le", "-c:a", "pcm_f32le", "-ac"])
        .arg(channels.to_string())
        .args(["-ar"])
        .arg((rate as u32).to_string())
        .arg("pipe:1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut b = Bucketer::new(rate, channels);
    let mut buf = vec![0u8; 4 * channels * 8192];
    let mut carry: Vec<u8> = vec![];
    let mut samples: Vec<f32> = vec![];
    loop {
        let n = stdout.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / (4 * channels) * (4 * channels);
        samples.clear();
        samples.extend(carry[..whole].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
        b.push(&samples);
        carry.drain(..whole);
    }
    // A read cut short isn't kept (made again next time).
    if !child.wait().map_err(|e| e.to_string())?.success() || b.out.peaks.is_empty() {
        return Err("This file's sound couldn't be read.".into());
    }
    let tmp = temp_beside(&out);
    std::fs::File::create(&tmp).and_then(|mut f| f.write_all(&encode(&b.out))).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(info(b.out.peaks.len() as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_like_editroom() {
        // 44.1 kHz: 220.5 frames per bucket, so buckets alternate 221/220 frames via the carry.
        let mut b = Bucketer::new(44100.0, 2);
        let mut s = vec![];
        for i in 0..44100 {
            let v = if i < 22050 { 0.25 } else { -0.5 };
            s.extend([v, v * 0.5]);
        }
        // Feed in odd pieces to check buckets carry across reads.
        for chunk in s.chunks(2 * 777) {
            b.push(chunk);
        }
        assert_eq!(b.out.peaks.len(), 200);
        assert!((b.out.peaks[0] - 0.25).abs() < 1e-6);
        assert!((b.out.left[0] - 0.25).abs() < 1e-6);
        assert!((b.out.right[0] - 0.125).abs() < 1e-6);
        assert!((b.out.rms[0] - 0.25).abs() < 1e-3);
        assert!((b.out.peaks[199] - 0.5).abs() < 1e-6);
        let bytes = encode(&b.out);
        assert_eq!(bytes.len(), 20 + 16 * 200);
        assert_eq!(&bytes[0..4], b"ERWF");
    }
}
