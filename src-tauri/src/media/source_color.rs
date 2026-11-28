//! How a video's picture is encoded (Editroom `SourceColor.of`, spec 02-engine §3.7): HLG and PQ
//! come from ffprobe's transfer; Apple Log from the QuickTime sample description.
//!
//! Apple Log is tagged with the CoreMedia extension `LogTransferFunction`
//! (`com.apple.rec2020.apple-log`, or `com.apple.apple-wide-gamut.apple-log` for Apple Log 2), which
//! ffprobe doesn't report. CoreMedia keeps the value as a string inside the video track's `stsd`
//! sample entry. Rather than depend on the exact name of the atom that carries it, this walks
//! moov → trak → mdia → minf → stbl → stsd of each video track and looks for the value itself, so
//! a string elsewhere in the file (a title, a file name in metadata) can't trigger it.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceColor {
    /// Rec.709 / sRGB: drawn as is.
    #[default]
    Standard,
    /// HDR with the HLG curve.
    Hlg,
    /// HDR10 / PQ.
    Pq,
    /// Apple Log, Rec.2020 primaries.
    AppleLog,
    /// Apple Log 2: the same curve in Apple Wide Gamut.
    AppleLog2,
}

/// A moov larger than this isn't read (a real one is a few MB even for hour-long files).
const MAX_MOOV: u64 = 256 << 20;

/// The file's source colour: Apple Log first (as Editroom checks it), then the HDR transfers.
pub fn detect(path: &Path, color_transfer: Option<&str>) -> SourceColor {
    if let Some(log) = std::fs::File::open(path).ok().and_then(|mut f| apple_log(&mut f)) {
        return log;
    }
    match color_transfer {
        Some("arib-std-b67") => SourceColor::Hlg,
        Some("smpte2084") => SourceColor::Pq,
        _ => SourceColor::Standard,
    }
}

/// Apple Log or Log 2 when a video track's sample description says so.
pub fn apple_log<R: Read + Seek>(r: &mut R) -> Option<SourceColor> {
    let moov = read_moov(r)?;
    for trak in children(&moov).filter(|(t, _)| t == b"trak") {
        let Some(mdia) = child(trak.1, b"mdia") else { continue };
        if !is_video(mdia) {
            continue;
        }
        let stsd = child(mdia, b"minf").and_then(|m| child(m, b"stbl")).and_then(|s| child(s, b"stsd"));
        if let Some(found) = stsd.and_then(log_in) {
            return Some(found);
        }
    }
    None
}

/// The `moov` box's payload, found by walking the top-level boxes (headers only).
fn read_moov<R: Read + Seek>(r: &mut R) -> Option<Vec<u8>> {
    let end = r.seek(SeekFrom::End(0)).ok()?;
    let mut at = 0u64;
    while at + 8 <= end {
        r.seek(SeekFrom::Start(at)).ok()?;
        let mut h = [0u8; 16];
        r.read_exact(&mut h[..8]).ok()?;
        let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        let kind = [h[4], h[5], h[6], h[7]];
        if !kind.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
            return None; // not an ISO/QuickTime file
        }
        let (size, header) = match size32 {
            0 => (end - at, 8),
            1 => {
                r.read_exact(&mut h[8..16]).ok()?;
                (u64::from_be_bytes(h[8..16].try_into().ok()?), 16)
            }
            s => (s, 8),
        };
        if size < header || at + size > end {
            return None;
        }
        if &kind == b"moov" {
            let len = size - header;
            if len > MAX_MOOV {
                return None;
            }
            let mut buf = vec![0u8; len as usize];
            r.read_exact(&mut buf).ok()?;
            return Some(buf);
        }
        at += size;
    }
    None
}

/// The boxes inside a payload: (type, payload). Stops at the first malformed one.
fn children(data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut at = 0usize;
    std::iter::from_fn(move || {
        if at + 8 > data.len() {
            return None;
        }
        let size32 = u32::from_be_bytes(data[at..at + 4].try_into().ok()?) as usize;
        let kind: [u8; 4] = data[at + 4..at + 8].try_into().ok()?;
        let (size, header) = match size32 {
            0 => (data.len() - at, 8),
            1 => {
                let s = u64::from_be_bytes(data.get(at + 8..at + 16)?.try_into().ok()?);
                (usize::try_from(s).ok()?, 16)
            }
            s => (s, 8),
        };
        if size < header || at + size > data.len() {
            return None;
        }
        let payload = &data[at + header..at + size];
        at += size;
        Some((kind, payload))
    })
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    children(data).find(|(t, _)| t == kind).map(|(_, p)| p)
}

