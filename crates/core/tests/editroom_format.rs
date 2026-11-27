//! PromptEdit must open Editroom projects and write files Editroom can open.

use promptedit_core::*;

const SAMPLE: &str = include_str!("fixtures/editroom-sample.json");

#[test]
fn reads_an_editroom_project() {
    let doc = SavedDocument::from_json(SAMPLE.as_bytes()).expect("parses");
    let p = &doc.project;
    assert_eq!(p.video_tracks.len(), 2);
    assert_eq!(p.video_tracks[1].duck_db, -12.0, "missing keys take Editroom's defaults");
    assert_eq!(p.audio_tracks[0].gain_db, -3.0);
    assert_eq!(p.clips.len(), 3);
    let c = &p.clips[0];
    assert_eq!(c.fade_in_curve, Some(FadeCurve::Smooth));
    assert_eq!(c.transform.unwrap().zoom.unwrap().mode, ZoomMode::InOut);
    assert_eq!(c.grade.as_ref().unwrap().look.as_deref(), Some("Warm film"));
    assert_eq!(p.clips[1].transition_in.unwrap().kind, TransitionKind::DipToBlack);
    assert_eq!(p.markers.as_ref().unwrap()[0].tint, MarkerTint::Red);
    let fixes = p.caption_fixes.as_ref().unwrap();
    assert_eq!(fixes.values().next().unwrap().len(), 2);
    assert_eq!(p.captions.as_ref().unwrap().style.highlight_color.g, 0.84);
}

#[test]
fn writes_what_editroom_reads() {
    let doc = SavedDocument::from_json(SAMPLE.as_bytes()).unwrap();
    let out: serde_json::Value = serde_json::from_slice(&doc.to_json()).unwrap();
    let p = &out["project"];
    // Swift's UUID encoding: uppercase.
    assert_eq!(p["clips"][0]["trackID"], "6F1C2B9E-3D4A-4B5C-8D6E-7F8091A2B3C4");
    // Swift spells these with capital DB/ID.
    assert!(p["audioTracks"][0].get("gainDB").is_some());
    assert!(p["clips"][0].get("linkID").is_some());
    // nil optionals are left out, as JSONEncoder does.
    assert!(p["clips"][1].get("assetID").is_none());
    assert!(p.get("outPoint").is_none());
    // [UUID: [CaptionFix]] is a flat [key, value] array.
    assert!(p["captionFixes"].is_array());
    assert_eq!(p["captionFixes"][0], "A55E7000-0000-4000-8000-000000000001");
    // Every non-optional key Swift requires is present.
    for key in ["id", "trackID", "kind", "start", "duration", "sourceStart", "speed", "fadeIn", "fadeOut", "gainDB", "color", "text"] {
        assert!(p["clips"][1].get(key).is_some(), "missing {key}");
    }
    // And it reads back the same.
    let again = SavedDocument::from_json(&doc.to_json()).unwrap();
    assert_eq!(again, doc);
}

#[test]
fn split_and_ripple_delete() {
    let mut p = SavedDocument::from_json(SAMPLE.as_bytes()).unwrap().project;
    let first = p.clips[0].id;
    let audio = p.clips[2].id;
    let right = p.split(&[first, audio].into_iter().collect(), 2.0);
    assert_eq!(right.len(), 2);
    // The two right-hand pieces stay linked to each other, not to the left ones.
    let pieces: Vec<&Clip> = p.clips.iter().filter(|c| right.contains(&c.id)).collect();
    assert_eq!(pieces[0].link_id, pieces[1].link_id);
    assert_ne!(pieces[0].link_id, p.clip(first).unwrap().link_id);
    // The left piece ends at the split; the right one starts there and its footage follows.
    assert!((p.clip(first).unwrap().end() - 2.0).abs() < 1e-9);
    let rv = pieces.iter().find(|c| c.kind == ClipKind::Video).unwrap();
    assert!((rv.start - 2.0).abs() < 1e-9);
    assert!((rv.source_start - p.clip(first).unwrap().source_time(2.0)).abs() < 1e-9);
    let text = p.clips.iter().find(|c| c.kind == ClipKind::Text).unwrap().clone();
    p.remove(&[first].into_iter().collect(), true);
    let moved = p.clip(text.id).unwrap();
    assert!((moved.start - (text.start - 2.0)).abs() < 1e-9, "ripple pulls later clips left");
}
