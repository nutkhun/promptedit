//! Whisper's tokens to Editroom's words: each word with its time, punctuation kept on the word
//! before it (`"guys,"`), because caption layout breaks after `, . ? !` (spec 02-engine §9.3, §18).
//!
//! Pure functions, so the rules can be tested without a model.

use crate::mcp::providers::Word;

/// One text token whisper decoded (special and timestamp tokens already left out), with its time
/// in the file in seconds. `bytes` can be part of a UTF-8 character: whisper's byte-level tokens
/// split characters outside ASCII across tokens.
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub bytes: Vec<u8>,
    pub start: f64,
    pub end: f64,
}

#[cfg(test)]
impl Piece {
    pub fn new(text: &str, start: f64, end: f64) -> Self {
        Piece { bytes: text.as_bytes().to_vec(), start, end }
    }
}

/// Times from DTW alignment (whisper.cpp's `t_dtw`), which are much closer to the sound than
/// token timestamps: each token's DTW time is where it ends. So a piece runs from the end of the
/// last piece with something said in it (`from` for the first) to its own DTW time; punctuation,
/// whose DTW time takes in any pause after it, ends where the word before it ended. Returns where
/// the last word ended, for the next segment.
pub fn spans_from_dtw(pieces: &mut [Piece], anchors: &[f64], mut from: f64) -> f64 {
    for (p, &at) in pieces.iter_mut().zip(anchors) {
        let said = String::from_utf8_lossy(&p.bytes).chars().any(char::is_alphanumeric);
        p.start = from;
        if said {
            p.end = at.max(from);
            from = p.end;
        } else {
            p.end = from;
        }
    }
    from
}

/// Languages written without spaces between words: each token is taken as a word there, since
/// whisper's leading space (how words are found otherwise) never comes.
pub fn is_unspaced(language: &str) -> bool {
    matches!(language, "zh" | "ja" | "th" | "lo" | "km" | "my" | "yue" | "bo")
}

/// Words from one segment's tokens. A token that starts with a space starts a new word; the rest
/// (word pieces, punctuation) join the word they follow.
pub fn words_from_pieces(pieces: &[Piece], unspaced: bool) -> Vec<Word> {
    let mut out: Vec<(Vec<u8>, f64, f64)> = vec![];
    for p in pieces {
        if p.bytes.is_empty() {
            continue;
        }
        let starts_word = match out.last() {
            None => true,
            // A character split across tokens is finished before a new word starts.
            Some((b, _, _)) if std::str::from_utf8(b).is_err() => false,
            Some(_) if unspaced => true,
            Some(_) => p.bytes[0] == b' ',
        };
        if starts_word {
            out.push((p.bytes.clone(), p.start, p.end));
        } else if let Some(last) = out.last_mut() {
            last.0.extend_from_slice(&p.bytes);
            last.2 = last.2.max(p.end);
        }
    }
    let words = out
        .into_iter()
        .map(|(b, start, end)| Word { start, end, text: String::from_utf8_lossy(&b).trim().to_string() })
        .filter(|w| !w.text.is_empty())
        .collect();
    attach_punctuation(words)
}

/// Whether a word is only punctuation or symbols ("," "…" "-" "?"), with nothing to say.
fn is_punctuation(text: &str) -> bool {
    !text.chars().any(char::is_alphanumeric)
}

/// Opening marks that belong to the word after them.
fn is_opening(text: &str) -> bool {
    text.chars().all(|c| matches!(c, '"' | '\'' | '(' | '[' | '{' | '¿' | '¡' | '«' | '“' | '‘' | '„' | '「' | '『'))
}

/// Punctuation on its own goes onto the word before it (or, for opening marks and at the very
/// start, the word after it), so every word has something said in it.
pub fn attach_punctuation(words: Vec<Word>) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::with_capacity(words.len());
    let mut pending: Option<Word> = None; // opening marks waiting for their word
    for mut w in words {
        if is_punctuation(&w.text) {
            if is_opening(&w.text) || out.is_empty() {
                pending = Some(match pending.take() {
                    Some(mut p) => {
                        p.text.push_str(&w.text);
                        p
                    }
                    None => w,
                });
            } else if let Some(last) = out.last_mut() {
                last.text.push_str(&w.text);
                last.end = last.end.max(w.end);
            }
            continue;
        }
        if let Some(p) = pending.take() {
            w.text = p.text + &w.text;
            w.start = w.start.min(p.start);
        }
        out.push(w);
    }
    // Opening marks left over at the end had no word after them: nothing was said there.
    out
}

