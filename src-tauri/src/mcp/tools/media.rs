//! Tools that read the project and the library: the project, media, looks, analysis, transcripts,
//! contact sheets, notes, frames of the cut and search; and bringing media in.

use super::*;
use crate::magic::analyzer;
use crate::mcp::{download, frames, notes, providers};
use promptedit_core::MediaKind;
use std::collections::HashMap;

pub fn call(c: &Call) -> Option<Out> {
    Some(match c.name {
        "get_project" => Ok(json_text(json::project(&c.now(), &c.title(), c.playhead()))),
        "list_media" => list_media(c),
        "list_looks" => Ok(json_text(json!(LOOKS))),
        "import_media" => import_media(c),
        "download_media" => download_media(c),
        "analyze_media" => analyze_media(c),
        "get_transcript" => get_transcript(c),
        "look_at_media" => look_at_media(c),
        "note_media" => note_media(c),
        "get_frame" => get_frame(c),
        "search_media" => search_media(c),
        _ => return None,
    })
}

/// Runs a future from a tool (tools run on blocking threads).
pub fn block_on<F: std::future::Future>(f: F) -> F::Output {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => tokio::task::block_in_place(|| h.block_on(f)),
        Err(_) => tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(f),
    }
}

/// The folder an item sits in, for media brought in as a folder ("B-roll / Drone").
fn folder_label(p: &Project, a: &promptedit_core::MediaAsset) -> Option<String> {
    let f = p.folders.iter().flatten().filter(|f| promptedit_core::paths::folder_contains(&f.path, &a.path)).max_by_key(|f| f.path.len())?;
    let rel = std::path::Path::new(&a.path).parent()?.strip_prefix(&f.path).ok()?;
    let mut parts = vec![f.name()];
    parts.extend(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    Some(parts.join(" / "))
}

fn list_media(c: &Call) -> Out {
    let p = c.now();
    // Labels most of the library shares ("structure", "people" in a vlog) don't tell clips apart: left out.
    let tagged: Vec<(Id, providers::SceneTags)> = p.assets.iter().filter_map(|a| providers::scene_tags(a.id).map(|t| (a.id, t))).collect();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (_, t) in &tagged {
        let mut seen: Vec<&str> = t.tags.iter().map(|x| x.name.as_str()).collect();
        seen.sort();
        seen.dedup();
        for n in seen {
            *counts.entry(n.to_string()).or_default() += 1;
        }
    }
    let common: Vec<String> =
        if tagged.len() >= 4 { counts.iter().filter(|(_, n)| **n as f64 >= tagged.len() as f64 * 0.6).map(|(k, _)| k.clone()).collect() } else { vec![] };
    let items: Vec<Value> = p
        .assets
        .iter()
        .map(|a| {
            let mut d = json::asset(a);
            let m = d.as_object_mut().unwrap();
            if let Some((_, t)) = tagged.iter().find(|(id, _)| *id == a.id) {
                let shows: Vec<String> = t.top(20).into_iter().filter(|s| !common.contains(s)).take(8).collect();
                if !shows.is_empty() {
                    m.insert("shows".into(), json!(shows));
                }
            }
            if let Some(n) = notes::note(&a.path) {
                m.insert("notes".into(), n.text.into());
            }
            if let Some(t) = providers::transcript_cached(a) {
                m.insert("speech".into(), (!t.is_empty()).into());
                if !t.is_empty() {
                    let text = t.text();
                    let says: String = text.chars().take(120).collect();
                    m.insert("says".into(), (says + if text.chars().count() > 120 { "…" } else { "" }).into());
                }
            }
            if let Some(f) = folder_label(&p, a) {
                m.insert("folder".into(), f.into());
            }
            d
        })
        .collect();
    Ok(json_text(Value::Array(items)))
}

/// Files inside folders, in name order, skipping hidden ones.
fn expand(paths: &[std::path::PathBuf]) -> Vec<String> {
    fn walk(d: &std::path::Path, out: &mut Vec<String>) {
        let mut entries: Vec<_> = std::fs::read_dir(d).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        entries.sort();
        for p in entries {
            if p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
                continue;
            }
            if p.is_dir() { walk(&p, out) } else { out.push(p.to_string_lossy().into_owned()) }
        }
    }
    let mut out = vec![];
    for p in paths {
        if p.is_dir() { walk(p, &mut out) } else { out.push(p.to_string_lossy().into_owned()) }
    }
    out
}

