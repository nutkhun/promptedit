//! Transcripts kept on disk per file: `<app_cache>/Transcripts/<cacheName>.json`, where cacheName
//! is the stem + FNV-1a stamp of path, size and mtime that converted copies use (spec 02-engine
//! §15.4, §18), so a file is heard once and a changed file is heard again.

use crate::mcp::providers::Transcript;
use promptedit_core::MediaAsset;
use std::path::{Path, PathBuf};

/// The files an asset's sound can be read from, best first: the original (ffmpeg reads any
/// format), then its playable copy, for when the original is offline. Keying the cache on the
/// original first keeps a transcript when a playable copy is made later (`transcode_asset`, after
/// the webview fails to decode a file), which would otherwise change the name and hear it again.
pub fn sources(asset: &MediaAsset) -> Vec<PathBuf> {
    let original = PathBuf::from(&asset.path);
    let copy = asset.playable_path.as_deref().map(PathBuf::from);
    std::iter::once(original).chain(copy).filter(|p| p.is_file()).collect()
}

/// The file to hear: the first source, or the original's path when neither is there (ffmpeg then
/// says it can't read it, and the job fails with that).
pub fn sound_path(asset: &MediaAsset) -> PathBuf {
    sources(asset).into_iter().next().unwrap_or_else(|| PathBuf::from(&asset.path))
}

/// The cache files that may hold an asset's transcript, one per source, best first. A transcript
/// is saved under the name of the file it was heard from.
pub fn candidates(dir: &Path, asset: &MediaAsset) -> Vec<PathBuf> {
    match sources(asset) {
        s if s.is_empty() => vec![file_for(dir, Path::new(&asset.path))],
        s => s.iter().map(|p| file_for(dir, p)).collect(),
    }
}

/// Where the transcript of `sound` lives.
pub fn file_for(dir: &Path, sound: &Path) -> PathBuf {
    dir.join(format!("{}.json", crate::media::cache_stem(sound)))
}

pub fn load(file: &Path) -> Option<Transcript> {
    let bytes = std::fs::read(file).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Written whole or not at all (a temporary file, then renamed).
pub fn save(file: &Path, t: &Transcript) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec(t).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::providers::Word;

    #[test]
    fn names_follow_the_file() {
        let dir = std::env::temp_dir().join(format!("promptedit-tcache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("Interview take 2.mov");
        std::fs::write(&clip, b"one").unwrap();
        let cache = dir.join("Transcripts");
        let a = file_for(&cache, &clip);
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("Interview take 2-") && name.ends_with(".json"), "{name}");
        // Base-36 hash between the stem and the extension.
        let hash = &name["Interview take 2-".len()..name.len() - 5];
        assert!(!hash.is_empty() && hash.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()), "{hash}");
        // Same file, same name; the same as a converted copy's name but for the extension.
        assert_eq!(file_for(&cache, &clip), a);
        assert_eq!(format!("{}.json", crate::media::cache_stem(&clip)), name);
        // A changed file (size) gets a new name; another path does too.
        std::fs::write(&clip, b"longer").unwrap();
        assert_ne!(file_for(&cache, &clip), a);
        assert_ne!(file_for(&cache, &dir.join("other.mov")), file_for(&cache, &clip));

        let t = Transcript { words: vec![Word { start: 1.25, end: 1.6, text: "Hello,".into() }], language: "en".into() };
        let f = file_for(&cache, &clip);
        assert!(load(&f).is_none());
        save(&f, &t).unwrap();
        assert_eq!(load(&f), Some(t));
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({"words": [{"start": 1.25, "end": 1.6, "text": "Hello,"}], "language": "en"}));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sound_comes_from_the_original_then_the_playable_copy() {
        let dir = std::env::temp_dir().join(format!("promptedit-tsound-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("a.mkv");
        let copy = dir.join("copy.mov");
        std::fs::write(&copy, b"x").unwrap();
        let cache = dir.join("Transcripts");
        let mut a: MediaAsset = serde_json::from_value(serde_json::json!({
            "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF", "path": original, "name": "a", "kind": "video",
            "duration": 1.0, "width": 1, "height": 1, "fps": 30.0, "hasAudio": true
        }))
        .unwrap();
        // Nothing on disk: the original's path (and its cache name).
        assert_eq!(sound_path(&a), original);
        assert_eq!(candidates(&cache, &a), vec![file_for(&cache, &original)]);
        // Offline original with a playable copy: the copy.
        a.playable_path = Some(copy.to_string_lossy().into_owned());
        assert_eq!(sound_path(&a), copy);
        assert_eq!(candidates(&cache, &a), vec![file_for(&cache, &copy)]);
        // Both: the original first, so making a copy later keeps the transcript's name.
        std::fs::write(&original, b"y").unwrap();
        assert_eq!(sound_path(&a), original);
        assert_eq!(candidates(&cache, &a), vec![file_for(&cache, &original), file_for(&cache, &copy)]);
        a.playable_path = Some(dir.join("gone.mov").to_string_lossy().into_owned());
        assert_eq!(candidates(&cache, &a), vec![file_for(&cache, &original)]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
