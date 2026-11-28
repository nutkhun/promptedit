//! ProRes in a MOV. WebCodecs can't encode ProRes, so the webview renders each frame with the same
//! compositor as every other export, packs it as 10-bit 4:2:2 Y′CbCr in v210 layout (16 bytes per 6
//! pixels, rows padded to 48 pixels: a third more than 8-bit 4:2:2 and half of 16-bit planes) and
//! sends the bytes here raw. They go straight into FFmpeg's stdin, which encodes them as they come
//! (see `encoders` for which encoder) and muxes the already-mixed sound as 24-bit PCM, so nothing
//! uncompressed is ever written to disk.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Deserialize;

/// Bytes of one v210 frame: each row padded to a multiple of 48 pixels, 128 bytes per 48 pixels.
pub fn v210_frame_bytes(width: u32, height: u32) -> usize {
    (width as usize).div_ceil(48) * 128 * height as usize
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoOptions {
    /// "prores" (the only codec that arrives as frames).
    pub codec: String,
    /// ProRes profile: "proxy", "lt", "standard" (422) or "hq".
    #[serde(default)]
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    /// Frame rate as a fraction (e.g. 30000/1001).
    pub fps_num: u32,
    pub fps_den: u32,
}

/// A running encoder. Dropping it before `finish` kills FFmpeg and deletes the partial file.
pub struct Pipe {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Child>>,
    log: Arc<Mutex<String>>,
    reader: Option<JoinHandle<()>>,
    written: Arc<AtomicU64>,
    frame_bytes: u64,
    /// The file FFmpeg writes (beside the final one, renamed when done).
    pub file: PathBuf,
    done: bool,
}

/// What writes into a pipe without holding the export's job table (a slow encoder must not
/// block cancelling).
#[derive(Clone)]
pub struct Writer {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Child>>,
    log: Arc<Mutex<String>>,
    written: Arc<AtomicU64>,
}

impl Writer {
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        let s = stdin.as_mut().ok_or("This export has finished.")?;
        if let Err(e) = s.write_all(bytes) {
            drop(stdin);
            // FFmpeg stopped: wait for it to say why.
            let _ = self.child.lock().unwrap().wait();
            std::thread::sleep(std::time::Duration::from_millis(50));
            let log = self.log.lock().unwrap().trim().to_string();
            return Err(if log.is_empty() { format!("The ProRes encoder stopped ({e}).") } else { format!("The ProRes encoder stopped: {log}") });
        }
        self.written.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        Ok(())
    }
}

impl Pipe {
    /// Starts FFmpeg encoding v210 frames from stdin into `file`, with `audio` (a WAV) as the sound.
    pub fn start(o: &VideoOptions, audio: Option<&Path>, file: PathBuf) -> Result<Pipe, String> {
        if o.codec != "prores" {
            return Err(format!("Unknown video codec {}", o.codec));
        }
        if o.width < 2 || o.height < 2 || o.width > 8192 || o.height > 8192 {
            return Err("The export size isn't valid.".into());
        }
        let encoder = super::encoders::encoders().prores.ok_or("This copy of FFmpeg can't encode ProRes.")?;
        let mut c = super::ffmpeg();
        let size = format!("{}x{}", o.width, o.height);
        let rate = format!("{}/{}", o.fps_num.max(1), o.fps_den.max(1));
        // The v210 demuxer (not rawvideo, which can't size v210 packets); `-framerate` times the
        // frames exactly 1/fps apart.
        c.args(["-f", "v210", "-video_size", &size, "-framerate", &rate, "-i", "pipe:0"]);
        if let Some(a) = audio {
            c.arg("-i").arg(a);
        }
        c.args(["-map", "0:v:0"]);
        if audio.is_some() {
            c.args(["-map", "1:a:0", "-c:a", "pcm_s24le"]);
        }
        c.args(super::encoders::prores_args(encoder, o.profile.as_deref().unwrap_or("standard")));
        // Rec.709, limited range, as the frames were made (and as the MP4 export tags them).
        c.args(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]);
        c.args(["-movflags", "+write_colr", "-f", "mov"]).arg(&file);
        c.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = c.spawn().map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
        let stdin = child.stdin.take();
        let log = Arc::new(Mutex::new(String::new()));
        let reader = child.stderr.take().map(|err| {
            let log = log.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    let mut l = log.lock().unwrap();
                    // The first lines say what went wrong; keep the message short.
                    if l.len() < 2000 {
                        l.push_str(&line);
                        l.push('\n');
                    }
                }
            })
        });
        Ok(Pipe {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            log,
            reader,
            written: Arc::new(AtomicU64::new(0)),
            frame_bytes: v210_frame_bytes(o.width, o.height) as u64,
            file,
            done: false,
        })
    }

    pub fn writer(&self) -> Writer {
        Writer { stdin: self.stdin.clone(), child: self.child.clone(), log: self.log.clone(), written: self.written.clone() }
    }

    /// Ends the stream and waits for FFmpeg to finish the file.
    pub fn finish(mut self) -> Result<PathBuf, String> {
        let written = self.written.load(Ordering::Relaxed);
        if written == 0 {
            return Err("No frames were rendered.".into());
        }
        if written % self.frame_bytes != 0 {
            return Err("The last frame didn't arrive whole.".into());
        }
        // Closing stdin is the end of the stream.
        self.stdin.lock().unwrap().take();
        let status = self.child.lock().unwrap().wait().map_err(|e| e.to_string())?;
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
        if !status.success() {
            let log = self.log.lock().unwrap().trim().to_string();
            return Err(format!("Couldn't write the movie: {log}"));
        }
        self.done = true;
        Ok(self.file.clone())
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        drop(child);
        let _ = std::fs::remove_file(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_sizes() {
        // 1920 is 40 × 48 pixels: 5120 bytes a row.
        assert_eq!(v210_frame_bytes(1920, 1080), 5120 * 1080);
        // 1280 pads to 1296 (27 × 48).
        assert_eq!(v210_frame_bytes(1280, 720), 27 * 128 * 720);
        assert_eq!(v210_frame_bytes(2, 2), 256);
    }
}
