//! Frames to look at, read with the ffmpeg sidecar straight at CLIP's input size: the shorter side
//! scaled to 224 (bicubic, as CLIP's preprocessing does), the middle 224×224 kept, as RGB bytes.
//! ffmpeg applies a clip's rotation itself, as Editroom's `appliesPreferredTrackTransform` does.

use super::clip::SIZE;
use std::path::Path;
use std::process::Stdio;

const FILTER: &str = "scale=224:224:force_original_aspect_ratio=increase:flags=bicubic,crop=224:224";

/// The frame at `t` seconds (`None` for a still), or `None` if there's no picture there (past
/// the end of a file whose length was off, or a file ffmpeg can't read).
pub fn frame(path: &Path, t: Option<f64>) -> Option<Vec<u8>> {
    // Without a console window on Windows.
    let mut cmd = crate::media::command("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if let Some(t) = t {
        // Before -i: a fast seek to the keyframe before, then decoding up to t.
        cmd.args(["-ss", &format!("{t:.3}")]);
    }
    cmd.arg("-i").arg(path);
    cmd.args(["-map", "0:v:0", "-frames:v", "1", "-vf", FILTER, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    let out = cmd.output().ok()?;
    (out.status.success() && out.stdout.len() == SIZE * SIZE * 3).then_some(out.stdout)
}
