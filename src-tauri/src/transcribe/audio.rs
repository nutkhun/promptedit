//! A file's sound as whisper wants it: 16 kHz mono 32-bit float, decoded by the ffmpeg sidecar and
//! read from its output a piece at a time, so a long file is never held in memory whole (an hour is
//! 230 MB at this rate). Pieces end at the quietest moment near their end, so a word is never cut.

use std::io::Read;
use std::path::Path;
use std::process::{Child, ChildStdout, Stdio};

pub const RATE: usize = 16_000;

/// How much is heard at once: ten minutes (38 MB of samples).
pub const CHUNK: usize = 10 * 60 * RATE;
/// How far back from a piece's end to look for a pause to end it at.
const SEARCH: usize = 20 * RATE;
/// The pause finder's window: a fifth of a second.
const WINDOW: usize = RATE / 5;

pub struct Reader {
    child: Child,
    out: ChildStdout,
    /// Samples read past the last piece's end, which start the next one.
    carry: Vec<f32>,
    /// Bytes of a sample split across two reads.
    partial: Vec<u8>,
    done: bool,
}

impl Reader {
    /// Starts decoding the first sound track of `path`.
    pub fn open(path: &Path) -> Result<Reader, String> {
        let mut child = crate::media::command("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(path)
            .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-acodec", "pcm_f32le", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
        let out = child.stdout.take().ok_or("Couldn't read ffmpeg's output.")?;
        Ok(Reader { child, out, carry: vec![], partial: vec![], done: false })
    }

    /// The next piece of up to about `max` samples, or `None` at the end. Fails if ffmpeg couldn't
    /// read the file at all.
    pub fn next_piece(&mut self, max: usize) -> Result<Option<Vec<f32>>, String> {
        let mut buf = std::mem::take(&mut self.carry);
        let mut bytes = vec![0u8; 1 << 16];
        while !self.done && buf.len() < max {
            let n = self.out.read(&mut bytes).map_err(|e| format!("Couldn't read the sound: {e}"))?;
            if n == 0 {
                self.done = true;
                let ok = self.child.wait().map(|s| s.success()).unwrap_or(false);
                if !ok && buf.is_empty() {
                    return Err("Couldn't read the sound in this file.".into());
                }
                break;
            }
            self.partial.extend_from_slice(&bytes[..n]);
            let whole = self.partial.len() / 4 * 4;
            buf.extend(self.partial[..whole].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
            self.partial.drain(..whole);
        }
        if buf.is_empty() {
            return Ok(None);
        }
        if !self.done {
            let cut = quietest_cut(&buf, max);
            self.carry = buf.split_off(cut);
        }
        Ok(Some(buf))
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        // Stopped early (cancelled or failed): don't leave ffmpeg running.
        if !self.done {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Where to end a piece of `buf` that should be about `max` long: the middle of the quietest
/// fifth of a second in the last 20 seconds before `max`.
pub fn quietest_cut(buf: &[f32], max: usize) -> usize {
    let end = max.min(buf.len());
    let from = end.saturating_sub(SEARCH);
    if end - from < WINDOW * 2 {
        return end;
    }
    let mut best = (f32::INFINITY, end);
    let mut i = from;
    while i + WINDOW <= end {
        let energy: f32 = buf[i..i + WINDOW].iter().map(|s| s * s).sum();
        // Later wins ties, keeping pieces as long as they can be.
        if energy <= best.0 {
            best = (energy, i + WINDOW / 2);
        }
        i += WINDOW / 2;
    }
    best.1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_at_the_pause() {
        // A tone with a pause 5 s before the 30 s mark.
        let mut buf: Vec<f32> = (0..40 * RATE).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        for s in &mut buf[25 * RATE..25 * RATE + RATE / 2] {
            *s = 0.0;
        }
        let cut = quietest_cut(&buf, 30 * RATE);
        assert!((25 * RATE..25 * RATE + RATE / 2).contains(&cut), "cut at {cut}");
        // Too short to look: the whole thing.
        assert_eq!(quietest_cut(&buf[..1000], 30 * RATE), 1000);
    }

    #[test]
    fn reads_a_file_in_pieces() {
        let dir = std::env::temp_dir().join(format!("promptedit-taudio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tone.wav");
        let ok = crate::media::command("ffmpeg")
            .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=3:sample_rate=44100", "-ac", "2"])
            .arg(&wav)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let mut r = Reader::open(&wav).unwrap();
        let mut total = 0;
        let mut pieces = 0;
        while let Some(p) = r.next_piece(RATE).unwrap() {
            assert!(p.len() <= RATE + 1);
            total += p.len();
            pieces += 1;
        }
        assert!(pieces >= 3, "{pieces} pieces");
        assert!((total as i64 - 3 * RATE as i64).abs() < 200, "{total} samples");
        assert!(Reader::open(&dir.join("missing.wav")).unwrap().next_piece(RATE).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