fn import_media(c: &Call) -> Out {
    c.not_in_magic()?;
    let paths: Vec<std::path::PathBuf> = strings(c.args, "paths").iter().map(|s| std::path::PathBuf::from(super::edit::expand_tilde(s))).collect();
    let missing: Vec<String> = paths.iter().filter(|p| !p.exists()).map(|p| p.to_string_lossy().into_owned()).collect();
    if !missing.is_empty() {
        return Err(format!("No file at {}", missing.join(", ")).into());
    }
    // A folder brings in what's in it. (Editroom also keeps the folder linked for files added later;
    // that's the library's job in PromptEdit.)
    let files = expand(&paths);
    let n = files.len();
    let r = c.host.import(files);
    c.host.project_changed();
    let p = c.now();
    let imported: Vec<Value> = r.added.iter().filter_map(|id| p.asset(Some(*id))).map(json::asset).collect();
    let known = r.probes.len();
    Ok(json_text(json!({"imported": imported, "failed": n.saturating_sub(known)})))
}

fn download_media(c: &Call) -> Out {
    let url = string(c.args, "url").map(str::trim).filter(|s| !s.is_empty()).ok_or("url is needed: the https link to the audio file.")?;
    let project_file = c.host.state().file.lock().unwrap().clone();
    let folder = download::folder(project_file.as_deref());
    let allow_files = std::env::var("PROMPTEDIT_ALLOW_FILE_DOWNLOADS").is_ok();
    let file = block_on(download::fetch(url, string(c.args, "name"), string(c.args, "source_page"), string(c.args, "licence"), &folder, allow_files))?;
    let r = c.host.import(vec![file.to_string_lossy().into_owned()]);
    let id = r.added.first().copied().or_else(|| r.probes.first().map(|x| x.0)).ok_or("Downloaded it, but couldn't add it to the library.")?;
    c.host.project_changed();
    let asset = c.host.state().doc.lock().unwrap().project.asset(Some(id)).cloned().ok_or("Downloaded it, but couldn't add it to the library.")?;
    // The one thing a Magic run may add from outside: in the library now, and in its draft too.
    if let Some(d) = &c.draft {
        let mut d = d.lock().unwrap();
        if !d.doc.project.assets.iter().any(|a| a.id == asset.id) {
            d.doc.project.assets.push(asset.clone());
            d.base.assets.push(asset.clone());
        }
    }
    let mut out = json::asset(&asset);
    out["saved_to"] = file.to_string_lossy().into_owned().into();
    Ok(json_text(json!({"added": out, "note": "In the library now; add it with add_clip."})))
}

fn analyze_media(c: &Call) -> Out {
    let p = c.now();
    let asset = asset_arg(c.args, &p)?;
    let r3 = json::round3;
    if asset.kind == MediaKind::Audio {
        let m = analyzer::music(&asset).ok_or_else(|| ToolError(format!("Couldn't read the sound in {}.", asset.name)))?;
        let bars: Vec<Value> = (0..m.beats.len()).filter(|i| m.is_bar_start(*i)).map(|i| r3(m.beats[i])).take(80).collect();
        return Ok(json_text(json!({
            "bpm": r3(m.bpm), "beat_length": r3(m.period()), "beat_count": m.beats.len(),
            "first_beat": r3(m.beats.first().copied().unwrap_or(0.0)), "bar_starts": bars,
        })));
    }
    let a = analyzer::clip(&asset).ok_or_else(|| ToolError(format!("Couldn't look at {}.", asset.name)))?;
    let length = num(c.args, "moment_length").unwrap_or(2.0);
    let score = crate::magic::planner::scorer(&a.samples);
    let moments = crate::magic::planner::moments(&a, asset.duration, length, 5, &score);
    let mean = a.samples.iter().map(|s| s.luma).sum::<f64>() / a.samples.len().max(1) as f64;
    let mut out = json!({
        "duration": r3(a.duration.min(if asset.kind == MediaKind::Image { a.duration } else { asset.duration })),
        "best_moments": moments.iter().map(|m| json!({"start": r3(m.start), "end": r3(m.end), "score": r3(m.score), "faces": m.faces})).collect::<Vec<_>>(),
        "average_brightness": r3(mean),
        "has_faces": a.samples.iter().any(|s| s.faces > 0),
    });
    if let Some(created) = a.created {
        out["filmed"] = download::iso8601(created as i64).into();
    }
    if a.samples.iter().any(|s| s.utility == Some(true)) {
        out["looks_like_a_screenshot_or_document"] = true.into();
    }
    Ok(json_text(out))
}

