//! The picture model: OpenAI's CLIP ViT-B/32 (MIT licence), as int8-quantised ONNX exports from
//! Hugging Face (`Xenova/clip-vit-base-patch32`, pinned to one commit so the files never change
//! under us), downloaded once into `<app_data>/Models/clip-vit-b32/` when the person agrees, the
//! way speech models are (`transcribe::models`): streamed into `.part`, checked, then renamed.
//!
//! Also keeps the label sentences' embeddings, made once with the text model after the download,
//! in the same folder.

use super::score::Labels;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPO: &str = "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/6b7c523703ae26e39be4b03774966f8571c7f523";
const FOLDER: &str = "clip-vit-b32";
/// What Settings shows, in MB (10^6 bytes): the three files together.
pub const SIZE_MB: u64 = 156;
pub const LABEL: &str = "CLIP ViT-B/32";

pub struct File {
    /// Path in the repository.
    pub remote: &'static str,
    pub name: &'static str,
    pub bytes: u64,
    /// Hugging Face's LFS id for the file is its SHA-256; the tokenizer isn't in LFS.
    pub sha256: Option<&'static str>,
}

pub const VISION: File = File {
    remote: "onnx/vision_model_quantized.onnx",
    name: "vision_model_quantized.onnx",
    bytes: 89_117_001,
    sha256: Some("583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299"),
};
pub const TEXT: File = File {
    remote: "onnx/text_model_quantized.onnx",
    name: "text_model_quantized.onnx",
    bytes: 64_504_507,
    sha256: Some("73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a"),
};
pub const TOKENIZER: File = File { remote: "tokenizer.json", name: "tokenizer.json", bytes: 2_224_119, sha256: None };

pub const FILES: [&File; 3] = [&VISION, &TEXT, &TOKENIZER];

pub fn folder(models_dir: &Path) -> PathBuf {
    models_dir.join(FOLDER)
}

pub fn path(models_dir: &Path, f: &File) -> PathBuf {
    folder(models_dir).join(f.name)
}

/// Whether every file is here (each only gets its name once it's whole and checked).
pub fn installed(models_dir: &Path) -> bool {
    FILES.iter().all(|f| path(models_dir, f).is_file())
}

/// Downloads whatever isn't here yet. Blocking (its own small async runtime); `progress` gets 0…1
/// over all the files.
pub fn download(models_dir: &Path, mut progress: impl FnMut(f64)) -> Result<(), String> {
    let dir = folder(models_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the models folder: {e}"))?;
    let total: u64 = FILES.iter().map(|f| f.bytes).sum();
    let mut done: u64 = FILES.iter().filter(|f| path(models_dir, f).is_file()).map(|f| f.bytes).sum();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    for f in FILES {
        let target = path(models_dir, f);
        if target.is_file() {
            continue;
        }
        let part = dir.join(format!("{}.part", f.name));
        let base = done;
        let result = rt.block_on(fetch(&format!("{REPO}/{}", f.remote), &part, f, &mut |got| {
            progress(((base + got) as f64 / total as f64).min(1.0))
        }));
        if let Err(e) = result {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
        std::fs::rename(&part, &target).map_err(|e| format!("Couldn't save the picture model: {e}"))?;
        done += f.bytes;
    }
    progress(1.0);
    Ok(())
}

async fn fetch(url: &str, part: &Path, f: &File, progress: &mut impl FnMut(u64)) -> Result<(), String> {
    let offline = |e: reqwest::Error| {
        if e.is_connect() || e.is_timeout() {
            "Couldn't reach huggingface.co to download the picture model. Check the internet connection.".to_string()
        } else {
            format!("The picture model download stopped: {e}")
        }
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // A stalled connection fails instead of hanging forever; a slow one is fine.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(offline)?;
    if !resp.status().is_success() {
        return Err(format!("Couldn't download the picture model (the server said {}).", resp.status()));
    }
    let mut file = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(part).map_err(|e| e.to_string())?);
    let mut hash = Sha256::new();
    let mut got: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(offline)?;
        file.write_all(&chunk).map_err(|e| format!("Couldn't save the picture model: {e}"))?;
        hash.update(&chunk);
        got += chunk.len() as u64;
        // A captive portal or an error page isn't the model: stop as soon as it's too long.
        if got > f.bytes {
            return Err("The picture model on the server isn't the expected file.".into());
        }
        progress(got);
    }
    file.flush().map_err(|e| format!("Couldn't save the picture model: {e}"))?;
    if got != f.bytes {
        return Err(format!("The picture model download was cut short ({} of {} MB).", got / 1_000_000, f.bytes / 1_000_000));
    }
    if let Some(want) = f.sha256 {
        let have: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if have != want {
            return Err("The downloaded picture model isn't the expected file.".into());
        }
    }
    Ok(())
}

// MARK: Label embeddings

const MAGIC: &[u8; 8] = b"PEclipT1";

/// What the embeddings were made from: the sentences and the text model. A changed label list
/// makes them again.
fn key(labels: &Labels) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for s in labels.sentences().iter().map(String::as_str).chain([TEXT.sha256.unwrap_or_default()]) {
        for b in s.bytes().chain([0]) {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    h
}

pub fn embeddings_file(models_dir: &Path) -> PathBuf {
    folder(models_dir).join("label-embeddings.bin")
}

/// The saved embeddings, if they were made from these labels.
pub fn load_embeddings(file: &Path, labels: &Labels) -> Option<Vec<Vec<f32>>> {
    let b = std::fs::read(file).ok()?;
    let u64_at = |i: usize| b.get(i..i + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap()));
    if b.get(..8)? != MAGIC || u64_at(8)? != key(labels) {
        return None;
    }
    let (count, dim) = (u64_at(16)? as usize, u64_at(24)? as usize);
    let data = b.get(32..)?;
    if count != labels.sentences().len() || dim == 0 || data.len() != count * dim * 4 {
        return None;
    }
    let floats: Vec<f32> = data.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
    Some(floats.chunks(dim).map(<[f32]>::to_vec).collect())
}

pub fn save_embeddings(file: &Path, labels: &Labels, e: &[Vec<f32>]) -> Result<(), String> {
    let dim = e.first().map(Vec::len).unwrap_or(0);
    let mut b = Vec::with_capacity(32 + e.len() * dim * 4);
    b.extend_from_slice(MAGIC);
    for n in [key(labels), e.len() as u64, dim as u64] {
        b.extend_from_slice(&n.to_le_bytes());
    }
    for v in e {
        for x in v {
            b.extend_from_slice(&x.to_le_bytes());
        }
    }
    let tmp = file.with_extension("bin.tmp");
    std::fs::write(&tmp, b).and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeddings_round_trip_and_follow_the_labels() {
        let dir = std::env::temp_dir().join(format!("promptedit-clipemb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("e.bin");
        let labels = Labels::builtin();
        let n = labels.sentences().len();
        let e: Vec<Vec<f32>> = (0..n).map(|i| vec![i as f32, 0.5, -1.0]).collect();
        assert!(load_embeddings(&file, &labels).is_none());
        save_embeddings(&file, &labels, &e).unwrap();
        assert_eq!(load_embeddings(&file, &labels).unwrap(), e);
        // Another label list: made again.
        let mut other = labels.clone();
        other.labels.push("zeppelin".into());
        assert!(load_embeddings(&file, &other).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn files_are_pinned() {
        assert!(REPO.contains("/resolve/6b7c5237"));
        let total: u64 = FILES.iter().map(|f| f.bytes).sum();
        assert_eq!((total as f64 / 1e6).round() as u64, SIZE_MB);
        assert!(!installed(Path::new("/nonexistent")));
    }
}
