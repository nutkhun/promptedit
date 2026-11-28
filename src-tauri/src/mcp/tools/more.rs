//! Captions, playback, history, saving, exporting and auto edit.

use super::*;
use crate::mcp::providers::{self, ExportRequest, ExportStatus};
use promptedit_core::project::Ids;
use promptedit_core::{CaptionFix, CaptionStyle, ClipKind, MediaKind};
use std::time::{Duration, Instant};

pub fn call(c: &Call) -> Option<Out> {
    Some(match c.name {
        "set_captions" => set_captions(c),
        "playback" => playback(c),
        "history" => history(c),
        "auto_edit" => auto_edit(c),
        "save_project" => save_project(c),
        "export" => export(c),
        "export_status" => export_status(),
        _ => return None,
    })
}

/// The sound clips that captioning these clips means: each one's own sound, or its linked sound.
fn caption_targets(p: &Project, ids: &Ids) -> Ids {
    let group = p.linked(ids);
    p.clips.iter().filter(|c| group.contains(&c.id) && c.kind == ClipKind::Audio && c.plays_source()).map(|c| c.id).collect()
}

/// With nothing picked: the sound of clips from video files, and of any track something ducks under.
fn default_caption_targets(p: &Project) -> Ids {
    let ducked: Ids = p.audio_tracks.iter().filter_map(|t| t.duck_under).collect();
    p.clips
        .iter()
        .filter(|c| c.kind == ClipKind::Audio && c.plays_source())
        .filter(|c| ducked.contains(&c.track_id) || p.asset(c.asset_id).is_some_and(|a| a.kind == MediaKind::Video))
        .map(|c| c.id)
        .collect()
}

/// A caption on the timeline.
struct Block {
    start: f64,
    end: f64,
    text: String,
    asset: Id,
    /// File times of the words in it, which identify them for fixes.
    words: Vec<f64>,
}