fn get_transcript(c: &Call) -> Out {
    let p = c.now();
    let a = asset_arg(c.args, &p)?;
    let id = a.id.to_string();
    if a.kind == MediaKind::Image || (a.kind == MediaKind::Video && !a.has_audio) {
        return Ok(json_text(json!({"asset_id": id, "status": "no_sound", "note": format!("{} has no sound.", a.name)})));
    }
    if !providers::transcripts_available() {
        return Ok(json_text(json!({"asset_id": id, "status": "unavailable", "note": format!("Hearing speech isn't set up in {} {} yet.", crate::mcp::APP_NAME, crate::mcp::on_this())})));
    }
    let Some(t) = providers::transcript_ready(&a) else {
        return Ok(json_text(json!({"asset_id": id, "status": "failed", "note": format!("Couldn't hear what's said in {}.", a.name)})));
    };
    let r3 = json::round3;
    let mut d = json!({"asset_id": id, "name": a.name, "duration": r3(a.duration)});
    if t.is_empty() {
        d["status"] = "no_speech".into();
        d["note"] = "Nobody talks in it (or only music or noise).".into();
        return Ok(json_text(d));
    }
    d["status"] = "ready".into();
    d["language"] = t.language.clone().into();
    d["times"] = "Seconds in the file. A clip plays the file from its source_start.".into();
    d["sentences"] = t.sentences(0.8).iter().map(|(s, e, x)| json!({"start": r3(*s), "end": r3(*e), "text": x})).collect::<Vec<_>>().into();
    // Silence of half a second or more, which is where cuts can go.
    let mut pauses = vec![];
    let mut at = 0.0;
    for (s, e) in t.speech(0.45) {
        if s - at >= 0.5 {
            pauses.push(json!({"start": r3(at), "end": r3(s)}));
        }
        at = e;
    }
    if a.duration - at >= 0.5 {
        pauses.push(json!({"start": r3(at), "end": r3(a.duration)}));
    }
    d["pauses"] = pauses.into();
    if boolean(c.args, "words") == Some(true) {
        d["words"] = t.words.iter().map(|w| json!([r3(w.start), r3(w.end), w.text])).collect::<Vec<_>>().into();
    }
    Ok(json_text(d))
}

fn look_at_media(c: &Call) -> Out {
    let p = c.now();
    let a = asset_arg(c.args, &p)?;
    if a.kind == MediaKind::Audio {
        return Err(format!("{} is sound only; analyze_media finds its beats.", a.name).into());
    }
    let frames = int(c.args, "frames").unwrap_or(6);
    let times: Option<Vec<f64>> = c.args.get("times").and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_f64).collect());
    let (jpeg, times) = frames::contact_sheet(&a, frames, times.as_deref()).ok_or_else(|| ToolError(format!("Couldn't look at {}.", a.name)))?;
    let note = if a.kind == MediaKind::Image {
        format!("{}, a photo.", a.name)
    } else {
        format!(
            "{}, {}s long. Frames at {}, left to right, top to bottom.",
            a.name,
            json::round3(a.duration),
            times.iter().map(|t| format!("{t:.1}s")).collect::<Vec<_>>().join(", ")
        )
    };
    let saved = match notes::note(&a.path) {
        Some(n) => format!(" Its saved notes: {} Update them with note_media if you see more.", n.text),
        None => " Save what you see with note_media.".into(),
    };
    use base64::Engine;
    Ok(vec![
        json!({"type": "image", "data": base64::engine::general_purpose::STANDARD.encode(jpeg), "mimeType": "image/jpeg"}),
        json!({"type": "text", "text": note + &saved}),
    ])
}

