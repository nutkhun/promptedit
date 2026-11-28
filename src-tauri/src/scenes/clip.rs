//! CLIP ViT-B/32 on ONNX Runtime: sentences and pictures to 512-number embeddings.
//!
//! ONNX Runtime is linked into the app statically (`ort`'s prebuilt binaries for each target), so
//! nothing has to be installed or bundled beside it; see `build.rs` for Windows.

use super::tokenizer::{END, Tokenizer};
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use std::path::Path;

/// The picture side's input: 224×224, CLIP's mean and deviation per channel.
pub const SIZE: usize = 224;
const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const STD: [f32; 3] = [0.268_629_54, 0.261_302_58, 0.275_777_11];

/// Sentences per text-model run (padded to the longest).
const TEXT_BATCH: usize = 64;

pub struct Clip {
    vision: Session,
    text: Option<(Session, Tokenizer)>,
}

fn err(e: impl std::fmt::Display) -> String {
    format!("The picture model didn't run: {e}")
}

/// Half the cores (at least one): tagging runs in the background while the person edits.
fn threads() -> usize {
    std::thread::available_parallelism().map(|n| (n.get() / 2).max(1)).unwrap_or(2)
}

fn session(path: &Path) -> Result<Session, String> {
    Session::builder()
        .map_err(err)?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(err)?
        .with_intra_threads(threads())
        .map_err(err)?
        .commit_from_file(path)
        .map_err(|e| format!("The picture model couldn't be loaded ({}): {e}", path.display()))
}

impl Clip {
    /// The picture side only (the label sentences are embedded once and kept on disk).
    pub fn vision(vision: &Path) -> Result<Clip, String> {
        Ok(Clip { vision: session(vision)?, text: None })
    }

    /// Both sides, for embedding the label sentences.
    pub fn with_text(vision: &Path, text: &Path, tokenizer: &Path) -> Result<Clip, String> {
        let tok = Tokenizer::from_json(&std::fs::read(tokenizer).map_err(|e| e.to_string())?)?;
        Ok(Clip { vision: session(vision)?, text: Some((session(text)?, tok)) })
    }

    /// Embeds sentences, `TEXT_BATCH` at a time. CLIP's text model reads the embedding at the
    /// first end marker, so padding with end markers after it changes nothing.
    pub fn embed_text(&mut self, sentences: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let (session, tok) = self.text.as_mut().ok_or("The text model isn't loaded.")?;
        let mut out = Vec::with_capacity(sentences.len());
        for chunk in sentences.chunks(TEXT_BATCH) {
            let ids: Vec<Vec<i64>> = chunk.iter().map(|s| tok.encode(s)).collect();
            let len = ids.iter().map(Vec::len).max().unwrap_or(2);
            let flat: Vec<i64> = ids.iter().flat_map(|i| i.iter().copied().chain(std::iter::repeat_n(END, len - i.len()))).collect();
            let input = Tensor::from_array(([chunk.len(), len], flat)).map_err(err)?;
            let outputs = session.run(ort::inputs!["input_ids" => input]).map_err(err)?;
            let (shape, data) = outputs["text_embeds"].try_extract_tensor::<f32>().map_err(err)?;
            let dim = shape[1] as usize;
            out.extend(data.chunks(dim).map(<[f32]>::to_vec));
        }
        Ok(out)
    }

    /// Embeds one 224×224 RGB picture (`rgb`: 224·224·3 bytes, rows top first).
    pub fn embed_image(&mut self, rgb: &[u8]) -> Result<Vec<f32>, String> {
        let input = Tensor::from_array(([1, 3, SIZE, SIZE], pixels(rgb)?)).map_err(err)?;
        let outputs = self.vision.run(ort::inputs!["pixel_values" => input]).map_err(err)?;
        let (_, data) = outputs["image_embeds"].try_extract_tensor::<f32>().map_err(err)?;
        Ok(data.to_vec())
    }
}

/// Interleaved RGB bytes → CLIP's planar, normalised input.
pub fn pixels(rgb: &[u8]) -> Result<Vec<f32>, String> {
    let plane = SIZE * SIZE;
    if rgb.len() != plane * 3 {
        return Err(format!("A frame is {} bytes, not {}.", rgb.len(), plane * 3));
    }
    let mut out = vec![0.0f32; plane * 3];
    for (i, px) in rgb.chunks_exact(3).enumerate() {
        for c in 0..3 {
            out[c * plane + i] = (px[c] as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixels_are_planar_and_normalised() {
        let mut rgb = vec![0u8; SIZE * SIZE * 3];
        rgb[0] = 255; // first pixel pure red
        let p = pixels(&rgb).unwrap();
        let plane = SIZE * SIZE;
        assert!((p[0] - (1.0 - MEAN[0]) / STD[0]).abs() < 1e-6);
        assert!((p[plane] - (0.0 - MEAN[1]) / STD[1]).abs() < 1e-6);
        assert!((p[2 * plane + 1] - (0.0 - MEAN[2]) / STD[2]).abs() < 1e-6);
        assert!(pixels(&[0; 12]).is_err());
    }
}
