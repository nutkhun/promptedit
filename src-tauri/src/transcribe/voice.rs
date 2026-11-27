//! Where the voice is in a piece of sound, from its loudness: used to start a word where the voice
//! starts (DTW times only say where words end) and to drop what whisper "hears" in silence (it
//! likes to say "you" or "Thank you." over nothing).
//!
//! Only trusted when speech is clearly louder than the quiet parts; with music under the voice or
//! a noisy room it changes nothing.

use super::audio::RATE;
use crate::mcp::providers::Word;

/// 10 ms frames.
const FRAME: f64 = 0.01;
const FRAME_SAMPLES: usize = RATE / 100;

pub struct Voice {
    /// Loudness (RMS) of each frame.
    level: Vec<f32>,
    /// Seconds in the file where the piece starts.
    base: f64,
    /// Louder than this is voice; `None` when that can't be told.
    threshold: Option<f32>,
    /// Nothing but (digital) silence in the whole piece.
    silent: bool,
}

impl Voice {
    pub fn new(samples: &[f32], base: f64) -> Voice {
        let level: Vec<f32> =
            samples.chunks(FRAME_SAMPLES).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect();
        let mut sorted = level.clone();
        sorted.sort_by(f32::total_cmp);
        let at = |q: f64| sorted.get(((sorted.len() as f64 - 1.0) * q) as usize).copied().unwrap_or(0.0);
        let (quiet, loud) = (at(0.1), at(0.9));
        // -60 dBFS at its loudest: there's nothing to hear.
        let silent = sorted.last().copied().unwrap_or(0.0) < 1e-3;
        let threshold = (level.len() >= 50 && loud >= 1e-3 && loud >= quiet * 4.0).then_some(quiet + (loud - quiet) * 0.1);
        Voice { level, base, threshold, silent }
    }

    pub fn is_silent(&self) -> bool {
        self.silent
    }

    fn frame(&self, t: f64) -> usize {
        (((t - self.base) / FRAME).max(0.0) as usize).min(self.level.len())
    }

    /// Whether anything is said between `start` and `end` seconds: false only when it's sure.
    pub fn heard(&self, start: f64, end: f64) -> bool {
        let Some(th) = self.threshold else { return !self.silent };
        // Some slack either side: DTW times can be a frame or two off.
        let (a, b) = (self.frame(start - 0.1), self.frame(end + 0.1));
        self.level[a..b].iter().any(|&l| l > th)
    }

    /// Moves each word's start forward to where the voice starts, and its end back to where it
    /// stops, within the word's span: a word after a pause otherwise starts when the word before
    /// it ended.
    pub fn trim(&self, words: &mut [Word]) {
        let Some(th) = self.threshold else { return };
        for w in words.iter_mut() {
            let (a, b) = (self.frame(w.start), self.frame(w.end));
            if b <= a + 2 {
                continue;
            }
            let Some(first) = (a..b).find(|&i| self.level[i] > th) else { continue };
            let last = (first..b).rev().find(|&i| self.level[i] > th).unwrap_or(first);
            // A little sound either side: voices fade in and out under the threshold.
            w.start = w.start.max(self.base + first.saturating_sub(2) as f64 * FRAME);
            w.end = w.end.min(self.base + (last + 3) as f64 * FRAME).max(w.start + 0.05);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 10 ms frames of `level`, as samples (a square wave has RMS = its amplitude).
    fn sound(frames: &[(usize, f32)]) -> Vec<f32> {
        frames.iter().flat_map(|&(n, a)| (0..n * FRAME_SAMPLES).map(move |i| if i % 2 == 0 { a } else { -a })).collect()
    }

    #[test]
    fn trims_to_the_voice() {
        // Near silence to 1.0 s, a voice to 1.9 s, a pause, a voice from 2.06 s to 3 s.
        let v = Voice::new(&sound(&[(100, 0.001), (90, 0.3), (16, 0.001), (94, 0.3)]), 0.0);
        let mut w = vec![
            Word { start: 0.0, end: 1.28, text: "Hello".into() },
            Word { start: 1.28, end: 1.9, text: "world,".into() },
            Word { start: 1.9, end: 2.5, text: "this".into() },
        ];
        v.trim(&mut w);
        assert!((w[0].start - 0.98).abs() < 0.011, "{}", w[0].start);
        assert_eq!((w[1].start, w[1].end), (1.28, 1.9));
        assert!((w[2].start - 2.04).abs() < 0.011, "{}", w[2].start);
        assert_eq!(w[2].end, 2.5);
        assert!(!v.heard(0.1, 0.7) && v.heard(0.5, 1.2) && !v.is_silent());
    }

    #[test]
    fn leaves_unclear_sound_alone() {
        // Music under everything: no telling where the voice is.
        let v = Voice::new(&sound(&[(300, 0.2)]), 5.0);
        let mut w = vec![Word { start: 5.0, end: 6.0, text: "a".into() }];
        v.trim(&mut w);
        assert_eq!((w[0].start, w[0].end), (5.0, 6.0));
        assert!(v.heard(5.0, 5.5));
        // Silence: nothing is said in it.
        let s = Voice::new(&vec![0.0; RATE], 0.0);
        assert!(s.is_silent() && !s.heard(0.0, 1.0));
    }
}
