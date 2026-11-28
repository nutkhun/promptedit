//! Searching scene tags by word, as Editroom's `SceneTags.shows` / `matching` do (spec 02-engine
//! §17): a word matches a tag's own words, the everyday words for it (the alias table, copied
//! verbatim from Editroom into `aliases.json`), singulars, the same stem ("laughing" for
//! "laughter"), and while typing, the start of a word ("po" for "pool").
//!
//! The UI does the same matching in TypeScript (src/scenes.ts) with the alias table it gets from
//! the `scene_aliases` command, so this file and that one stay in step.

use crate::mcp::providers::{SceneTags, Tag};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Everyday words for labels ("portal" is a door), by tag name.
pub fn aliases() -> &'static HashMap<String, Vec<String>> {
    static ALIASES: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();
    ALIASES.get_or_init(|| serde_json::from_str(include_str!("aliases.json")).expect("aliases.json is valid"))
}

/// "pools" → "pool", but not "glass" or short words ("bus").
pub fn singular(w: &str) -> String {
    if w.chars().count() > 3 && w.ends_with('s') && !w.ends_with("ss") { w[..w.len() - 1].to_string() } else { w.to_string() }
}

/// The same word in another form ("laughing" and "laughter", "smile" and "smiling"), for longer words.
pub fn same_stem(a: &str, b: &str) -> bool {
    fn stem(w: &str) -> String {
        let mut w = w.to_string();
        let n = w.chars().count();
        for end in ["ing", "ter", "ers", "er", "ed", "es", "s"] {
            if n > end.len() + 3 && w.ends_with(end) {
                w.truncate(w.len() - end.len());
                break;
            }
        }
        if w.ends_with('e') && w.chars().count() > 4 {
            w.pop();
        }
        w
    }
    a.chars().count() >= 5 && b.chars().count() >= 5 && stem(a) == stem(b)
}

/// A tag's words: its name split on spaces, then its aliases.
fn words_of(tag: &str) -> impl Iterator<Item = &str> {
    tag.split(' ').chain(aliases().get(tag).into_iter().flatten().map(String::as_str))
}

fn word_matches(p: &str, w: &str, typing: bool) -> bool {
    p == w || singular(p) == w || (typing && p.starts_with(w)) || same_stem(p, w)
}

/// The word as it's compared: lower-cased and singular; `None` when too short to mean anything.
fn query(word: &str) -> Option<String> {
    let w = singular(&word.to_lowercase());
    (w.chars().count() >= 2).then_some(w)
}

/// Whether one of the tags is this word, or starts with it while it's being typed.
pub fn shows(tags: &SceneTags, word: &str, typing: bool) -> bool {
    let Some(w) = query(word) else { return false };
    tags.tags.iter().any(|t| words_of(&t.name).any(|p| word_matches(p, &w, typing)))
}

/// The tags that match a word (as `shows` does, not typing), for saying where in the file it shows.
pub fn matching<'a>(tags: &'a SceneTags, word: &str) -> Vec<&'a Tag> {
    let Some(w) = query(word) else { return vec![] };
    tags.tags.iter().filter(|t| words_of(&t.name).any(|p| word_matches(p, &w, false))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(names: &[&str]) -> SceneTags {
        SceneTags { tags: names.iter().map(|n| Tag { name: n.to_string(), confidence: 0.9, times: vec![1.0] }).collect() }
    }

    /// Editroom's own self-test cases (`SelfTest.swift`, "SEARCH WORDS" and the library search).
    #[test]
    fn matches_like_editroom() {
        assert!(aliases().len() > 100);
        assert!(shows(&tags(&["rollercoaster"]), "ride", false));
        assert!(shows(&tags(&["amusement park"]), "rides", false));
        assert!(shows(&tags(&["carousel"]), "ride", false));
        assert!(shows(&tags(&["celebration"]), "party", false));
        assert!(shows(&tags(&["cityscape"]), "city", false));
        assert!(shows(&tags(&["surfing"]), "waves", false));
        assert!(shows(&tags(&["dog"]), "puppy", false));
        assert!(!shows(&tags(&["dog"]), "ride", false));
        assert!(!shows(&tags(&["rollercoaster"]), "laughing", false));
        for t in ["car", "airplane", "bus", "helicopter"] {
            assert!(shows(&tags(&[t]), "vehicle", false), "{t}");
        }
        assert!(shows(&tags(&["boat"]), "vehicles", false));
        assert!(shows(&tags(&["laughter"]), "laughing", false));
        assert!(shows(&tags(&["smile"]), "smiling", false));
        assert!(shows(&tags(&["smiles"]), "happy", false));
        assert!(!shows(&tags(&["parking"]), "park", false));

        let pool = SceneTags {
            tags: vec![
                Tag { name: "swimming pool".into(), confidence: 0.8, times: vec![1.0] },
                Tag { name: "chair".into(), confidence: 0.6, times: vec![2.0] },
            ],
        };
        assert!(shows(&pool, "pool", false) && shows(&pool, "chairs", false));
        assert!(shows(&pool, "po", true) && !shows(&pool, "po", false));
        assert!(!shows(&pool, "beach", false));
        assert!(shows(&tags(&["portal"]), "door", false));
        assert!(shows(&tags(&["adult"]), "wom", true));
        // Night and laughing, as people search for them.
        assert!(shows(&tags(&["night sky"]), "night", false));
        assert!(shows(&tags(&["night"]), "Night", false));
        assert!(!shows(&tags(&["dog"]), "d", true), "one letter matches nothing");
    }

    #[test]
    fn matching_lists_the_tags_that_match() {
        let t = tags(&["swimming pool", "people", "water body"]);
        let names: Vec<&str> = matching(&t, "water").iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["water body"]);
        assert_eq!(matching(&t, "woman").len(), 1);
        assert!(matching(&t, "wat").is_empty(), "no prefix matching outside typing");
        assert!(same_stem("laughing", "laughter") && !same_stem("park", "parking"));
        assert_eq!(singular("glass"), "glass");
        assert_eq!(singular("dogs"), "dog");
        assert_eq!(singular("bus"), "bus");
    }
}
