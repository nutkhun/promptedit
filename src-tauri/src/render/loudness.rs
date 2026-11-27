//! Integrated loudness (ITU-R BS.1770, LUFS) and sample peak of a mix, ported from Editroom's
//! `LoudnessMeter` (spec §13): K-weighting biquads at 48 kHz, 100 ms steps, 400 ms blocks with 75 %
//! overlap, absolute gate −70 LUFS, relative gate −10 LU. Sample peak, not true peak.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    pub lufs: f64,
    pub peak_db: f64,
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    const fn new(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Biquad { b0, b1, b2, a1, a2, z1: 0.0, z2: 0.0 }
    }
    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

fn k_weighting() -> [Biquad; 2] {
    [
        Biquad::new(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585),
        Biquad::new(1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621),
    ]
}

/// Streaming meter: feed interleaved stereo 48 kHz frames, then `finish`.
pub struct Meter {
    left: [Biquad; 2],
    right: [Biquad; 2],
    steps: Vec<f64>,
    acc: f64,
    count: usize,
    peak: f32,
}

const STEP: usize = 4800;

impl Default for Meter {
    fn default() -> Self {
        Meter { left: k_weighting(), right: k_weighting(), steps: vec![], acc: 0.0, count: 0, peak: 0.0 }
    }
}

impl Meter {
    pub fn push(&mut self, interleaved: &[f32]) {
        for f in interleaved.chunks_exact(2) {
            let (l, r) = (f[0], f[1]);
            self.peak = self.peak.max(l.abs()).max(r.abs());
            let x = self.left[0].run(l as f64);
            let x = self.left[1].run(x);
            let y = self.right[0].run(r as f64);
            let y = self.right[1].run(y);
            self.acc += x * x + y * y;
            self.count += 1;
            if self.count == STEP {
                self.steps.push(self.acc / STEP as f64);
                self.acc = 0.0;
                self.count = 0;
            }
        }
    }

    /// None when the mix is too short (< 400 ms) or everything is gated out (silence).
    pub fn finish(&self) -> Option<Loudness> {
        let steps = &self.steps;
        if steps.len() < 4 {
            return None;
        }
        let blocks: Vec<f64> = (0..=steps.len() - 4).map(|k| (steps[k] + steps[k + 1] + steps[k + 2] + steps[k + 3]) / 4.0).collect();
        let lufs = |p: f64| -0.691 + 10.0 * p.max(1e-12).log10();
        let absolute: Vec<f64> = blocks.into_iter().filter(|&b| lufs(b) > -70.0).collect();
        if absolute.is_empty() {
            return None;
        }
        let gate = lufs(absolute.iter().sum::<f64>() / absolute.len() as f64) - 10.0;
        let gated: Vec<f64> = absolute.into_iter().filter(|&b| lufs(b) > gate).collect();
        if gated.is_empty() {
            return None;
        }
        let integrated = lufs(gated.iter().sum::<f64>() / gated.len() as f64);
        let peak_db = if self.peak > 0.0 { 20.0 * (self.peak as f64).log10() } else { -120.0 };
        Some(Loudness { lufs: integrated, peak_db })
    }
}

/// The gain (dB) that brings the mix to `target` LUFS without pushing its sample peak above −1 dBFS.
pub fn normalising_gain(target: f64, m: Loudness) -> f64 {
    (target - m.lufs).min(-1.0 - m.peak_db)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(db: f64, seconds: f64) -> Vec<f32> {
        let a = 10f64.powf(db / 20.0);
        let n = (seconds * 48000.0) as usize;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let s = (a * (2.0 * std::f64::consts::PI * 997.0 * i as f64 / 48000.0).sin()) as f32;
            v.extend([s, s]);
        }
        v
    }

    #[test]
    fn tone_at_minus_20_dbfs_reads_minus_20_lufs() {
        // BS.1770: a 997 Hz sine at −20 dBFS in both channels reads ≈ −20 LUFS (−3.01 per channel, +3.01 summed).
        let mut m = Meter::default();
        m.push(&sine(-20.0, 5.0));
        let r = m.finish().unwrap();
        assert!((r.lufs - -20.0).abs() < 0.1, "{}", r.lufs);
        assert!((r.peak_db - -20.0).abs() < 0.01);
        assert!((normalising_gain(-14.0, r) - 6.0).abs() < 0.1);
        // Peak ceiling wins when the target would clip.
        assert!((normalising_gain(0.0, r) - 19.0).abs() < 0.01);
    }

    #[test]
    fn silence_and_short_mixes_measure_nothing() {
        let mut m = Meter::default();
        m.push(&vec![0.0; 48000 * 4]);
        assert!(m.finish().is_none());
        let mut m = Meter::default();
        m.push(&sine(-20.0, 0.3));
        assert!(m.finish().is_none());
    }
}
