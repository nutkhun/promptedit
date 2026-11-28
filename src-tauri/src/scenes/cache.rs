//! Scene tags kept on disk per file: `<app_cache>/Scenes/<cacheName>-3.json` in Editroom's shape
//! (`{"tags":[{"name","confidence","times"}]}`), where cacheName is the stem + FNV-1a stamp of
//! path, size and mtime that transcripts and converted copies use (spec 02-engine §15.4, §17), so
//! a file is looked at once and a changed file is looked at again.

use crate::mcp::providers::SceneTags;
use promptedit_core::MediaAsset;
use std::path::{Path, PathBuf};

/// The files an asset's picture can be read from, best first: the original (ffmpeg reads any
/// format), then its playable copy for when the original is offline. Keyed on the original first,
/// so a playable copy made later doesn't change the name and make the tags again.
pub fn sources(asset: &MediaAsset) -> Vec<PathBuf> {
    let original = PathBuf::from(&asset.path);
    let copy = asset.playable_path.as_deref().map(PathBuf::from);
    std::iter::once(original).chain(copy).filter(|p| p.is_file()).collect()
}

/// The file to look at: the first source, or the original's path when neither is there.
pub fn picture_path(asset: &MediaAsset) -> PathBuf {
    sources(asset).into_iter().next().unwrap_or_else(|| PathBuf::from(&asset.path))
}

/// The cache files that may hold an asset's tags, one per source, best first.
pub fn candidates(dir: &Path, asset: &MediaAsset) -> Vec<PathBuf> {
    match sources(asset) {
        s if s.is_empty() => vec![file_for(dir, Path::new(&asset.path))],
        s => s.iter().map(|p| file_for(dir, p)).collect(),
    }
}

/// "-3" as Editroom names its version of how tags are chosen; bump it when ours changes.
pub fn file_for(dir: &Path, picture: &Path) -> PathBuf {
    dir.join(format!("{}-3.json", crate::media::cache_stem(picture)))
}

pub fn load(file: &Path) -> Option<SceneTags> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// Written whole or not at all (a temporary file, then renamed).
pub fn save(file: &Path, t: &SceneTags) -> Result<(), String> {
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
    use crate::mcp::providers::Tag;

    #[test]
    fn named_like_transcripts_with_editroom_version() {
        let dir = std::env::temp_dir().join(format!("promptedit-scache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("Beach day.mov");
        std::fs::write(&clip, b"one").unwrap();
        let cache = dir.join("Scenes");
        let f = file_for(&cache, &clip);
        assert_eq!(f.file_name().unwrap().to_string_lossy(), format!("{}-3.json", crate::media::cache_stem(&clip)));
        assert!(f.file_name().unwrap().to_string_lossy().starts_with("Beach day-"));
        let t = SceneTags { tags: vec![Tag { name: "beach".into(), confidence: 0.81, times: vec![0.5, 1.5] }] };
        assert!(load(&f).is_none());
        save(&f, &t).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({"tags": [{"name": "beach", "confidence": 0.81, "times": [0.5, 1.5]}]}));
        assert_eq!(load(&f).unwrap().tags[0].name, "beach");
        // A changed file is looked at again.
        std::fs::write(&clip, b"longer").unwrap();
        assert_ne!(file_for(&cache, &clip), f);
        std::fs::remove_dir_all(&dir).ok();
    }
}
