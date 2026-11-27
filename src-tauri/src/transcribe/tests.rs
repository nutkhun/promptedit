//! End to end: download the Fast model, hear a spoken sentence, check the words and their times.
//!
//! Needs the network (once: the model is kept in `PROMPTEDIT_TEST_MODELS`, default
//! `<temp>/promptedit-test-models`) and `espeak-ng` to speak the sentence, so it's ignored by default:
//!
//!   cargo test -p promptedit --lib transcribe::tests -- --ignored --nocapture

use super::models::{self, ModelId};
use super::service::{Dirs, Service};
use super::state::TranscriptState;
use super::whisper::Engine;
use crate::mcp::providers::Transcript;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn models_dir() -> PathBuf {
    std::env::var_os("PROMPTEDIT_TEST_MODELS").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("promptedit-test-models"))
}

/// The Fast model, downloaded with the app's own downloader if it isn't here yet.
fn fast_model() -> PathBuf {
    let dir = models_dir();
    if let Some(p) = models::installed(&dir, ModelId::Fast) {
        return p;
    }
    let mut last = 0.0;
    let p = models::download(&dir, ModelId::Fast, |p| {
        assert!(p >= last, "progress only goes up");
        last = p;
    })
    .expect("downloaded the Fast model");
    assert_eq!(last, 1.0);
    assert!(std::fs::metadata(&p).unwrap().len() > 140_000_000);
    p
}

/// A second of silence, then "Hello world, this is a caption test." spoken, under a test picture.
fn speech_clip(dir: &Path) -> Option<PathBuf> {
    let wav = dir.join("speech.wav");
    let spoke = std::process::Command::new("espeak-ng")
        .args(["-v", "en-us", "-s", "150", "-w"])
        .arg(&wav)
        .arg("Hello world, this is a caption test.")
        .status();
    if !spoke.is_ok_and(|s| s.success()) {
        eprintln!("espeak-ng isn't installed: skipping");
        return None;
    }
    let clip = dir.join("speech.mp4");
    let ok = crate::media::command("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=5"])
        .args(["-f", "lavfi", "-t", "1", "-i", "anullsrc=r=22050:cl=mono", "-i"])
        .arg(&wav)
        .args(["-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a]", "-map", "0:v", "-map", "[a]"])
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&clip)
        .status()
        .unwrap()
        .success();
    assert!(ok, "ffmpeg made the clip");
    Some(clip)
}

fn check(t: &Transcript) {
    println!("{}", serde_json::to_string_pretty(t).unwrap());
    let said: Vec<String> = t.words.iter().map(|w| w.text.to_lowercase()).collect();
    let tokens = Transcript::tokens(&t.text());
    for w in ["hello", "world", "this", "caption", "test"] {
        assert!(tokens.iter().any(|t| t == w), "heard {w:?} in {said:?}");
    }
    assert_eq!(t.language, "en");
    // Punctuation stays on the word before it.
    assert!(t.words.iter().all(|w| w.text.chars().any(char::is_alphanumeric)), "no bare punctuation: {said:?}");
    assert!(said.iter().any(|w| w == "world,"), "comma on \"world\": {said:?}");
    assert!(said.last().unwrap().ends_with('.'), "full stop on the last word: {said:?}");
    // Speech starts after the second of silence (≈1.02 s) and ends ≈3.55 s; the pause after
    // "world," is ≈1.88–2.06 s.
    let at = |w: &str| t.words.iter().find(|x| x.text.to_lowercase().starts_with(w)).unwrap();
    assert!((0.7..1.5).contains(&at("hello").start), "hello at {}", at("hello").start);
    assert!((1.6..2.4).contains(&at("this").start), "this at {}", at("this").start);
    assert!((2.8..4.2).contains(&t.words.last().unwrap().end), "ends at {}", t.words.last().unwrap().end);
    assert!(t.words.windows(2).all(|p| p[0].start <= p[1].start), "sorted");
    assert!(t.words.iter().all(|w| w.end >= w.start));
}

#[test]
#[ignore = "downloads the speech model and needs espeak-ng"]
fn hears_a_spoken_sentence() {
    let model = fast_model();
    let dir = std::env::temp_dir().join(format!("promptedit-transcribe-it-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let Some(clip) = speech_clip(&dir) else { return };
    let probe = crate::media::probe(&clip).unwrap();
    let asset = crate::media::asset_for(&clip, &probe);

    // Straight through the engine, once whole and once in two-second pieces (the joins between
    // pieces of a long file).
    let engine = Engine::load(&model, ModelId::Fast).unwrap();
    let mut seen = vec![];
    let whole = engine.transcribe(&clip, asset.duration, "auto", &mut |p| seen.push(p), &|| false).unwrap();
    assert!(seen.windows(2).all(|p| p[0] <= p[1]) && *seen.last().unwrap() > 0.99, "progress {seen:?}");
    check(&whole);
    let pieces = engine.transcribe_in_pieces(&clip, asset.duration, "en", &mut |_| {}, &|| false, 2 * super::audio::RATE).unwrap();
    println!("in pieces: {}", pieces.text());
    assert_eq!(Transcript::tokens(&pieces.text()), Transcript::tokens(&whole.text()), "same words in pieces");
    // Cancelling stops it.
    assert_eq!(engine.transcribe(&clip, asset.duration, "auto", &mut |_| {}, &|| true).unwrap_err(), super::whisper::CANCELLED);
    drop(engine);

    // Through the queue, as the app and the MCP tools use it, with the transcript cached.
    let dirs = Dirs { models: models_dir(), settings: dir.join("transcription.json"), transcripts: dir.join("Transcripts") };
    let service = Service::new(dirs.clone());
    service.start();
    service.set_settings(Some("fast"), None).unwrap();
    assert_eq!(service.state(&asset), TranscriptState::None);
    assert!(service.cached(&asset).is_none());
    let t = service.ready(&asset, Duration::from_secs(120)).expect("heard it");
    assert_eq!(service.state(&asset), TranscriptState::Ready { words: t.words.len() });
    assert_eq!(service.cached(&asset), Some(t.clone()));
    assert_eq!(service.queue(&asset, false, true), TranscriptState::Ready { words: t.words.len() }, "heard once");
    let files: Vec<_> = std::fs::read_dir(dir.join("Transcripts")).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(files.len(), 1);
    assert!(files[0].to_string_lossy().starts_with("speech-"));
    check(&t);

    // The MCP tools' way in: the provider `start` registers answers from the same cache. (Skipped if
    // another test in this process started the service with other folders first.)
    let global = super::start(dirs.clone());
    if global.dirs().transcripts == dirs.transcripts {
        assert!(crate::mcp::providers::transcripts_available());
        assert_eq!(crate::mcp::providers::transcript_cached(&asset), Some(t.clone()));
        assert_eq!(crate::mcp::providers::transcript_ready(&asset), Some(t));
    }
    std::fs::remove_dir_all(&dir).ok();
}
