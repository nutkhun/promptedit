//! From a frame's picture embedding to tags with confidences, and from frames to a file's tags
//! (Editroom's `classify` and `gather`, spec 02-engine §17), with CLIP in place of Vision.
//!
//! Vision gives each label its own confidence. CLIP gives a similarity between the picture and a
//! sentence ("a photo of a beach"), which isn't a confidence, and is close to the same for every
//! label (0.15–0.32). So each label's similarity is compared with the frame's others (a z-score
//! over the whole label list: what stands out in this picture) and put through a sigmoid fitted on
//! CC0 photos (see `calibrate.py`), which brings it to Vision's scale, where Editroom keeps labels
//! at 0.2 per frame and 0.35 for the file.
//!
//! Broad labels ("people", "animal", "sky", "night") never stand out that way: in a photo of a dog
//! "dog" beats "animal". Those are categories, each scored by how much more like the picture its
//! sentences are than neutral ones ("a photo", "a picture"), against an offset tuned per category.

use crate::mcp::providers::{SceneTags, Tag};
use serde::Deserialize;
use std::collections::HashMap;

/// Kept per frame (Editroom's Vision floor).
pub const SEEN: f64 = 0.2;
/// Kept for the file, and where it shows (Editroom's `sure`).
pub const SURE: f64 = 0.35;