/// `hdlr` (version/flags 4, pre_defined 4, handler_type 4) says "vide".
fn is_video(mdia: &[u8]) -> bool {
    child(mdia, b"hdlr").and_then(|h| h.get(8..12)) == Some(b"vide")
}

/// Looks for the `LogTransferFunction` value in a sample description, as a whole printable token.
fn log_in(stsd: &[u8]) -> Option<SourceColor> {
    const NEEDLE: &[u8] = b"apple-log";
    let lower: Vec<u8> = stsd.iter().map(u8::to_ascii_lowercase).collect();
    let i = lower.windows(NEEDLE.len()).position(|w| w == NEEDLE)?;
    let token_char = |b: u8| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_';
    let start = lower[..i].iter().rposition(|b| !token_char(*b)).map_or(0, |p| p + 1);
    let end = lower[i..].iter().position(|b| !token_char(*b)).map_or(lower.len(), |p| p + i);
    let token = &lower[start..end];
    let contains = |s: &[u8]| token.windows(s.len()).any(|w| w == s);
    // "com.apple.rec2020.apple-log" / "com.apple.apple-wide-gamut.apple-log" (Editroom's rule).
    Some(if contains(b"wide-gamut") || contains(b"apple-log2") { SourceColor::AppleLog2 } else { SourceColor::AppleLog })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;

    fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }

    /// A minimal file: ftyp, mdat, then a moov with one track of `handler` whose sample entry carries `extra`.
    pub(crate) fn file(handler: &[u8; 4], extra: &[u8]) -> Vec<u8> {
        let mut entry = vec![0u8; 78]; // reserved(6) + data_ref(2) + visual sample entry fields(70)
        entry.extend_from_slice(&boxed(b"colr", b"nclx\0\x09\0\x01\0\x09\0"));
        entry.extend_from_slice(extra);
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend_from_slice(&boxed(b"hvc1", &entry));
        let stbl = boxed(b"stbl", &boxed(b"stsd", &stsd));
        let minf = boxed(b"minf", &stbl);
        let mut hdlr = vec![0u8; 8];
        hdlr.extend_from_slice(handler);
        hdlr.extend_from_slice(&[0u8; 13]);
        let mut mdia = boxed(b"hdlr", &hdlr);
        mdia.extend_from_slice(&minf);
        let moov = boxed(b"moov", &boxed(b"trak", &boxed(b"mdia", &mdia)));
        let mut f = boxed(b"ftyp", b"qt  \0\0\0\0qt  ");
        f.extend_from_slice(&boxed(b"mdat", &[0u8; 64]));
        f.extend_from_slice(&moov);
        f
    }

    #[test]
    fn finds_apple_log_in_the_sample_description() {
        let log = boxed(b"alog", b"com.apple.rec2020.apple-log\0");
        assert_eq!(apple_log(&mut Cursor::new(file(b"vide", &log))), Some(SourceColor::AppleLog));
        let log2 = boxed(b"alog", b"com.apple.apple-wide-gamut.apple-log\0");
        assert_eq!(apple_log(&mut Cursor::new(file(b"vide", &log2))), Some(SourceColor::AppleLog2));
        // Upper case and in any atom.
        let other = boxed(b"xtra", b"\x00\x10COM.APPLE.REC2020.APPLE-LOG");
        assert_eq!(apple_log(&mut Cursor::new(file(b"vide", &other))), Some(SourceColor::AppleLog));
    }

    #[test]
    fn ignores_other_tracks_and_plain_files() {
        let log = boxed(b"alog", b"com.apple.rec2020.apple-log");
        assert_eq!(apple_log(&mut Cursor::new(file(b"soun", &log))), None, "not a video track");
        assert_eq!(apple_log(&mut Cursor::new(file(b"vide", &[]))), None);
        assert_eq!(apple_log(&mut Cursor::new(b"\x1aE\xdf\xa3 matroska".to_vec())), None);
        assert_eq!(apple_log(&mut Cursor::new(Vec::new())), None);
        // Truncated moov: no panic.
        let mut f = file(b"vide", &log);
        f.truncate(f.len() - 20);
        assert_eq!(apple_log(&mut Cursor::new(f)), None);
    }

    #[test]
    fn transfer_decides_otherwise() {
        let missing = Path::new("/nonexistent/file.mov");
        assert_eq!(detect(missing, Some("arib-std-b67")), SourceColor::Hlg);
        assert_eq!(detect(missing, Some("smpte2084")), SourceColor::Pq);
        assert_eq!(detect(missing, Some("bt709")), SourceColor::Standard);
        assert_eq!(detect(missing, None), SourceColor::Standard);
    }
}
