//! The MCP tools reading scene tags (no model needed), and end to end: download the picture model,
//! then tag three CC0 photos (a dog, a beach, a city at
//! night, from PxHere via the `nyuuzyou/pxhere` dataset on Hugging Face) and a video made from
//! two of them, and print the top tags.
//!
//! Needs the network (once: the model is kept in `PROMPTEDIT_TEST_MODELS`, default
//! `<temp>/promptedit-test-models`, as the speech tests do), so it's ignored by default:
//!
//!   cargo test -p promptedit --lib scenes::tests -- --ignored --nocapture
//!
//! (The MCP test isn't ignored: it puts tags in the cache by hand.)

use super::cache;
use super::model;
use super::service::{Dirs, SceneState, Service};
use super::tokenizer::Tokenizer;
use crate::mcp::providers::SceneTags;
use promptedit_core::MediaAsset;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn models_dir() -> PathBuf {
    std::env::var_os("PROMPTEDIT_TEST_MODELS").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("promptedit-test-models"))
}

/// One dataset revision, so the bytes at these offsets never change.
const PXHERE: &str = "https://huggingface.co/datasets/nyuuzyou/pxhere/resolve/9a0820f476ea1ba00f6053e63bc81f24c5eb605f";

/// (name, shard, offset of the JPEG inside the tar, its size, words its tags should include)
const PHOTOS: [(&str, &str, u64, u64, &[&str]); 3] = [
    ("dog", "pxhere-000500.tar", 83_411_456, 1_592_977, &["dog", "puppy", "animal"]),
    ("beach", "pxhere-000400.tar", 1_536, 2_506_328, &["beach", "sea", "ocean", "water"]),
    ("night", "pxhere-000500.tar", 12_534_784, 3_706_175, &["night"]),
];