/// `labels.json`: the label list and how its scores are calibrated.
#[derive(Clone, Debug, Deserialize)]
pub struct Labels {
    /// The sentence for a label: `{}` is the label with `_` as spaces.
    pub prompt: String,
    pub neutral: Vec<String>,
    pub zscore: ZScore,
    pub contrast: Contrast,
    /// Broad labels, scored against `neutral`.
    pub categories: HashMap<String, Category>,
    /// Vision-style identifiers (`water_body`, `sunset_sunrise`).
    pub labels: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct ZScore {
    pub slope: f64,
    pub intercept: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Contrast {
    /// Similarity difference that moves the confidence by one logit.
    pub scale: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub prompts: Vec<String>,
    /// The contrast where the confidence is exactly `SURE`.
    pub offset: f64,
    /// Not in a frame where one category is surer than another: CLIP finds people in close-ups of
    /// dogs, so person categories go when "animal" is surer than "people".
    #[serde(default)]
    pub not_if: Option<NotIf>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct NotIf {
    pub more: String,
    pub than: String,
}

impl Labels {
    pub fn builtin() -> Labels {
        serde_json::from_str(include_str!("labels.json")).expect("labels.json is valid")
    }

    /// Category names in a fixed order (the JSON map's order isn't kept).
    pub fn category_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.categories.keys().cloned().collect();
        names.sort();
        names
    }

    /// Every sentence the text model embeds, in the order `Scorer` expects: one per label, the
    /// neutral ones, then each category's (in `category_names` order).
    pub fn sentences(&self) -> Vec<String> {
        let mut out: Vec<String> = self.labels.iter().map(|l| self.prompt.replace("{}", &display(l))).collect();
        out.extend(self.neutral.iter().cloned());
        for c in self.category_names() {
            out.extend(self.categories[&c].prompts.iter().cloned());
        }
        out
    }
}

/// A Vision identifier as a tag name: `_` → space (as Editroom shows them).
pub fn display(label: &str) -> String {
    label.replace('_', " ")
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn dot(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (*x as f64) * (*y as f64)).sum()
}

/// Scores frames against label sentences embedded once.
pub struct Scorer {
    labels: Labels,
    names: Vec<String>,
    categories: Vec<(String, Category)>,
    /// Unit-length sentence embeddings in `Labels::sentences` order.
    text: Vec<Vec<f32>>,
}

impl Scorer {
    /// `text`: the sentence embeddings (normalised here).
    pub fn new(labels: Labels, text: Vec<Vec<f32>>) -> Result<Scorer, String> {
        if text.len() != labels.sentences().len() {
            return Err(format!("Expected {} label embeddings, got {}.", labels.sentences().len(), text.len()));
        }
        let names = labels.labels.iter().map(|l| display(l)).collect();
        let categories = labels.category_names().into_iter().map(|c| (c.clone(), labels.categories[&c].clone())).collect();
        Ok(Scorer { labels, names, categories, text: text.into_iter().map(normalized).collect() })
    }

    /// Labels in a frame at `SEEN` or more, with their confidences (0…1).
    pub fn classify(&self, image: &[f32]) -> Vec<(String, f64)> {
        let image = normalized(image.to_vec());
        let sims: Vec<f64> = self.text.iter().map(|t| dot(t, &image)).collect();
        let n = self.names.len();
        let mut out = vec![];

        // Specific labels: how far each stands out from the frame's other labels.
        let own = &sims[..n];
        let mean = own.iter().sum::<f64>() / n as f64;
        let sd = (own.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / n as f64).sqrt().max(1e-9);
        let z = self.labels.zscore;
        for (name, s) in self.names.iter().zip(own) {
            let c = sigmoid(z.slope * (s - mean) / sd + z.intercept);
            if c >= SEEN {
                out.push((name.clone(), c));
            }
        }

        // Categories: their best sentence against the neutral ones.
        let neutral = &sims[n..n + self.labels.neutral.len()];
        let base = neutral.iter().sum::<f64>() / neutral.len().max(1) as f64;
        let at_sure = (SURE / (1.0 - SURE)).ln();
        // Each category's margin: how far its best sentence is past its offset.
        let mut at = n + neutral.len();
        let mut margins: HashMap<&str, f64> = HashMap::new();
        for (name, cat) in &self.categories {
            let best = sims[at..at + cat.prompts.len()].iter().cloned().fold(f64::MIN, f64::max);
            at += cat.prompts.len();
            margins.insert(name, best - base - cat.offset);
        }
        for (name, cat) in &self.categories {
            if let Some(rule) = &cat.not_if
                && margins.get(rule.more.as_str()).zip(margins.get(rule.than.as_str())).is_some_and(|(m, t)| m > t)
            {
                continue;
            }
            let c = sigmoid(margins[name.as_str()] / self.labels.contrast.scale + at_sure);
            if c >= SEEN {
                out.push((display(name), c));
            }
        }
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out
    }
}

fn normalized(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// A file's tags from its frames (time, labels): per label the surest frame's confidence, the
/// times it's at least `SURE`, kept if it's `SURE` somewhere; surest first (Editroom's `gather`).
pub fn gather(seen: &[(f64, Vec<(String, f64)>)]) -> SceneTags {
    let mut best: Vec<(String, f64, Vec<f64>)> = vec![];
    for (t, labels) in seen {
        for (name, c) in labels {
            let i = match best.iter().position(|b| &b.0 == name) {
                Some(i) => i,
                None => {
                    best.push((name.clone(), 0.0, vec![]));
                    best.len() - 1
                }
            };
            best[i].1 = best[i].1.max(*c);
            if *c >= SURE {
                best[i].2.push(round2(*t));
            }
        }
    }
    let mut tags: Vec<Tag> =
        best.into_iter().filter(|b| b.1 >= SURE).map(|(name, c, times)| Tag { name, confidence: round2(c), times }).collect();
    // Stable, so equally sure tags keep the order they were first seen in.
    tags.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    SceneTags { tags }
}

/// Editroom's frame times for a video: `n = min(20, max(8, round(duration)))` evenly spread
/// mid-interval. A photo is one frame at 0.
pub fn frame_times(duration: f64) -> Vec<f64> {
    let n = (duration.round() as i64).clamp(8, 20) as usize;
    (0..n).map(|i| duration * (i as f64 + 0.5) / n as f64).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_times_follow_editroom() {
        assert_eq!(frame_times(3.0).len(), 8);
        assert_eq!(frame_times(12.4).len(), 12);
        assert_eq!(frame_times(600.0).len(), 20);
        let t = frame_times(8.0);
        assert_eq!(t[0], 0.5);
        assert_eq!(t[7], 7.5);
    }

    #[test]
    fn gather_keeps_sure_labels_with_their_times() {
        let seen = vec![
            (0.504, vec![("beach".to_string(), 0.5), ("dog".to_string(), 0.3)]),
            (1.5, vec![("beach".to_string(), 0.812), ("sky".to_string(), 0.34)]),
            (2.5, vec![("dog".to_string(), 0.36)]),
        ];
        let t = gather(&seen);
        let got: Vec<(&str, f64, Vec<f64>)> = t.tags.iter().map(|t| (t.name.as_str(), t.confidence, t.times.clone())).collect();
        // Sky never reaches 0.35: dropped. Dog does once: kept with that one time.
        assert_eq!(got, vec![("beach", 0.81, vec![0.5, 1.5]), ("dog", 0.36, vec![2.5])]);
        // Editroom's cache shape.
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["tags"][0], serde_json::json!({"name": "beach", "confidence": 0.81, "times": [0.5, 1.5]}));
        assert!(gather(&[]).tags.is_empty());
    }

    /// A made-up label space: embeddings are directions, so the frame's picture can be put exactly
    /// where a label or category is.
    fn scorer() -> Scorer {
        let labels: Labels = serde_json::from_value(serde_json::json!({
            "prompt": "a photo of {}",
            "neutral": ["a photo"],
            "zscore": {"slope": 1.156, "intercept": -4.706},
            "contrast": {"scale": 0.004},
            "categories": {"animal": {"prompts": ["a photo of an animal"], "offset": 0.002}},
            "labels": (0..40).map(|i| format!("thing_{i}")).collect::<Vec<_>>(),
        }))
        .unwrap();
        assert_eq!(labels.sentences()[0], "a photo of thing 0");
        assert_eq!(labels.sentences().len(), 42);
        let dim = 64;
        let mut text = vec![];
        for i in 0..42 {
            let mut v = vec![0.01f32; dim];
            v[i] = 1.0;
            text.push(v);
        }
        Scorer::new(labels, text).unwrap()
    }

    #[test]
    fn a_label_that_stands_out_is_kept_and_others_are_not() {
        let s = scorer();
        let mut img = vec![0.0f32; 64];
        img[3] = 1.0; // exactly thing 3
        let got = s.classify(&img);
        assert_eq!(got[0].0, "thing 3");
        // With 40 labels the most a label can stand out is z = √39 ≈ 6.2.
        assert!(got[0].1 > 0.9, "{got:?}");
        assert!(got.iter().filter(|(n, _)| n.starts_with("thing")).all(|(n, _)| n == "thing 3"), "nothing else stands out: {got:?}");
        // A picture no more like the category than like a neutral photo isn't kept for the file.
        assert!(got.iter().all(|(n, c)| n != "animal" || *c < SURE), "{got:?}");
        // Every confidence is a probability and at least the per-frame floor.
        assert!(got.iter().all(|(_, c)| (SEEN..=1.0).contains(c)));
    }

    #[test]
    fn categories_score_against_the_neutral_sentences() {
        let s = scorer();
        // Halfway between the category and neutral: well above the neutral sentence.
        let mut img = vec![0.0f32; 64];
        img[41] = 1.0;
        img[40] = 0.3;
        let got = s.classify(&img);
        assert!(got.iter().any(|(n, c)| n == "animal" && *c > 0.9), "{got:?}");
        // Just like the neutral sentence: no animal.
        let mut img = vec![0.0f32; 64];
        img[40] = 1.0;
        assert!(!s.classify(&img).iter().any(|(n, _)| n == "animal"));
        // A person category goes in a frame where "animal" is surer than "people".
        let labels: Labels = serde_json::from_value(serde_json::json!({
            "prompt": "a photo of {}", "neutral": ["a photo"],
            "zscore": {"slope": 1.156, "intercept": -4.706}, "contrast": {"scale": 0.004},
            "categories": {
                "animal": {"prompts": ["an animal"], "offset": 0.0},
                "people": {"prompts": ["people"], "offset": 0.0, "notIf": {"more": "animal", "than": "people"}},
            },
            "labels": ["a", "b", "c"],
        }))
        .unwrap();
        // Sentences: a, b, c, neutral, animal, people.
        let text: Vec<Vec<f32>> = (0..6).map(|i| (0..8).map(|j| if i == j { 1.0 } else { 0.0 }).collect()).collect();
        let s2 = Scorer::new(labels, text).unwrap();
        let both = |animal: f32, people: f32| s2.classify(&[0.0, 0.0, 0.0, 0.0, animal, people, 0.0, 0.0]);
        let names = |v: Vec<(String, f64)>| {
            let mut n: Vec<String> = v.into_iter().map(|x| x.0).collect();
            n.sort();
            n
        };
        assert_eq!(names(both(1.0, 0.5)), ["animal"]);
        assert_eq!(names(both(0.5, 1.0)), ["animal", "people"]);
        // A wrong count of embeddings is refused.
        assert!(Scorer::new(Labels::builtin(), vec![vec![1.0]]).is_err());
    }

    #[test]
    fn builtin_labels_cover_the_alias_table() {
        let l = Labels::builtin();
        let mut names: Vec<String> = l.labels.iter().map(|x| display(x)).collect();
        names.extend(l.categories.keys().map(|c| display(c)));
        for key in super::super::words::aliases().keys() {
            assert!(names.contains(key), "{key} isn't a label");
        }
        assert!(l.labels.len() > 800);
        assert!(l.categories.contains_key("people") && l.categories.contains_key("night"));
        // No label is both a category and a specific label.
        assert!(l.labels.iter().all(|x| !l.categories.contains_key(x)));
    }
}
