//! What an AI saw in a library item ("0–3s girl in a high chair eating noodles; 3–8s close-up,
//! laughing"), written with note_media and handed back with list_media so later runs needn't look
//! again (Editroom's `MediaNotes`). Kept per file in `<data dir>/Notes`, never in the project; a
//! changed file is a new file, so its old note is never used.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_LENGTH: usize = 800;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// Seconds since 1970.
    pub date: f64,
}

/// FNV-1a 64, as Editroom's cache names use.
pub fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = vec![];
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// A file's name plus a hash of its path, size, date (and its number on the disk, where there is
/// one): changes whenever the file does.
pub fn cache_name(path: &Path, with_inode: bool) -> String {
    let meta = std::fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        meta.as_ref().map(|m| m.ino()).unwrap_or(0)
    };
    #[cfg(not(unix))]
    let inode = 0u64;
    let stamp = if with_inode {
        format!("{}|{size}|{mtime}|{inode}", path.display())
    } else {
        format!("{}|{size}|{mtime}", path.display())
    };
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{stem}-{}", base36(fnv1a64(&stamp)))
}

fn folder() -> PathBuf {
    super::data_dir().join("Notes")
}

fn file(path: &str) -> PathBuf {
    folder().join(cache_name(Path::new(path), true) + ".json")
}

pub fn note(path: &str) -> Option<Note> {
    std::fs::read(file(path)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn save(text: &str, path: &str, by: Option<&str>) {
    let t = text.trim();
    if t.is_empty() {
        return;
    }
    let note = Note {
        text: t.chars().take(MAX_LENGTH).collect(),
        by: by.map(String::from),
        date: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0),
    };
    let _ = std::fs::create_dir_all(folder());
    if let Ok(b) = serde_json::to_vec(&note) {
        let target = file(path);
        let tmp = target.with_extension("json.tmp");
        if std::fs::write(&tmp, b).is_ok() {
            let _ = std::fs::rename(&tmp, &target);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hashes_like_editroom() {
        assert_eq!(super::fnv1a64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(super::base36(35), "z");
        assert_eq!(super::base36(36), "10");
    }
}
