//! CLIP's text tokenizer (byte-level BPE with `</w>` word ends), read from the model's
//! `tokenizer.json`. Small enough to keep here rather than pull in the `tokenizers` crate for the
//! few hundred fixed label prompts it ever encodes.
//!
//! Matches Hugging Face's CLIPTokenizer for the text we give it (lower-case English prompts): the
//! normaliser collapses whitespace and lower-cases (its NFC step changes nothing in ASCII), the
//! pre-tokeniser splits with CLIP's pattern, then each piece is byte-encoded and merged.

use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;

pub const START: i64 = 49406;
pub const END: i64 = 49407;
/// CLIP's text model reads at most 77 tokens, start and end included.
const MAX_TOKENS: usize = 77;

pub struct Tokenizer {
    vocab: HashMap<String, i64>,
    ranks: HashMap<(String, String), usize>,
    bytes: [char; 256],
    split: Regex,
}

#[derive(Deserialize)]
struct File {
    model: Model,
}

#[derive(Deserialize)]
struct Model {
    vocab: HashMap<String, i64>,
    merges: Vec<Merge>,
}

/// Merges are `"a b"` in older tokenizer files and `["a", "b"]` in newer ones.
#[derive(Deserialize)]
#[serde(untagged)]
enum Merge {
    Joined(String),
    Pair(String, String),
}

/// GPT-2's byte → printable character table, which byte-level BPE vocabularies are written in.
fn byte_chars() -> [char; 256] {
    let mut out = ['\0'; 256];
    let printable = |b: u32| (0x21..=0x7e).contains(&b) || (0xa1..=0xac).contains(&b) || (0xae..=0xff).contains(&b);
    let mut next = 256;
    for b in 0..256u32 {
        out[b as usize] = if printable(b) {
            char::from_u32(b).unwrap()
        } else {
            next += 1;
            char::from_u32(next - 1).unwrap()
        };
    }
    out
}

impl Tokenizer {
    pub fn from_json(bytes: &[u8]) -> Result<Tokenizer, String> {
        let f: File = serde_json::from_slice(bytes).map_err(|e| format!("The picture model's tokenizer can't be read: {e}"))?;
        let ranks = f
            .model
            .merges
            .into_iter()
            .enumerate()
            .filter_map(|(i, m)| {
                let (a, b) = match m {
                    Merge::Pair(a, b) => (a, b),
                    Merge::Joined(s) => {
                        let (a, b) = s.split_once(' ')?;
                        (a.to_string(), b.to_string())
                    }
                };
                Some(((a, b), i))
            })
            .collect();
        let split = Regex::new(r"<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+").unwrap();
        Ok(Tokenizer { vocab: f.model.vocab, ranks, bytes: byte_chars(), split })
    }

    /// One word's pieces, merged pair by pair, lowest rank first.
    fn bpe(&self, word: &str) -> Vec<String> {
        let chars: Vec<char> = word.chars().collect();
        let mut parts: Vec<String> = chars.iter().map(|c| c.to_string()).collect();
        if let Some(last) = parts.last_mut() {
            last.push_str("</w>");
        }
        while parts.len() > 1 {
            let best = (0..parts.len() - 1)
                .filter_map(|i| self.ranks.get(&(parts[i].clone(), parts[i + 1].clone())).map(|&r| (r, i)))
                .min();
            let Some((_, i)) = best else { break };
            let (a, b) = (parts[i].clone(), parts[i + 1].clone());
            let mut merged = Vec::with_capacity(parts.len());
            let mut j = 0;
            while j < parts.len() {
                if j + 1 < parts.len() && parts[j] == a && parts[j + 1] == b {
                    merged.push(format!("{a}{b}"));
                    j += 2;
                } else {
                    merged.push(std::mem::take(&mut parts[j]));
                    j += 1;
                }
            }
            parts = merged;
        }
        parts
    }

    /// Token ids with the start and end markers, cut to the model's 77.
    pub fn encode(&self, text: &str) -> Vec<i64> {
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        let mut ids = vec![START];
        for piece in self.split.find_iter(&text) {
            let word: String = piece.as_str().bytes().map(|b| self.bytes[b as usize]).collect();
            // Every single byte character is in the vocabulary, so nothing is ever unknown.
            ids.extend(self.bpe(&word).iter().filter_map(|p| self.vocab.get(p).copied()));
        }
        ids.truncate(MAX_TOKENS - 1);
        ids.push(END);
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny vocabulary in the real file's shape.
    fn tiny() -> Tokenizer {
        let json = serde_json::json!({ "model": {
            "vocab": { "a</w>": 320, "d": 67, "o": 78, "g": 70, "g</w>": 326, "do": 1000, "dog</w>": 1929, "o</w>": 334, "do</w>": 2000 },
            "merges": ["d o", ["do", "g</w>"]],
        }});
        Tokenizer::from_json(&serde_json::to_vec(&json).unwrap()).unwrap()
    }

    #[test]
    fn merges_and_markers() {
        let t = tiny();
        assert_eq!(t.encode("A  DOG"), vec![START, 320, 1929, END]);
        // "d o" merges inside a word only: at a word's end the piece is "o</w>".
        assert_eq!(t.encode("do"), vec![START, 67, 334, END]);
        let long = "a ".repeat(200);
        let ids = t.encode(&long);
        assert_eq!(ids.len(), 77);
        assert_eq!(*ids.last().unwrap(), END);
        // The byte table maps printable ASCII to itself and the rest above 255.
        let b = byte_chars();
        assert_eq!(b[b'a' as usize], 'a');
        assert_eq!(b[b' ' as usize], 'Ġ');
    }
}