/// A photo, read out of its shard with a range request.
fn photo(dir: &Path, name: &str, shard: &str, offset: u64, size: u64) -> PathBuf {
    let file = dir.join(format!("{name}.jpg"));
    if std::fs::metadata(&file).is_ok_and(|m| m.len() == size) {
        return file;
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let bytes = rt.block_on(async {
        let resp = reqwest::Client::new()
            .get(format!("{PXHERE}/{shard}"))
            .header("Range", format!("bytes={offset}-{}", offset + size - 1))
            .send()
            .await
            .expect("reached huggingface.co");
        assert!(resp.status().is_success(), "{}", resp.status());
        resp.bytes().await.unwrap()
    });
    assert_eq!(bytes.len() as u64, size);
    assert_eq!(&bytes[..2], &[0xff, 0xd8], "{name} is a JPEG");
    std::fs::write(&file, &bytes).unwrap();
    file
}

fn asset(path: &Path, kind: &str, duration: f64) -> MediaAsset {
    serde_json::from_value(serde_json::json!({
        "id": promptedit_core::Id::new(), "path": path, "name": path.file_stem().unwrap().to_string_lossy(), "kind": kind,
        "duration": duration, "width": 1024, "height": 683, "fps": 25.0, "hasAudio": false
    }))
    .unwrap()
}

/// Queues it and waits for its tags.
fn tags_of(s: &Service, a: &MediaAsset) -> SceneTags {
    assert!(matches!(s.queue(a, Duration::ZERO, false), SceneState::Queued | SceneState::Working { .. }));
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match s.state(a) {
            SceneState::Ready { .. } => return s.cached(a).unwrap(),
            SceneState::Failed { message } => panic!("{message}"),
            _ if Instant::now() > deadline => panic!("tagging took too long"),
            _ => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn summary(t: &SceneTags) -> String {
    t.tags.iter().take(10).map(|t| format!("{} {:.2}", t.name, t.confidence)).collect::<Vec<_>>().join(", ")
}

#[test]
#[ignore = "downloads the picture model (156 MB) and three photos"]
fn tags_photos_and_a_video() {
    let models = models_dir();
    let mut last = 0.0;
    model::download(&models, |p| {
        assert!(p >= last, "progress only goes up");
        last = p;
    })
    .expect("downloaded the picture model");
    assert!(model::installed(&models));

    // The real tokenizer gives Hugging Face's ids.
    let tok = Tokenizer::from_json(&std::fs::read(model::path(&models, &model::TOKENIZER)).unwrap()).unwrap();
    assert_eq!(tok.encode("a photo of a dog"), vec![49406, 320, 1125, 539, 320, 1929, 49407]);
    assert_eq!(tok.encode("a photo of sunset sunrise"), vec![49406, 320, 1125, 539, 3424, 5610, 49407]);

    let dir = std::env::temp_dir().join(format!("promptedit-scenes-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let photos_dir = models.join("test-photos");
    std::fs::create_dir_all(&photos_dir).unwrap();
    let s = Service::new(Dirs { models: models.clone(), settings: dir.join("scenes.json"), tags: dir.join("Scenes") });
    s.start();

    let started = Instant::now();
    let mut files = vec![];
    for (name, shard, offset, size, expect) in PHOTOS {
        let file = photo(&photos_dir, name, shard, offset, size);
        let t = tags_of(&s, &asset(&file, "image", 0.0));
        println!("{name}: {}", summary(&t));
        assert!(
            expect.iter().any(|w| super::words::shows(&t, w, false)),
            "{name}: expected one of {expect:?} in {}",
            summary(&t)
        );
        files.push(file);
    }
    println!("(three photos, first one including loading the model and embedding the labels: {:.1?})", started.elapsed());

    // A 10-second video: 5 s of the dog, then 5 s of the beach. Tags carry the times they show.
    let video = dir.join("dog then beach.mp4");
    let ok = crate::media::command("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-t", "5", "-i"])
        .arg(&files[0])
        .args(["-loop", "1", "-t", "5", "-i"])
        .arg(&files[1])
        .args(["-filter_complex", "[0:v]scale=640:360:force_original_aspect_ratio=increase,crop=640:360,setsar=1[a];[1:v]scale=640:360:force_original_aspect_ratio=increase,crop=640:360,setsar=1[b];[a][b]concat=n=2:v=1[v]"])
        .args(["-map", "[v]", "-r", "25", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
        .arg(&video)
        .status()
        .unwrap()
        .success();
    assert!(ok, "ffmpeg made the video");
    let started = Instant::now();
    let t = tags_of(&s, &asset(&video, "video", 10.0));
    println!("video: {} ({:.1?} for 10 frames)", summary(&t), started.elapsed());
    for tag in t.tags.iter().take(6) {
        println!("  {} at {:?}", tag.name, tag.times);
    }
    let dog = super::words::matching(&t, "dog");
    let beach = super::words::matching(&t, "beach");
    assert!(!dog.is_empty() && !beach.is_empty(), "both shots: {}", summary(&t));
    assert!(dog.iter().flat_map(|t| &t.times).all(|&x| x < 5.0), "the dog is in the first half");
    assert!(beach.iter().flat_map(|t| &t.times).all(|&x| x > 5.0), "the beach is in the second half");
    // Saved where the cache says, in Editroom's shape.
    assert!(cache::file_for(&dir.join("Scenes"), &video).is_file());
    std::fs::remove_dir_all(&dir).ok();
}

/// `list_media` says what each clip shows and `search_media` finds it by that, through the provider
/// this module registers (tags put in the cache by hand: no model needed).
#[test]
fn mcp_tools_see_scene_tags() {
    use crate::mcp::host::HeadlessHost;
    use serde_json::json;
    let dir = std::env::temp_dir().join(format!("promptedit-scenes-mcp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // The process's one service (another test may have started it with other folders).
    let s = super::start(Dirs { models: dir.join("Models"), settings: dir.join("scenes.json"), tags: dir.join("Scenes") });
    let host = HeadlessHost::default();
    let mut assets = vec![];
    for (name, tags) in [("IMG_1", json!([["water body", 0.9, [0.5]], ["beach", 0.81, [0.5, 1.5]]])), ("IMG_2", json!([["dog", 0.7, [2.0]]]))] {
        let file = dir.join(format!("{name}.mp4"));
        std::fs::write(&file, name).unwrap();
        let a = asset(&file, "video", 4.0);
        let t: SceneTags = serde_json::from_value(json!({
            "tags": tags.as_array().unwrap().iter().map(|t| json!({"name": t[0], "confidence": t[1], "times": t[2]})).collect::<Vec<_>>()
        }))
        .unwrap();
        cache::save(&cache::file_for(&s.dirs().tags, &file), &t).unwrap();
        assets.push(a);
    }
    host.state.doc.lock().unwrap().project.assets = assets.clone();
    let mut known = s.library_snapshot();
    known.extend(assets.iter().cloned());
    s.remember(&known);

    let text = |v: serde_json::Value| -> serde_json::Value {
        assert_eq!(v["isError"], false, "{v}");
        serde_json::from_str(v["content"][0]["text"].as_str().unwrap()).unwrap()
    };
    let listed = text(crate::mcp::tools::call(&host, "list_media", &json!({}), None, None));
    let items = listed.as_array().or_else(|| listed["media"].as_array()).cloned().unwrap_or_default();
    let shows = |name: &str| items.iter().find(|m| m["name"] == name).map(|m| m["shows"].clone());
    assert_eq!(shows("IMG_1"), Some(json!(["water body", "beach"])), "{listed}");
    assert_eq!(shows("IMG_2"), Some(json!(["dog"])), "{listed}");

    let found = text(crate::mcp::tools::call(&host, "search_media", &json!({"shows": "the beach"}), None, None));
    let hits = found["found"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{found}");
    assert_eq!(hits[0]["name"], "IMG_1");
    assert_eq!(hits[0]["shows"], json!([{"tag": "beach", "times": [0.5, 1.5]}]));
    // Everyday words for tags work too ("puppy" for a dog).
    let found = text(crate::mcp::tools::call(&host, "search_media", &json!({"shows": "puppy"}), None, None));
    assert_eq!(found["found"][0]["name"], "IMG_2", "{found}");
    std::fs::remove_dir_all(&dir).ok();
}