/// The captions shown: each captioned clip's sentences, in timeline time, with its fixes applied.
/// (Editroom's `CaptionLayout` splits sentences into short phrases for the screen; the caption
/// renderer does that in PromptEdit, so agents get whole sentences here.)
fn blocks(p: &Project) -> Vec<Block> {
    let mut out = vec![];
    for clip in json::captioned_clips(p) {
        let Some(asset) = p.asset(clip.asset_id) else { continue };
        let Some(mut t) = providers::transcript_cached(asset) else { continue };
        let fixes = p.caption_fixes.as_ref().and_then(|f| f.get(&asset.id)).cloned().unwrap_or_default();
        for w in t.words.iter_mut() {
            if let Some(f) = fixes.iter().find(|f| (f.start - w.start).abs() < 1e-3) {
                w.text = f.text.clone();
            }
        }
        let s0 = clip.source_start;
        let s1 = s0 + clip.source_length();
        let to_timeline = |s: f64| clip.start + clip.timeline_span(s0, s.clamp(s0, s1));
        for (a, b, _) in t.sentences(0.8) {
            if b <= s0 || a >= s1 {
                continue;
            }
            let words: Vec<&providers::Word> = t.words.iter().filter(|w| w.start >= a - 1e-6 && w.end <= b + 1e-6 && w.start < s1 && w.end > s0).collect();
            let text = words.iter().map(|w| w.text.as_str()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
            if text.is_empty() {
                continue;
            }
            out.push(Block { start: to_timeline(a), end: to_timeline(b), text, asset: asset.id, words: words.iter().map(|w| w.start).collect() });
        }
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

fn captions_json(p: &Project) -> Value {
    let Some(track) = &p.captions else { return Value::Null };
    let b = blocks(p);
    let r3 = json::round3;
    json!({
        "hidden": track.hidden, "size": json::num(track.style.size), "position": json::num(track.style.y), "highlight": track.style.highlight,
        "clip_ids": json::captioned_clips(p).iter().map(|c| c.id.to_string()).collect::<Vec<_>>(),
        "count": b.len(),
        "captions": b.iter().take(60).map(|x| json!({"start": r3(x.start), "end": r3(x.end), "text": x.text})).collect::<Vec<_>>(),
    })
}

fn set_captions(c: &Call) -> Out {
    let p = c.now();
    let raw = strings(c.args, "clip_ids");
    let given: Ids = raw.iter().filter_map(|s| s.parse().ok()).collect();
    if !raw.is_empty() && given.is_empty() {
        return Err("clip_ids aren't clip ids from get_project.".into());
    }
    if boolean(c.args, "remove") == Some(true) {
        let targets = caption_targets(&p, &given);
        let label = if given.is_empty() { "No captions" } else { "Remove captions" };
        let after = c.perform(label, Spot::clips(&p, &args::ordered(&p, &targets)), |q| {
            if given.is_empty() {
                apply_edit(q, Edit::RemoveCaptionTrack);
            } else {
                apply_edit(q, Edit::RemoveCaptions { ids: targets.iter().copied().collect() });
            }
            Ok(())
        })?;
        return Ok(json_text(json!({"captions": captions_json(&after)})));
    }
    if !providers::transcripts_available() {
        return Err(format!("Captions need speech recognition, which isn't set up in {} {} yet.", crate::mcp::APP_NAME, crate::mcp::on_this()).into());
    }
    let targets = p.unlocked(&if given.is_empty() {
        if p.captions.is_none() { default_caption_targets(&p) } else { Ids::new() }
    } else {
        caption_targets(&p, &given)
    });
    if !given.is_empty() && targets.is_empty() {
        return Err("Those clips have no sound to caption.".into());
    }
    if p.captions.is_none() && targets.is_empty() {
        return Err("There's no one talking to caption: give clip_ids of clips with speech.".into());
    }
    // What's said in them, heard first, so the captions are there when this returns.
    for clip in p.clips.iter().filter(|x| targets.contains(&x.id)) {
        if let Some(a) = p.asset(clip.asset_id) {
            let _ = providers::transcript_ready(a);
        }
    }
    // Captions to fix, found on the captions as they'll be once these clips are captioned.
    let mut after = p.clone();
    apply_edit(&mut after, Edit::AddCaptions { ids: targets.iter().copied().collect() });
    let shown = blocks(&after);
    let mut fixes: Vec<(Id, Vec<f64>, String)> = vec![];
    for e in c.args.get("edit").and_then(Value::as_array).cloned().unwrap_or_default() {
        let (Some(at), Some(t)) = (e.get("at").and_then(Value::as_f64), e.get("text").and_then(Value::as_str)) else {
            return Err("Each edit needs at (timeline seconds) and text.".into());
        };
        let near = shown.iter().find(|b| at >= b.start && at < b.end).or_else(|| {
            shown
                .iter()
                .min_by(|a, b| ((a.start + a.end) / 2.0 - at).abs().total_cmp(&((b.start + b.end) / 2.0 - at).abs()))
                .filter(|b| at >= b.start - 0.5 && at < b.end + 0.5)
        });
        let b = near.ok_or_else(|| ToolError(format!("No caption at {at:.2}s.")))?;
        fixes.push((b.asset, b.words.clone(), t.to_string()));
    }
    let size = num(c.args, "size").map(|v| v.clamp(CaptionStyle::SIZE_RANGE.0, CaptionStyle::SIZE_RANGE.1));
    let position = num(c.args, "position").map(|v| v.clamp(0.1, 0.95));
    let highlight = boolean(c.args, "highlight");
    let hidden = boolean(c.args, "hidden");
    let after = c.perform("Captions", Spot::clips(&p, &args::ordered(&p, &targets)), |q| {
        apply_edit(q, Edit::AddCaptions { ids: targets.iter().copied().collect() });
        if let Some(cap) = q.captions.as_mut() {
            if let Some(v) = size {
                cap.style.size = v;
            }
            if let Some(v) = position {
                cap.style.y = v;
            }
            if let Some(v) = highlight {
                cap.style.highlight = v;
            }
            if let Some(v) = hidden {
                cap.hidden = v;
            }
        }
        // A caption's new words go on its first word; the rest of its words are left out.
        for (asset, words, t) in &fixes {
            let list = q.caption_fixes.get_or_insert_with(Default::default).entry(*asset).or_default();
            for (i, start) in words.iter().enumerate() {
                list.retain(|f| (f.start - start).abs() >= 1e-3);
                list.push(CaptionFix { start: *start, text: if i == 0 { t.clone() } else { String::new() }, merged: None });
            }
        }
        Ok(())
    })?;
    Ok(json_text(json!({"captions": captions_json(&after)})))
}

fn playback(c: &Call) -> Out {
    let action = string(c.args, "action");
    if let Some(d) = &c.draft {
        // Nothing plays during a Magic edit; seeking moves get_frame's default time.
        if action == Some("seek") {
            let t = num_req(c.args, "time")?.max(0.0);
            d.lock().unwrap().playhead = t;
        }
        let at = d.lock().unwrap().playhead;
        return Ok(text(format!("Playhead at {at:.3}s. Playback is off while making a Magic edit; use get_frame to see the cut.")));
    }
    let mcp = crate::mcp::mcp();
    let mut v = *mcp.view.lock().unwrap();
    match action {
        Some("play") => v.playing = true,
        Some("pause") => v.playing = false,
        Some("seek") => v.playhead = num_req(c.args, "time")?.max(0.0),
        _ => return Err("action is play, pause or seek.".into()),
    }
    *mcp.view.lock().unwrap() = v;
    // The UI owns playback: it plays, pauses or seeks and reports back.
    c.host.emit("mcp-playback", json!({"action": action, "time": v.playhead}));
    Ok(text(format!("Playhead at {:.3}s, {}.", v.playhead, if v.playing { "playing" } else { "paused" })))
}

fn history(c: &Call) -> Out {
    let action = string(c.args, "action");
    if let Some(d) = &c.draft {
        let mut d = d.lock().unwrap();
        match action {
            Some("undo") => {
                if !d.doc.can_undo() {
                    return Err("Nothing to undo.".into());
                }
                d.doc.undo();
            }
            Some("redo") => {
                if !d.doc.can_redo() {
                    return Err("Nothing to redo.".into());
                }
                d.doc.redo();
            }
            _ => return Err("action is undo or redo.".into()),
        }
        d.steps += 1;
        return Ok(text(format!("Done. {} clips on the timeline.", d.doc.project.clips.len())));
    }
    let n = {
        let mut doc = c.host.state().doc.lock().unwrap();
        match action {
            Some("undo") => {
                if !doc.can_undo() {
                    return Err("Nothing to undo.".into());
                }
                doc.undo();
            }
            Some("redo") => {
                if !doc.can_redo() {
                    return Err("Nothing to redo.".into());
                }
                doc.redo();
            }
            _ => return Err("action is undo or redo.".into()),
        }
        doc.project.clips.len()
    };
    c.host.project_changed();
    Ok(text(format!("Done. {n} clips on the timeline.")))
}

fn auto_edit(c: &Call) -> Out {
    c.not_in_magic()?;
    crate::magic::local::auto_edit(c.host).map_err(ToolError)?;
    Ok(json_text(json::project(&c.now(), &c.title(), c.playhead())))
}

fn save_project(c: &Call) -> Out {
    c.not_in_magic()?;
    if c.host.state().file.lock().unwrap().is_none() {
        return Err("This project has never been saved; ask the person to save it (File > Save).".into());
    }
    crate::save_project_to(c.host.state(), None).map_err(ToolError)?;
    c.host.project_changed();
    Ok(text("Saved."))
}

/// The pixel size an export comes out at, as Editroom's `ExportSettings.renderSize` (even sides).
fn render_size(p: &Project, shape: &str, height: Option<i64>) -> (i64, i64) {
    let even = |v: f64| ((v / 2.0).round() as i64 * 2).max(2);
    let (w, h) = (p.width as f64, p.height as f64);
    let (aw, ah) = match shape {
        "vertical" => (9.0, 16.0),
        "square" => (1.0, 1.0),
        "portrait" => (4.0, 5.0),
        _ => (w, h),
    };
    if shape == "original" {
        let out_h = height.map(|x| x as f64).unwrap_or(h);
        return (even(w * out_h / h.max(1.0)), even(out_h));
    }
    // Cropped from the sequence; height is the short side.
    let short = height.map(|x| x as f64).unwrap_or_else(|| w.min(h));
    if aw <= ah { (even(short), even(short * ah / aw)) } else { (even(short * aw / ah), even(short)) }
}

fn export(c: &Call) -> Out {
    if c.in_magic() {
        return Err("export isn't available while making a Magic edit; the person can export it when it's done.".into());
    }
    c.host.state().doc.lock().unwrap().commit_live();
    let q = c.now();
    if q.clips.is_empty() {
        return Err("The timeline is empty.".into());
    }
    // video: MP4; prores: a ProRes MOV; audio: WAV; mp3.
    let format = match string(c.args, "format") {
        Some(f @ ("audio" | "prores" | "mp3")) => f,
        _ => "video",
    };
    let sound_only = matches!(format, "audio" | "mp3");
    let prores_profile = string(c.args, "prores_profile");
    if let Some(p) = prores_profile
        && !["proxy", "lt", "standard", "hq"].contains(&p)
    {
        return Err("prores_profile is proxy, lt, standard or hq.".into());
    }
    let shape = string(c.args, "shape").unwrap_or("original");
    if !["original", "vertical", "square", "portrait"].contains(&shape) {
        return Err("shape is original, vertical, square or portrait.".into());
    }
    let height = int(c.args, "height");
    if let Some(h) = height
        && !(144..=4320).contains(&h)
    {
        return Err("height is 144…4320.".into());
    }
    let loudness = num(c.args, "loudness");
    if let Some(l) = loudness
        && !(-40.0..=-5.0).contains(&l)
    {
        return Err("loudness is a LUFS target, -40…-5 (like -14).".into());
    }
    let range_only = boolean(c.args, "range_only") == Some(true);
    if range_only && q.play_range().is_none() {
        return Err("There's no in/out range; set_in_out sets one.".into());
    }
    if sound_only && !q.clips.iter().any(|x| x.kind == ClipKind::Audio) {
        return Err("There's no sound on the timeline.".into());
    }
    // Where the person last exported to, else beside the project, else Movies (Videos on Windows).
    let file = c.host.state().file.lock().unwrap().clone();
    let folder = q
        .export_dir
        .as_ref()
        .map(std::path::PathBuf::from)
        .filter(|d| d.is_dir())
        .or_else(|| file.as_ref().and_then(|f| f.parent().map(|d| d.to_path_buf())))
        .or_else(dirs::video_dir)
        .unwrap_or_else(std::env::temp_dir);
    let title = c.title();
    let mut base = string(c.args, "name").map(str::to_string).or(q.export_name.clone()).unwrap_or_else(|| title.clone()).trim().replace(['/', ':'], "-");
    if base.is_empty() {
        base = title;
    }
    let ext = match format {
        "audio" => "wav",
        "mp3" => "mp3",
        "prores" => "mov",
        _ => "mp4",
    };
    let exports = &crate::mcp::mcp().exports;
    let mut path = folder.join(format!("{base}.{ext}"));
    let mut n = 2;
    while path.exists() || exports.has_file(&path.to_string_lossy()) {
        path = folder.join(format!("{base} {n}.{ext}"));
        n += 1;
    }
    let file = path.to_string_lossy().into_owned();
    let request = ExportRequest {
        id: Id::new().to_string(),
        file: file.clone(),
        format: format.into(),
        shape: shape.into(),
        height,
        codec: if string(c.args, "codec") == Some("hevc") { "hevc" } else { "h264" }.into(),
        quality: if string(c.args, "quality") == Some("web") { "web" } else { "high" }.into(),
        include_audio: boolean(c.args, "include_audio").unwrap_or(true),
        loudness,
        range_only,
        reframe_x: num(c.args, "reframe_x").unwrap_or(0.5).clamp(0.0, 1.0),
        reframe_y: num(c.args, "reframe_y").unwrap_or(0.5).clamp(0.0, 1.0),
        prores_profile: (format == "prores").then(|| prores_profile.unwrap_or("standard").to_string()),
    };
    exports.add(request.clone());
    // The UI's export pipeline (WebGL frames + encoder) runs it and reports with mcp_export_update.
    c.host.emit("mcp-export", serde_json::to_value(&request).unwrap_or(Value::Null));
    let (w, h) = render_size(&q, shape, height);
    let mut out = json!({"file": file, "size": if sound_only { "audio".to_string() } else { format!("{w}×{h}") }, "status": "started"});
    if boolean(c.args, "wait") == Some(true) {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(240) {
            std::thread::sleep(Duration::from_millis(500));
            let Some(item) = exports.items().into_iter().find(|i| i.request.id == request.id) else { break };
            match item.status {
                ExportStatus::Done => {
                    out["status"] = "done".into();
                    return Ok(json_text(out));
                }
                ExportStatus::Failed(why) => return Err(format!("The export failed: {why}").into()),
                ExportStatus::Cancelled => {
                    out["status"] = "cancelled".into();
                    return Ok(json_text(out));
                }
                _ => {}
            }
        }
        out["status"] = "still exporting; export_status says when it's done".into();
    }
    Ok(json_text(out))
}

fn export_status() -> Out {
    let items: Vec<Value> = crate::mcp::mcp()
        .exports
        .items()
        .iter()
        .map(|i| {
            let status = match &i.status {
                ExportStatus::Waiting => "waiting".to_string(),
                ExportStatus::Running => "running".into(),
                ExportStatus::Done => "done".into(),
                ExportStatus::Failed(w) => format!("failed: {w}"),
                ExportStatus::Cancelled => "cancelled".into(),
            };
            let mut d = json!({"file": i.request.file, "status": status});
            if i.status == ExportStatus::Running {
                d["progress"] = json::num((i.progress * 100.0).round() / 100.0);
            }
            d
        })
        .collect();
    if items.is_empty() {
        return Ok(json_text(json!({"exports": [], "note": "Nothing exporting, and nothing finished recently."})));
    }
    Ok(json_text(json!({"exports": items})))
}