/// Whether a segment is whisper describing the sound rather than words said: "[BLANK_AUDIO]",
/// "(upbeat music)", "♪", "*laughs*".
pub fn is_annotation(segment_text: &str) -> bool {
    let t = segment_text.trim();
    if t.is_empty() {
        return true;
    }
    let wrapped = |open: char, close: char| t.starts_with(open) && t.ends_with(close);
    wrapped('[', ']') || wrapped('(', ')') || wrapped('*', '*') || t.chars().all(|c| c == '♪' || c == '♫' || c.is_whitespace())
}

/// Keeps the words in time order with sensible spans: sorted by start, none ending before it
/// starts or after the next one starts.
pub fn tidy(mut words: Vec<Word>) -> Vec<Word> {
    // Milliseconds are as fine as whisper hears (its steps are 10-20 ms), and keep the cache free
    // of float noise like 3.5500000000000003.
    let ms = |t: f64| (t * 1000.0).round() / 1000.0;
    for w in words.iter_mut() {
        w.start = ms(w.start.max(0.0));
        w.end = ms(w.end).max(w.start);
    }
    words.sort_by(|a, b| a.start.total_cmp(&b.start));
    // Every word gets some time: whisper sometimes gives one no length at all (start == end), and
    // caption layout (like Editroom's) leaves out words that take no time. Starts are kept at
    // least 10 ms apart so there is always room.
    const MIN_GAP: f64 = 0.01;
    const MIN_WORD: f64 = 0.08;
    for i in 1..words.len() {
        let floor = ms(words[i - 1].start + MIN_GAP);
        if words[i].start < floor {
            words[i].start = floor;
            words[i].end = words[i].end.max(floor);
        }
    }
    for i in 0..words.len() {
        let next = words.get(i + 1).map(|n| n.start);
        let w = &mut words[i];
        if w.end - w.start < MIN_WORD {
            let want = w.start + MIN_WORD;
            w.end = ms(next.map_or(want, |n| want.min(n)));
        }
    }
    // A word ends by the time the next one starts (the highlight moves on).
    for i in 1..words.len() {
        let next = words[i].start;
        let w = &mut words[i - 1];
        if w.end > next {
            w.end = next.max(w.start);
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_takes_some_time() {
        let word = |t: &str, a: f64, b: f64| Word { start: a, end: b, text: t.into() };
        let w = tidy(vec![word("to", 5.5, 5.98), word("cake.", 5.98, 5.98), word("First", 5.98, 6.4)]);
        for x in &w {
            assert!(x.end > x.start, "{} has no length: {}..{}", x.text, x.start, x.end);
        }
        assert!(w.windows(2).all(|p| p[0].end <= p[1].start && p[0].start < p[1].start));
        // The last word of a file gets a minimum length too.
        let w = tidy(vec![word("end.", 9.0, 9.0)]);
        assert!((w[0].end - 9.08).abs() < 1e-9);
    }

    fn texts(w: &[Word]) -> Vec<&str> {
        w.iter().map(|w| w.text.as_str()).collect()
    }

    #[test]
    fn joins_pieces_and_keeps_punctuation_on_the_word_before() {
        let p = vec![
            Piece::new(" Hello", 0.0, 0.4),
            Piece::new(",", 0.4, 0.45),
            Piece::new(" wor", 0.5, 0.7),
            Piece::new("ld", 0.7, 0.9),
            Piece::new(".", 0.9, 0.95),
            Piece::new(" How", 1.2, 1.4),
            Piece::new(" are", 1.4, 1.5),
            Piece::new(" you", 1.5, 1.7),
            Piece::new("?", 1.7, 1.75),
        ];
        let w = words_from_pieces(&p, false);
        assert_eq!(texts(&w), ["Hello,", "world.", "How", "are", "you?"]);
        assert_eq!((w[1].start, w[1].end), (0.5, 0.95));
        assert_eq!(w[0].end, 0.45);
    }

    #[test]
    fn spaced_punctuation_and_opening_marks() {
        // Whisper sometimes puts a space before a dash or ellipsis, or a quote before a word.
        let p = vec![
            Piece::new(" Wait", 0.0, 0.3),
            Piece::new(" -", 0.3, 0.35),
            Piece::new(" \"", 0.4, 0.4),
            Piece::new("what", 0.4, 0.6),
            Piece::new("\"", 0.6, 0.6),
            Piece::new(" ...", 0.7, 0.8),
        ];
        assert_eq!(texts(&words_from_pieces(&p, false)), ["Wait-", "\"what\"..."]);
        // Punctuation first in a segment goes onto the first word.
        let p = vec![Piece::new(" ¿", 0.0, 0.1), Piece::new(" Qué", 0.1, 0.3), Piece::new("?", 0.3, 0.3)];
        let w = words_from_pieces(&p, false);
        assert_eq!(texts(&w), ["¿Qué?"]);
        assert_eq!(w[0].start, 0.0);
        // Nothing but punctuation: no words.
        assert!(words_from_pieces(&[Piece::new(" .", 0.0, 0.1)], false).is_empty());
    }

    #[test]
    fn characters_split_across_tokens() {
        // "é" is two bytes; whisper can put them in separate tokens.
        let e = "é".as_bytes();
        let p = vec![
            Piece { bytes: [b" caf".as_slice(), &e[..1]].concat(), start: 0.0, end: 0.3 },
            Piece { bytes: e[1..].to_vec(), start: 0.3, end: 0.4 },
            Piece::new(" noir", 0.5, 0.8),
        ];
        assert_eq!(texts(&words_from_pieces(&p, false)), ["café", "noir"]);
        // Unspaced languages: each token a word, but never half a character.
        let ni = "你".as_bytes();
        let p = vec![
            Piece { bytes: ni[..2].to_vec(), start: 0.0, end: 0.1 },
            Piece { bytes: ni[2..].to_vec(), start: 0.1, end: 0.2 },
            Piece::new("好", 0.2, 0.4),
            Piece::new("。", 0.4, 0.45),
        ];
        assert_eq!(texts(&words_from_pieces(&p, true)), ["你", "好。"]);
    }

    #[test]
    fn dtw_times() {
        // DTW times are where each token ends; punctuation takes in the pause after it.
        let mut p = vec![
            Piece::new(" Hello", 0.0, 0.0),
            Piece::new(" world", 0.0, 0.0),
            Piece::new(",", 0.0, 0.0),
            Piece::new(" cap", 0.0, 0.0),
            Piece::new("tion", 0.0, 0.0),
        ];
        let end = spans_from_dtw(&mut p, &[1.28, 1.9, 2.16, 2.6, 3.0], 0.5);
        assert_eq!(end, 3.0);
        let w = words_from_pieces(&p, false);
        assert_eq!(texts(&w), ["Hello", "world,", "caption"]);
        let spans: Vec<(f64, f64)> = w.iter().map(|w| (w.start, w.end)).collect();
        assert_eq!(spans, [(0.5, 1.28), (1.28, 1.9), (1.9, 3.0)]);
    }

    #[test]
    fn annotations_and_order() {
        assert!(is_annotation(" [BLANK_AUDIO]"));
        assert!(is_annotation("(upbeat music)"));
        assert!(is_annotation(" ♪ ♪"));
        assert!(!is_annotation(" Hello (there)."));
        let w = tidy(vec![
            Word { start: 1.0, end: 0.9, text: "b".into() },
            Word { start: -0.1, end: 1.2, text: "a".into() },
        ]);
        assert_eq!(texts(&w), ["a", "b"]);
        // "b" had no length (1.0..1.0 after clamping): it gets the minimum, 80 ms.
        assert_eq!((w[0].start, w[0].end, w[1].end), (0.0, 1.0, 1.08));
        let w = tidy(vec![Word { start: 3.06, end: 3.06 + 0.49, text: "test.".into() }]);
        assert_eq!((w[0].start, w[0].end), (3.06, 3.55));
    }
}