fn note_media(c: &Call) -> Out {
    let p = c.now();
    let a = asset_arg(c.args, &p)?;
    let t = string(c.args, "notes").map(str::trim).filter(|t| !t.is_empty()).ok_or("Give notes: what's in it, with times.")?;
    notes::save(t, &a.path, Some(&c.who));
    Ok(text(format!("Saved. list_media will show it with {}.", a.name)))
}

fn get_frame(c: &Call) -> Out {
    let p = c.now();
    if p.clips.is_empty() {
        return Err("The timeline is empty.".into());
    }
    let t = num(c.args, "time").unwrap_or_else(|| c.playhead());
    let (png, note) = frames::cut_frame(&p, t).ok_or_else(|| ToolError(format!("Couldn't render a frame at {t}s.")))?;
    use base64::Engine;
    let mut said = format!("Frame at {}s.", json::round3(t));
    if let Some(n) = note {
        said += " ";
        said += &n;
    }
    Ok(vec![
        json!({"type": "image", "data": base64::engine::general_purpose::STANDARD.encode(png), "mimeType": "image/png"}),
        json!({"type": "text", "text": said}),
    ])
}

fn search_media(c: &Call) -> Out {
    let p = c.now();
    let shows = string(c.args, "shows").unwrap_or("").trim().to_lowercase();
    let said = string(c.args, "said").unwrap_or("").trim().to_string();
    if shows.is_empty() && said.is_empty() {
        return Err("Give shows and/or said.".into());
    }
    let words: Vec<&str> = shows.split(' ').filter(|w| !w.is_empty() && !["a", "an", "the", "of", "in", "on", "at", "with"].contains(w)).collect();
    let mut found = vec![];
    let (mut unseen, mut unheard) = (0, 0);
    let r3 = json::round3;
    for a in &p.assets {
        let mut hit = json!({"asset_id": a.id.to_string(), "name": a.name});
        if !words.is_empty() {
            let tags = providers::scene_tags(a.id);
            if tags.is_none() && a.kind != MediaKind::Audio {
                unseen += 1;
            }
            let name = a.name.to_lowercase();
            if !words.iter().all(|w| name.contains(w) || tags.as_ref().is_some_and(|t| t.shows(w))) {
                continue;
            }
            let matched: Vec<Value> = words
                .iter()
                .flat_map(|w| tags.as_ref().map(|t| t.matching(w).into_iter().cloned().collect::<Vec<_>>()).unwrap_or_default())
                .map(|t| json!({"tag": t.name, "times": t.times.iter().take(8).map(|x| r3(*x)).collect::<Vec<_>>()}))
                .collect();
            if !matched.is_empty() {
                hit["shows"] = matched.into();
            }
        }
        if !said.is_empty() {
            if a.kind == MediaKind::Image {
                continue;
            }
            let Some(t) = providers::transcript_cached(a) else {
                unheard += 1;
                continue;
            };
            let places = t.occurrences(&said);
            if places.is_empty() {
                continue;
            }
            hit["said"] = places.iter().take(10).map(|(s, e, w)| json!({"start": r3(*s), "end": r3(*e), "words": w})).collect::<Vec<_>>().into();
        }
        found.push(hit);
    }
    let mut out = json!({"found": found, "times": "Seconds in each file, like source_start."});
    let mut notes = vec![];
    if unseen > 0 {
        notes.push(format!("{unseen} item{} been looked through yet", if unseen == 1 { " hasn't" } else { "s haven't" }));
    }
    if unheard > 0 {
        notes.push(format!("{unheard} haven't been heard yet (get_transcript hears one now)"));
    }
    if !notes.is_empty() {
        out["note"] = (notes.join("; ") + ".").into();
    }
    Ok(json_text(out))
}
