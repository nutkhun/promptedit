//! Pictures for agents (Editroom's `ContactSheet` and `get_frame`): frames read from the source
//! files with the FFmpeg sidecar at the clip's source times.
//!
//! Parity gap: Editroom's get_frame renders the cut with its GPU compositor. PromptEdit's compositor
//! runs in the WebView (WebGL2), which a background tool call can't rely on, so `cut_frame` builds
//! an approximation in Rust: every visible video, photo and solid layer at that time, bottom track
//! first, placed with its transform. Grades, looks, fades, transitions, titles and captions are not
//! drawn (the tool's note says so when they're there).

use image::{Rgb, RgbImage, imageops};
use promptedit_core::{Clip, ClipKind, MediaAsset, MediaKind, Project};
use std::io::Cursor;
use std::path::Path;
use std::process::{Command, Stdio};

pub fn ffmpeg() -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(crate::media::tool("ffmpeg"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.stdin(Stdio::null()).stderr(Stdio::null());
    c
}

/// Parses binary PPM (P6), which is what FFmpeg writes with `-vcodec ppm`.
pub fn parse_ppm(data: &[u8]) -> Option<(RgbImage, usize)> {
    let mut fields = vec![];
    let mut i = 0;
    while fields.len() < 4 && i < data.len() {
        while i < data.len() && data[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < data.len() && data[i] == b'#' {
            while i < data.len() && data[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        let s = i;
        while i < data.len() && !data[i].is_ascii_whitespace() {
            i += 1;
        }
        fields.push(std::str::from_utf8(&data[s..i]).ok()?.to_string());
    }
    if fields.len() < 4 || fields[0] != "P6" {
        return None;
    }
    let (w, h): (u32, u32) = (fields[1].parse().ok()?, fields[2].parse().ok()?);
    let start = i + 1;
    let len = (w * h * 3) as usize;
    let pixels = data.get(start..start + len)?.to_vec();
    Some((RgbImage::from_raw(w, h, pixels)?, start + len))
}

/// One frame of a file at `t` seconds, no bigger than `max_w`×`max_h` (rotation applied by FFmpeg).
pub fn frame(path: &Path, t: f64, max_w: u32, max_h: u32, image: bool) -> Option<RgbImage> {
    let mut c = ffmpeg();
    c.args(["-v", "error", "-nostdin"]);
    if !image {
        c.args(["-ss", &format!("{:.3}", t.max(0.0))]);
    }
    c.arg("-i").arg(path);
    c.args([
        "-frames:v",
        "1",
        "-vf",
        &format!("scale=w={max_w}:h={max_h}:force_original_aspect_ratio=decrease"),
        "-f",
        "image2pipe",
        "-vcodec",
        "ppm",
        "-",
    ]);
    let out = c.stdout(Stdio::piped()).output().ok()?;
    parse_ppm(&out.stdout).map(|(img, _)| img)
}

pub fn jpeg(img: &RgbImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Cursor::new(vec![]);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(img).ok()?;
    Some(out.into_inner())
}

pub fn png(img: &RgbImage) -> Option<Vec<u8>> {
    let mut out = Cursor::new(vec![]);
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

fn source_path(a: &MediaAsset) -> &str {
    // The original first (it has every frame); the playable copy if the original has gone.
    if Path::new(&a.path).exists() { &a.path } else { a.playable_path.as_deref().unwrap_or(&a.path) }
}

/// A contact sheet: a photo as it is (≤ 768 px), or frames from across a video in a grid, each marked
/// with its time in the file. Returns the JPEG and the frame times, in reading order.
pub fn contact_sheet(a: &MediaAsset, frames: i64, times: Option<&[f64]>) -> Option<(Vec<u8>, Vec<f64>)> {
    let path = Path::new(source_path(a));
    if a.kind == MediaKind::Image {
        let img = frame(path, 0.0, 768, 768, true)?;
        return Some((jpeg(&img, 80)?, vec![]));
    }
    if a.kind != MediaKind::Video || a.duration <= 0.0 {
        return None;
    }
    let wanted: Vec<f64> = match times {
        Some(t) if !t.is_empty() => t.iter().take(12).map(|v| v.max(0.0).min((a.duration - 0.05).max(0.0))).collect(),
        _ => {
            let n = frames.clamp(1, 12);
            (0..n).map(|i| (i as f64 + 0.5) * a.duration / n as f64).collect()
        }
    };
    let mut got: Vec<(f64, RgbImage)> = std::thread::scope(|s| {
        let handles: Vec<_> = wanted.iter().map(|&t| s.spawn(move || frame(path, t, 360, 360, false).map(|f| (t, f)))).collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    });
    got.sort_by(|x, y| x.0.total_cmp(&y.0));
    let first = got.first()?.1.dimensions();
    // A grid of up to four across, each cell the first frame's shape, with its time in the corner.
    let n = got.len();
    let columns = if n <= 4 { n } else if n <= 6 { 3 } else { 4 };
    let rows = n.div_ceil(columns);
    let (cw, ch) = first;
    let gap = 4u32;
    let w = columns as u32 * cw + (columns as u32 - 1) * gap;
    let h = rows as u32 * ch + (rows as u32 - 1) * gap;
    let mut sheet = RgbImage::from_pixel(w, h, Rgb([26, 26, 26]));
    for (i, (t, img)) in got.iter().enumerate() {
        let x = (i % columns) as u32 * (cw + gap);
        let y = (i / columns) as u32 * (ch + gap);
        // Frames of another shape (a rotated clip) fit inside the cell.
        let s = (cw as f64 / img.width() as f64).min(ch as f64 / img.height() as f64);
        let (fw, fh) = (((img.width() as f64 * s).round() as u32).max(1), ((img.height() as f64 * s).round() as u32).max(1));
        let fitted = if (fw, fh) == img.dimensions() { img.clone() } else { imageops::resize(img, fw, fh, imageops::FilterType::Triangle) };
        imageops::replace(&mut sheet, &fitted, (x + (cw - fw) / 2) as i64, (y + (ch - fh) / 2) as i64);
        label(&mut sheet, x + 4, y + 4, &format!("{t:.1}s"));
    }
    Some((jpeg(&sheet, 80)?, got.iter().map(|g| g.0).collect()))
}

/// A picture of the cut at `t`, 640 px on its longer side, as PNG. The note says what isn't drawn.
pub fn cut_frame(p: &Project, t: f64) -> Option<(Vec<u8>, Option<String>)> {
    let scale = 640.0 / (p.width.max(p.height).max(1) as f64);
    let (w, h) = (((p.width as f64 * scale).round() as u32).max(2), ((p.height as f64 * scale).round() as u32).max(2));
    let mut out = RgbImage::from_pixel(w, h, Rgb([0, 0, 0]));
    let mut missing = vec![];
    for track in &p.video_tracks {
        if track.hidden {
            continue;
        }
        let Some(c) = p.clips.iter().rfind(|c| c.track_id == track.id && c.start <= t + 1e-6 && t < c.end() - 1e-6) else { continue };
        if c.grade.as_ref().is_some_and(|g| !g.is_neutral()) && !missing.contains(&"colour") {
            missing.push("colour");
        }
        match c.kind {
            ClipKind::Text => {
                if !missing.contains(&"titles") {
                    missing.push("titles");
                }
            }
            ClipKind::Solid => {
                let col = Rgb([(c.color.r * 255.0) as u8, (c.color.g * 255.0) as u8, (c.color.b * 255.0) as u8]);
                let layer = RgbImage::from_pixel(w, h, col);
                place(&mut out, &layer, c, w, h, t);
            }
            ClipKind::Video | ClipKind::Image => {
                let Some(a) = p.asset(c.asset_id) else { continue };
                let source = source_time(c, a, t);
                if let Some(img) = frame(Path::new(source_path(a)), source, w * 2, h * 2, a.kind == MediaKind::Image) {
                    // Fitted inside the frame, as the compositor does at scale 1.
                    let s = (w as f64 / img.width() as f64).min(h as f64 / img.height() as f64);
                    let fitted = imageops::resize(&img, ((img.width() as f64 * s) as u32).max(1), ((img.height() as f64 * s) as u32).max(1), imageops::FilterType::Triangle);
                    place(&mut out, &fitted, c, w, h, t);
                }
            }
            ClipKind::Audio => {}
        }
    }
    let note = (!missing.is_empty()).then(|| format!("This preview doesn't draw {}.", missing.join(" or ")));
    Some((png(&out)?, note))
}

/// The time in the file a clip shows at timeline time `t`.
pub fn source_time(c: &Clip, a: &MediaAsset, t: f64) -> f64 {
    if c.kind == ClipKind::Image {
        return 0.0;
    }
    if c.is_freeze() {
        return c.source_start;
    }
    let s = c.source_time(t.clamp(c.start, c.end()));
    if c.plays_backwards() { (a.duration - s).max(0.0) } else { s }
}

/// Draws a layer centred in the frame, scaled and offset by the clip's transform.
fn place(out: &mut RgbImage, layer: &RgbImage, c: &Clip, w: u32, h: u32, t: f64) {
    // The framing at this moment of the clip, with any zoom applied (None is the plain full frame).
    let tf = c.transform.and_then(|tf| tf.at(t - c.start)).unwrap_or_default();
    let img = if (tf.scale - 1.0).abs() > 1e-3 {
        let (lw, lh) = (((layer.width() as f64 * tf.scale).round() as u32).max(1), ((layer.height() as f64 * tf.scale).round() as u32).max(1));
        imageops::resize(layer, lw.min(8192), lh.min(8192), imageops::FilterType::Triangle)
    } else {
        layer.clone()
    };
    let cx = w as f64 / 2.0 + tf.x * w as f64;
    let cy = h as f64 / 2.0 + tf.y * h as f64;
    let x = (cx - img.width() as f64 / 2.0).round() as i64;
    let y = (cy - img.height() as f64 / 2.0).round() as i64;
    imageops::replace(out, &img, x, y);
}

// MARK: Labels

/// 5×7 glyphs for the characters a frame label uses ("12.5s").
fn glyph(ch: char) -> [u8; 7] {
    match ch {
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        '.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
        's' => [0x00, 0x00, 0x0E, 0x10, 0x0E, 0x01, 0x1E],
        _ => [0; 7],
    }
}

/// White text on a 60 % black box, top-left at (x, y): Editroom's frame-time label.
pub fn label(img: &mut RgbImage, x: u32, y: u32, text: &str) {
    const S: u32 = 2; // pixel size: 10×14 glyphs, about the 15 pt label
    let advance = 6 * S;
    let (bw, bh) = (text.chars().count() as u32 * advance + 8 - S, 7 * S + 8);
    for yy in y..(y + bh).min(img.height()) {
        for xx in x..(x + bw).min(img.width()) {
            let p = img.get_pixel_mut(xx, yy);
            for c in p.0.iter_mut() {
                *c = (*c as f32 * 0.4) as u8;
            }
        }
    }
    for (i, ch) in text.chars().enumerate() {
        let g = glyph(ch);
        for (row, bits) in g.iter().enumerate() {
            for col in 0..5 {
                if bits & (0x10 >> col) == 0 {
                    continue;
                }
                for dy in 0..S {
                    for dx in 0..S {
                        let px = x + 4 + i as u32 * advance + col * S + dx;
                        let py = y + 4 + row as u32 * S + dy;
                        if px < img.width() && py < img.height() {
                            img.put_pixel(px, py, Rgb([255, 255, 255]));
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ppm() {
        let mut data = b"P6\n2 1\n255\n".to_vec();
        data.extend([255, 0, 0, 0, 255, 0]);
        let (img, used) = parse_ppm(&data).unwrap();
        assert_eq!(img.dimensions(), (2, 1));
        assert_eq!(img.get_pixel(1, 0).0, [0, 255, 0]);
        assert_eq!(used, data.len());
    }

    #[test]
    fn labels_fit() {
        let mut img = RgbImage::new(100, 40);
        label(&mut img, 4, 4, "12.5s");
        assert!(img.pixels().any(|p| p.0 == [255, 255, 255]));
    }
}
