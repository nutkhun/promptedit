//! Which of FFmpeg's encoders the ProRes and MP3 exports can use, found out once per run.
//!
//! - ProRes: `prores_videotoolbox` (Apple's own encoder; the ProRes engine on Macs that have one,
//!   Apple's software codec otherwise) when it's built in *and* actually encodes a frame here, else
//!   FFmpeg's `prores_ks`. Both are LGPL-compatible.
//! - MP3: `libmp3lame` (LAME, LGPL). The macOS sidecar is built with it (scripts/ffmpeg.mjs) and
//!   BtbN's Windows LGPL build includes it; a system FFmpeg might not.

use serde::Serialize;
use std::io::Write;
use std::process::Stdio;
use std::sync::OnceLock;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Encoders {
    /// The ProRes encoder to use, if any.
    pub prores: Option<&'static str>,
    /// Whether MP3 export works (FFmpeg has LAME).
    pub mp3: bool,
}

pub fn encoders() -> &'static Encoders {
    static E: OnceLock<Encoders> = OnceLock::new();
    E.get_or_init(|| {
        let list = super::ffmpeg().arg("-encoders").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let has = |name: &str| list.lines().any(|l| l.split_whitespace().nth(1) == Some(name));
        let prores = if has("prores_videotoolbox") && encodes_a_frame("prores_videotoolbox") {
            Some("prores_videotoolbox")
        } else if has("prores_ks") {
            Some("prores_ks")
        } else {
            None
        };
        Encoders { prores, mp3: has("libmp3lame") }
    })
}

/// The encoder's own arguments for a ProRes profile ("proxy", "lt", "standard", "hq").
pub fn prores_args(encoder: &str, profile: &str) -> Vec<String> {
    let profile = match profile {
        "proxy" | "lt" | "standard" | "hq" => profile,
        _ => "standard",
    };
    let mut a: Vec<String> = vec!["-c:v".into(), encoder.into(), "-profile:v".into(), profile.into()];
    if encoder == "prores_videotoolbox" {
        // Without this FFmpeg asks VideoToolbox for a hardware encoder only, and Macs without a
        // ProRes engine would fail; Apple's software ProRes encoder is the next best thing.
        a.extend(["-allow_sw".into(), "1".into()]);
    } else {
        // Apple's vendor code, as Apple's own encoder writes: some apps check for it.
        a.extend(["-vendor".into(), "apl0".into()]);
    }
    a
}

/// Encodes one small frame through the same v210 pipe input the export uses. VideoToolbox can be
/// compiled in but unusable (an old macOS, a virtual machine), and that only shows when it runs.
fn encodes_a_frame(encoder: &str) -> bool {
    let (w, h) = (64u32, 64u32);
    let mut c = super::ffmpeg();
    c.args(["-f", "v210", "-video_size", &format!("{w}x{h}"), "-framerate", "30", "-i", "pipe:0"]);
    c.args(prores_args(encoder, "standard"));
    c.args(["-f", "null", "-"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    let Ok(mut child) = c.spawn() else { return false };
    let frame = vec![0u8; super::prores::v210_frame_bytes(w, h)];
    let wrote = child.stdin.take().map(|mut s| s.write_all(&frame).is_ok()).unwrap_or(false);
    child.wait().map(|s| s.success()).unwrap_or(false) && wrote
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_arguments() {
        assert_eq!(prores_args("prores_ks", "hq"), ["-c:v", "prores_ks", "-profile:v", "hq", "-vendor", "apl0"]);
        assert_eq!(prores_args("prores_videotoolbox", "lt"), ["-c:v", "prores_videotoolbox", "-profile:v", "lt", "-allow_sw", "1"]);
        // Anything unknown is ProRes 422.
        assert_eq!(prores_args("prores_ks", "4444")[3], "standard");
    }
}
