//! Tools that change the timeline: placing, moving, trimming, cutting, speed, colour, sound,
//! transitions, framing, titles, solids, tracks, markers and the in/out range.

use super::*;
use promptedit_core::edit::{ClipPatch, Payload, TrackPatch, make_clips, standard_fps};
use promptedit_core::project::Ids;
use promptedit_core::{
    Clip, ClipKind, ClipTransform, Marker, MarkerTint, MediaKind, Track, TrackKind, Transition, TransitionKind, ZoomMode,
    ZoomMove, track_token,
};
use std::collections::HashMap;

pub fn call(c: &Call) -> Option<Out> {
    Some(match c.name {
        "add_clip" => add_clip(c),
        "add_title" => add_title(c),
        "move_clip" => move_clip(c),
        "trim_clip" => trim_clip(c),
        "set_speed" => set_speed(c),
        "set_speed_ramp" => set_speed_ramp(c),
        "split_clip" => split_clip(c),
        "delete_clips" => delete_clips(c),
        "set_grade" => set_grade(c),
        "set_audio" => set_audio(c),
        "set_transition" => set_transition(c),
        "add_track" => add_track(c),
        "set_sequence" => set_sequence(c),
        "set_marker" => set_marker(c),
        "delete_markers" => delete_markers(c),
        "set_in_out" => set_in_out(c),
        "set_transform" => set_transform(c),
        "set_title_style" => set_title_style(c),
        "freeze_frame" => freeze_frame(c),
        "reverse_clip" => reverse_clip(c),
        "detach_audio" => detach_audio(c),
        "duplicate_clip" => duplicate_clip(c),
        "set_track" => set_track(c),
        "add_solid" => add_solid(c),
        "set_solid_color" => set_solid_color(c),
        _ => return None,
    })
}

fn r3(v: f64) -> Value {
    json::round3(v)
}

/// A new empty video track on top, in the same step as what goes on it. (Editroom adds it as a
/// separate undo step in live mode; PromptEdit keeps one step per call, as the spec intends.)
fn new_video_track(p: &mut Project) -> Id {
    p.add_track(TrackKind::Video)
}

fn free_video_track(p: &Project, start: f64, length: f64, skip_v1: bool) -> Option<Id> {
    p.video_tracks.iter().skip(usize::from(skip_v1)).find(|t| !t.locked && !p.clips.iter().any(|x| x.track_id == t.id && x.start < start + length && x.end() > start)).map(|t| t.id)
}

fn add_clip(c: &Call) -> Out {
    let p = c.now();
    let asset = asset_arg(c.args, &p)?;
    let audio_only = asset.kind == MediaKind::Audio;
    let kind = if audio_only { TrackKind::Audio } else { TrackKind::Video };
    let track = track_arg(string(c.args, "track").unwrap_or(if audio_only { "A1" } else { "V1" }), &p, kind)?;
    let start = num(c.args, "start").unwrap_or_else(|| p.clips.iter().filter(|x| x.track_id == track).map(Clip::end).fold(0.0, f64::max)).max(0.0);
    let source = num(c.args, "source_start").unwrap_or(0.0).max(0.0);
    let image = asset.kind == MediaKind::Image;
    if !image && source >= asset.duration - 0.05 {
        return Err(format!("source_start is past the end of {} ({}s).", asset.name, r3(asset.duration)).into());
    }
    let rest = if image { 5.0 } else { asset.duration - source };
    let length = num(c.args, "duration").unwrap_or(rest).min(if image { 3600.0 } else { rest }).max(1.0 / p.fps);
    let audio_track = if audio_only {
        track
    } else {
        p.free_track(TrackKind::Audio, start, length).or(p.audio_tracks.first().map(|t| t.id)).unwrap_or(track_token::NEW_AUDIO)
    };
    let video_track = if audio_only { p.video_tracks.first().map(|t| t.id).unwrap_or(track) } else { track };
    let mut clips = make_clips(&p, &Payload::Asset { id: asset.id }, p.snap_frame(start), video_track, audio_track);
    if clips.is_empty() {
        return Err(format!("Couldn't make a clip from {}.", asset.name).into());
    }
    for x in clips.iter_mut() {
        x.source_start = if image { 0.0 } else { source };
        x.duration = p.snap_frame(length);
    }
    let ids: Vec<Id> = clips.iter().map(|x| x.id).collect();
    let label = match clips[0].kind {
        ClipKind::Audio => "Music",
        _ => "Place",
    };
    let after = c.perform(label, Spot::at(p.snap_frame(start), track), |q| {
        q.insert(clips);
        Ok(())
    })?;
    let added: Vec<Value> = ids
        .iter()
        .filter_map(|i| after.clip(*i))
        .map(|x| json!({"id": json::id(x.id), "track": json::track_name(x.track_id, &after), "start": r3(x.start), "end": r3(x.end())}))
        .collect();
    Ok(json_text(json!({"added": added})))
}

fn add_title(c: &Call) -> Out {
    let p = c.now();
    let words = string(c.args, "text").unwrap_or("").trim().to_string();
    if words.is_empty() {
        return Err("The title needs some text.".into());
    }
    let start = num(c.args, "start").unwrap_or(0.0).max(0.0);
    let length = num(c.args, "duration").unwrap_or(3.0).max(0.2);
    let named = match string(c.args, "track") {
        Some(n) => Some(track_arg(n, &p, TrackKind::Video)?),
        // Above the picture: the first video track (not V1) that's free there.
        None => free_video_track(&p, start, length, true),
    };
    let mut clip = Clip { kind: ClipKind::Text, start: p.snap_frame(start), duration: p.snap_frame(length), ..Clip::default() };
    clip.text.string = words;
    let id = clip.id;
    let after = c.perform("Title", Spot::at(clip.start, named.unwrap_or_default()), |q| {
        clip.track_id = named.unwrap_or_else(|| new_video_track(q));
        q.insert(vec![clip]);
        Ok(())
    })?;
    let x = after.clip(id).ok_or("The title didn't stick.")?;
    Ok(json_text(json!({"added": {"id": json::id(x.id), "track": json::track_name(x.track_id, &after), "start": r3(x.start), "end": r3(x.end())}})))
}

fn move_clip(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    let start = num_req(c.args, "start")?.max(0.0);
    let mut tracks: HashMap<Id, Id> = HashMap::new();
    if let Some(n) = string(c.args, "track") {
        tracks.insert(clip.id, track_arg(n, &p, clip.kind.track_kind())?);
    }
    let ids = p.unlocked(&p.linked(&one(clip.id)));
    let order = ordered(&p, &ids);
    let to = p.snap_frame(start);
    let after = c.perform("Move", Spot::at(to, *tracks.get(&clip.id).unwrap_or(&clip.track_id)), |q| {
        let delta = q.snap_frame(to) - clip.start;
        for x in q.clips.iter_mut().filter(|x| ids.contains(&x.id)) {
            x.start += delta;
            if let Some(t) = tracks.get(&x.id) {
                x.track_id = *t;
            }
        }
        q.resolve_overlaps(&ids);
        Ok(())
    })?;
    Ok(json_text(json::clips(&order, &after)))
}

fn trim_clip(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    let ids = p.unlocked(&p.linked(&one(clip.id)));
    let order = ordered(&p, &ids);
    let (mut new_start, mut new_end) = (clip.start, clip.end());
    if let Some(s) = num(c.args, "start") {
        // Not before the start of the file.
        let earliest = if clip.plays_source() { clip.start - clip.timeline_span(0.0, clip.source_start) } else { 0.0 };
        new_start = p.snap_frame(earliest.max(0.0).max(s));
    }
    if let Some(e) = num(c.args, "end") {
        let mut latest = f64::INFINITY;
        if clip.plays_source()
            && let Some(limit) = p.source_limit(&clip)
        {
            latest = clip.start + clip.timeline_span(clip.source_start, limit);
        }
        new_end = p.snap_frame(latest.min(e));
    }
    if new_end - new_start < 1.0 / p.fps {
        return Err("That would leave the clip with no length.".into());
    }
    if new_start == clip.start && new_end == clip.end() {
        return Ok(json_text(json::clips(&order, &p)));
    }
    let after = c.perform("Trim", Spot::at(if new_start != clip.start { new_start } else { new_end }, clip.track_id), |q| {
        if new_start != clip.start {
            let t = q.snap_frame(new_start);
            for x in q.clips.iter_mut().filter(|x| ids.contains(&x.id)) {
                x.trim_head(t);
            }
        }
        if new_end != clip.end() {
            let t = q.snap_frame(new_end);
            for x in q.clips.iter_mut().filter(|x| ids.contains(&x.id)) {
                x.trim_tail(t);
            }
        }
        q.resolve_overlaps(&ids);
        Ok(())
    })?;
    Ok(json_text(json::clips(&order, &after)))
}

fn set_speed(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if !clip.plays_source() {
        return Err("Only video and sound clips have a speed.".into());
    }
    let speed = num_req(c.args, "speed")?.clamp(0.05, 100.0);
    let ids = p.unlocked(&p.linked(&one(clip.id)));
    let order = ordered(&p, &ids);
    let label = if speed >= 1.0 { format!("Speed ×{}", fmt_g(speed)) } else { format!("Slow ×{}", fmt_g(speed)) };
    let after = c.perform(&label, Spot::clips(&p, &[clip.id]), |q| {
        apply_edit(q, Edit::SetSpeed { ids: order.clone(), speed, sticky: false });
        Ok(())
    })?;
    Ok(json_text(json::clips(&order, &after)))
}

fn set_speed_ramp(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if !clip.plays_source() {
        return Err("Only video and sound clips have a speed.".into());
    }
    let ids = p.unlocked(&p.linked(&one(clip.id)));
    let order = ordered(&p, &ids);
    if boolean(c.args, "remove") == Some(true) {
        let after = c.perform("No ramp", Spot::clips(&p, &[clip.id]), |q| {
            q.retime(&ids, false, &|x: &mut Clip| x.ramp = None);
            Ok(())
        })?;
        return Ok(json_text(json::clips(&order, &after)));
    }
    let speed = num(c.args, "speed").ok_or("speed is needed (or remove: true).")?.clamp(0.05, 100.0);
    let s0 = clip.source_start;
    let l = clip.source_length().max(1e-6);
    let s1 = s0 + l;
    let ease = num(c.args, "ease").unwrap_or(0.4).max(0.04);
    let around = num(c.args, "around").unwrap_or(1.0).clamp(0.05, 100.0);
    let from = num(c.args, "from").map(|v| v.max(s0).min(s1));
    let to = num(c.args, "to").map(|v| v.max(from.unwrap_or(s0)).min(s1));
    if from.is_none() && to.is_none() {
        return Err("Give from and/or to (seconds in the file); for one speed throughout, use set_speed.".into());
    }
    let f = |s: f64| ((s - s0) / l).clamp(0.0, 1.0);
    let mut points = (0.0, 0.0, 1.0, 1.0);
    if let Some(from) = from
        && from > s0 + 1e-3
    {
        points.0 = f(from - ease);
        points.1 = f(from);
    }
    if let Some(to) = to
        && to < s1 - 1e-3
    {
        points.2 = f(to);
        points.3 = f(to + ease);
    }
    if points.1 - points.0 < 0.001 && points.3 - points.2 < 0.001 {
        return Err(format!(
            "That ramp would sit outside the clip: from and to should be inside its part of the file ({s0:.2}–{s1:.2}s)."
        )
        .into());
    }
    let label = if speed < around { "Slow-mo ramp" } else { "Speed ramp" };
    let after = c.perform(label, Spot::clips(&p, &[clip.id]), |q| {
        apply_edit(q, Edit::SetRamp { ids: order.clone(), speed, points, start: around, end: around, sticky: false });
        Ok(())
    })?;
    Ok(json_text(json::clips(&order, &after)))
}

fn split_clip(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    let at = p.snap_frame(num_req(c.args, "at")?);
    if !(at > clip.start + 0.5 / p.fps && at < clip.end() - 0.5 / p.fps) {
        return Err(format!("{}s isn't inside the clip ({}–{}).", r3(at), r3(clip.start), r3(clip.end())).into());
    }
    let ids = p.unlocked(&p.linked(&one(clip.id)));
    let left = ordered(&p, &ids);
    let before: Ids = p.clips.iter().map(|x| x.id).collect();
    let after = c.perform("✂ Cut", Spot::at(at, clip.track_id), |q| {
        apply_edit(q, Edit::Split { ids: left.clone(), at });
        Ok(())
    })?;
    let right: Vec<Id> = after.clips.iter().filter(|x| !before.contains(&x.id)).map(|x| x.id).collect();
    Ok(json_text(json!({"left": json::clips(&left, &after), "right": json::clips(&right, &after)})))
}

fn delete_clips(c: &Call) -> Out {
    let p = c.now();
    let mut ids = Ids::new();
    for s in strings(c.args, "clip_ids") {
        let id = s.parse::<Id>().ok().filter(|i| p.clip(*i).is_some()).ok_or_else(|| ToolError(format!("No clip with id {s}.")))?;
        ids.insert(id);
    }
    let all = p.unlocked(&p.linked(&ids));
    if all.is_empty() {
        return Err("Nothing to delete (locked tracks?).".into());
    }
    let ripple = boolean(c.args, "ripple").unwrap_or(false);
    let order = ordered(&p, &all);
    let n = all.len();
    c.perform("Delete", Spot::clips(&p, &order), |q| {
        apply_edit(q, Edit::Delete { ids: order.clone(), ripple });
        Ok(())
    })?;
    Ok(text(format!("Deleted {n} clip{}.", if n == 1 { "" } else { "s" })))
}

fn set_grade(c: &Call) -> Out {
    let p = c.now();
    let mut raw = strings(c.args, "clip_ids");
    if raw.is_empty()
        && let Some(s) = string(c.args, "clip_id")
    {
        raw.push(s.to_string());
    }
    let look = string(c.args, "look").map(str::to_string);
    let mut targets = vec![];
    for s in &raw {
        let x = s.parse::<Id>().ok().and_then(|i| p.clip(i)).ok_or_else(|| ToolError(format!("No clip with id {s}.")))?;
        if x.kind == ClipKind::Audio {
            return Err(format!("{} is sound; it has no colour.", p.name_of(x)).into());
        }
        targets.push(x.id);
    }
    let look_value: Option<Option<String>> = match look.as_deref() {
        None => None,
        Some(l) if l.eq_ignore_ascii_case("none") => Some(None),
        Some(l) => {
            let path = expand_tilde(l);
            if is_look(l) {
                Some(Some(l.to_string()))
            } else if path.ends_with(".cube") && is_cube_file(&path) {
                Some(Some(path))
            } else {
                return Err(format!("No look called {l}. list_looks has the built-in ones.").into());
            }
        }
    };
    let exposure = num(c.args, "exposure").map(|v| v.clamp(-2.0, 2.0));
    let contrast = num(c.args, "contrast").map(|v| v.clamp(-50.0, 50.0));
    let saturation = num(c.args, "saturation").map(|v| v.clamp(-100.0, 100.0));
    let intensity = num(c.args, "look_intensity").map(|v| v.clamp(0.0, 1.0));
    let temperature = num(c.args, "temperature").map(|v| v.clamp(-50.0, 50.0));
    let tint = num(c.args, "tint").map(|v| v.clamp(-50.0, 50.0));
    let anything = look_value.is_some() || [exposure, contrast, saturation, intensity, temperature, tint].iter().any(Option::is_some);
    if targets.is_empty() || !anything {
        return Err("Nothing to change: give clip_ids and at least one setting.".into());
    }
    let label = match &look_value {
        Some(Some(l)) => json::look_label(l),
        Some(None) => "No look".into(),
        None => "Colour".into(),
    };
    let after = c.perform(&label, Spot::clips(&p, &targets), |q| {
        for id in &targets {
            let Some(x) = q.clip(*id) else { continue };
            let mut g = x.grade.clone().unwrap_or_default();
            if let Some(l) = &look_value {
                g.look = l.clone();
            }
            if let Some(v) = exposure {
                g.exposure = v;
            }
            if let Some(v) = contrast {
                g.contrast = v;
            }
            if let Some(v) = saturation {
                g.saturation = v;
            }
            if let Some(v) = intensity {
                g.look_intensity = v;
            }
            if let Some(v) = temperature {
                g.temperature = v;
            }
            if let Some(v) = tint {
                g.tint = v;
            }
            let grade = if g.is_neutral() { None } else { Some(g) };
            apply_edit(q, Edit::Update { ids: vec![*id], patch: ClipPatch { grade: Some(grade), ..Default::default() } });
        }
        Ok(())
    })?;
    Ok(json_text(json::clips(&targets, &after)))
}

pub fn expand_tilde(p: &str) -> String {
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => p.to_string(),
    }
}

/// A readable .cube LUT: has a LUT_3D_SIZE line and numbers.
fn is_cube_file(path: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|t| t.lines().any(|l| l.trim_start().starts_with("LUT_3D_SIZE")))
}

fn set_audio(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    let gain = num(c.args, "gain_db").map(|g| g.clamp(-60.0, 12.0));
    let fade_in = num(c.args, "fade_in").map(|f| f.min(clip.duration).max(0.0));
    let fade_out = num(c.args, "fade_out").map(|f| f.min(clip.duration).max(0.0));
    if gain.is_none() && fade_in.is_none() && fade_out.is_none() {
        return Err("Give gain_db, fade_in or fade_out.".into());
    }
    let label = match (gain, fade_in, fade_out) {
        (Some(g), _, _) => format!("{} dB", (g.round() as i64)).replace('-', "−"),
        (None, Some(_), _) => "Fade in".into(),
        _ => "Fade out".into(),
    };
    let after = c.perform(&label, Spot::clips(&p, &[clip.id]), |q| {
        // Fades one at a time, each clamped against the other as it lands (Editroom's fadeIn/fadeOut).
        if let Some(g) = gain {
            apply_edit(q, Edit::Update { ids: vec![clip.id], patch: ClipPatch { gain_db: Some(g), ..Default::default() } });
        }
        if let Some(i) = q.index_of(clip.id) {
            if let Some(f) = fade_in {
                q.clips[i].fade_in = f;
                q.clips[i].clamp_fades();
            }
            if let Some(f) = fade_out {
                q.clips[i].fade_out = f;
                q.clips[i].clamp_fades();
            }
        }
        Ok(())
    })?;
    Ok(json_text(json::clips(&[clip.id], &after)))
}

fn set_transition(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    let kind = string(c.args, "kind").unwrap_or("dissolve");
    let transition = match kind {
        "none" => None,
        k => {
            let kind = match k {
                "dissolve" => TransitionKind::Dissolve,
                "dipToBlack" => TransitionKind::DipToBlack,
                "wipe" => TransitionKind::Wipe,
                _ => return Err("kind is dissolve, dipToBlack, wipe or none.".into()),
            };
            if !p.clips.iter().any(|x| x.track_id == clip.track_id && x.id != clip.id && (x.end() - clip.start).abs() < 1e-3) {
                return Err("Nothing ends where this clip starts on its track, so there's nothing to transition from.".into());
            }
            Some(Transition { kind, duration: num(c.args, "duration").unwrap_or(0.5).max(0.04) })
        }
    };
    let label = transition.map(|t| t.kind.label().to_string()).unwrap_or_else(|| "No transition".into());
    let after = c.perform(&label, Spot::at(clip.start, clip.track_id), |q| {
        apply_edit(q, Edit::SetTransition { id: clip.id, transition });
        Ok(())
    })?;
    Ok(json_text(json::clips(&[clip.id], &after)))
}

fn add_track(c: &Call) -> Out {
    let kind = if string(c.args, "kind") == Some("audio") { TrackKind::Audio } else { TrackKind::Video };
    let after = c.perform(if kind == TrackKind::Video { "Add video track" } else { "Add audio track" }, Spot::none(), |q| {
        apply_edit(q, Edit::AddTrack { kind });
        Ok(())
    })?;
    Ok(text(format!("Added {}{}.", if kind == TrackKind::Video { "V" } else { "A" }, after.tracks(kind).len())))
}

fn set_sequence(c: &Call) -> Out {
    let mut size = None;
    if let (Some(w), Some(h)) = (int(c.args, "width"), int(c.args, "height")) {
        if !(16..=8192).contains(&w) || !(16..=8192).contains(&h) {
            return Err("Width and height are 16…8192.".into());
        }
        size = Some((w, h));
    }
    let fps = num(c.args, "fps").map(sequence_fps);
    let after = c.perform("Sequence", Spot::none(), |q| {
        if let Some((w, h)) = size {
            apply_edit(q, Edit::SetSequence { width: w, height: h });
        }
        if let Some(f) = fps {
            apply_edit(q, Edit::SetFps { fps: f });
        }
        q.settings_locked = true;
        Ok(())
    })?;
    Ok(json_text(json!({"width": after.width, "height": after.height, "fps": json::num(after.fps)})))
}

/// The nearest frame rate the tool offers (the core's list plus high rates).
fn sequence_fps(f: f64) -> f64 {
    const RATES: [f64; 11] = [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0, 100.0, 119.88, 120.0];
    if f <= 1.0 {
        return standard_fps(f);
    }
    *RATES.iter().min_by(|a, b| (*a - f).abs().total_cmp(&(*b - f).abs())).unwrap()
}

fn tint_arg(c: &Call) -> Result<Option<MarkerTint>, ToolError> {
    let Some(s) = string(c.args, "color") else { return Ok(None) };
    Ok(Some(match s {
        "white" => MarkerTint::White,
        "yellow" => MarkerTint::Yellow,
        "green" => MarkerTint::Green,
        "blue" => MarkerTint::Blue,
        "purple" => MarkerTint::Purple,
        "red" => MarkerTint::Red,
        _ => return Err("color is white, yellow, green, blue, purple, red.".into()),
    }))
}

fn set_marker(c: &Call) -> Out {
    let p = c.now();
    let tint = tint_arg(c)?;
    let time = num(c.args, "time").map(|t| p.snap_frame(t.max(0.0)));
    let label = string(c.args, "name").map(str::to_string);
    let id;
    if let Some(s) = string(c.args, "marker_id") {
        let m = s.parse::<Id>().ok().and_then(|i| p.marker_list().into_iter().find(|m| m.id == i)).ok_or_else(|| ToolError(format!("No marker {s}; get_project lists them.")))?;
        id = m.id;
        c.perform("Marker", Spot { time: time.or(Some(m.time)), ..Spot::none() }, |q| {
            if let Some(x) = q.markers.iter_mut().flatten().find(|x| x.id == m.id) {
                if let Some(t) = time {
                    x.time = t;
                }
                if let Some(l) = &label {
                    x.name = l.clone();
                }
                if let Some(t) = tint {
                    x.tint = t;
                }
            }
            Ok(())
        })?;
    } else {
        let time = time.ok_or("time is needed for a new marker.")?;
        let n = p.markers.as_ref().map(Vec::len).unwrap_or(0) + 1;
        let m = Marker { id: Id::new(), time, name: label.unwrap_or_else(|| format!("Marker {n}")), tint: tint.unwrap_or(MarkerTint::Yellow) };
        id = m.id;
        c.perform("Marker", Spot { time: Some(time), ..Spot::none() }, |q| {
            q.markers.get_or_insert_with(Vec::new).push(m);
            Ok(())
        })?;
    }
    let now = c.now();
    let m = now.marker_list().into_iter().find(|m| m.id == id).ok_or("The marker didn't stick.")?;
    Ok(json_text(json!({"id": json::id(m.id), "time": r3(m.time), "name": m.name, "color": json::tint_name(m.tint)})))
}

fn delete_markers(c: &Call) -> Out {
    let p = c.now();
    let ids: Ids = if boolean(c.args, "all") == Some(true) {
        p.marker_list().iter().map(|m| m.id).collect()
    } else {
        strings(c.args, "marker_ids").iter().filter_map(|s| s.parse().ok()).collect()
    };
    if ids.is_empty() {
        return Err("Give marker_ids, or all: true.".into());
    }
    let after = c.perform("Markers", Spot::none(), |q| {
        if let Some(ms) = q.markers.as_mut() {
            ms.retain(|m| !ids.contains(&m.id));
            if ms.is_empty() {
                q.markers = None;
            }
        }
        Ok(())
    })?;
    let n = after.marker_list().len();
    Ok(text(format!("{n} marker{} left.", if n == 1 { "" } else { "s" })))
}

fn set_in_out(c: &Call) -> Out {
    let p = c.now();
    if boolean(c.args, "clear") == Some(true) {
        c.perform("Clear in/out", Spot::none(), |q| {
            q.in_point = None;
            q.out_point = None;
            Ok(())
        })?;
        return Ok(text("No in/out range."));
    }
    let i = num(c.args, "in").map(|v| p.snap_frame(v.max(0.0)));
    let o = num(c.args, "out").map(|v| p.snap_frame(v.max(0.0)));
    if i.is_none() && o.is_none() {
        return Err("Give in and/or out, or clear: true.".into());
    }
    if let (Some(i), Some(o)) = (i, o)
        && o <= i
    {
        return Err("out has to be after in.".into());
    }
    let after = c.perform("In/out", Spot { time: i.or(o), ..Spot::none() }, |q| {
        if let Some(i) = i {
            q.in_point = Some(i);
            if q.out_point.is_some_and(|o| o <= i) {
                q.out_point = None;
            }
        }
        if let Some(o) = o {
            q.out_point = Some(o);
            if q.in_point.is_some_and(|i| i >= o) {
                q.in_point = None;
            }
        }
        Ok(())
    })?;
    let r = after.play_range();
    Ok(json_text(json!({"in": r.map(|r| r3(r.0)).unwrap_or(Value::Null), "out": r.map(|r| r3(r.1)).unwrap_or(Value::Null)})))
}

fn set_transform(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if !clip.is_transformable() {
        return Err(if clip.kind == ClipKind::Text { "Titles are placed with set_title_style." } else { "Sound has no picture to move." }.into());
    }
    let mut tf = if boolean(c.args, "reset") == Some(true) { ClipTransform::default() } else { clip.transform.unwrap_or_default() };
    let (lo, hi) = ClipTransform::SCALE_RANGE;
    if let Some(s) = num(c.args, "scale") {
        tf.scale = s.clamp(lo, hi);
    }
    if let Some(x) = num(c.args, "x") {
        tf.x = x.clamp(-2.0, 2.0);
    }
    if let Some(y) = num(c.args, "y") {
        tf.y = y.clamp(-2.0, 2.0);
    }
    // Zoom: from the full frame to this framing over the clip (as the Scale field's zoom button).
    if let Some(z) = string(c.args, "zoom") {
        match z {
            "off" => tf.zoom = None,
            "in" | "in_out" | "out" => {
                let mode = match z {
                    "in" => ZoomMode::ZoomIn,
                    "out" => ZoomMode::ZoomOut,
                    _ => ZoomMode::InOut,
                };
                let length = clip.duration;
                if num(c.args, "scale").is_none() && tf.scale <= 1.01 {
                    tf.scale = 2.0;
                }
                let mut mv = ZoomMove::starter(mode, length);
                let m = num(c.args, "zoom_seconds")
                    .map(|v| v.max(0.05).min(if mode == ZoomMode::InOut { length / 2.0 } else { length }))
                    .unwrap_or(if mv.p2 - mv.p1 > 0.0 { mv.p2 - mv.p1 } else { mv.p4 - mv.p3 });
                let start = num(c.args, "zoom_start");
                match mode {
                    ZoomMode::ZoomIn => {
                        mv.p1 = start.unwrap_or(0.0);
                        mv.p2 = mv.p1 + m;
                        mv.p3 = length;
                        mv.p4 = length;
                    }
                    ZoomMode::ZoomOut => {
                        mv.p1 = 0.0;
                        mv.p2 = 0.0;
                        mv.p3 = start.unwrap_or(length - m);
                        mv.p4 = mv.p3 + m;
                    }
                    ZoomMode::InOut => {
                        mv.p1 = start.unwrap_or(0.0);
                        mv.p2 = mv.p1 + m;
                        mv.p3 = mv.p2.max(length - m);
                        mv.p4 = length;
                    }
                }
                if let Some(s) = boolean(c.args, "zoom_smooth") {
                    mv.smooth = s;
                }
                mv.fit(length);
                tf.zoom = Some(mv);
            }
            _ => return Err("zoom is in, in_out, out or off.".into()),
        }
    } else if let Some(s) = boolean(c.args, "zoom_smooth")
        && let Some(z) = tf.zoom.as_mut()
    {
        z.smooth = s;
    }
    // A point to frame: the picture is moved so that point is centred (kept within its edges when it fills).
    if let Some(fx) = num(c.args, "focus_x") {
        tf.x = (-(fx.clamp(0.0, 1.0) - 0.5) * tf.scale).clamp(-2.0, 2.0);
    }
    if let Some(fy) = num(c.args, "focus_y") {
        tf.y = (-(fy.clamp(0.0, 1.0) - 0.5) * tf.scale).clamp(-2.0, 2.0);
    }
    if tf.fills() {
        (tf.x, tf.y) = tf.zoomed_offset();
    }
    let set = if tf.is_identity() { None } else { Some(tf) };
    let after = c.perform("Transform", Spot::clips(&p, &[clip.id]), |q| {
        apply_edit(q, Edit::Update { ids: vec![clip.id], patch: ClipPatch { transform: Some(set), ..Default::default() } });
        Ok(())
    })?;
    Ok(json_text(json::clips(&[clip.id], &after)))
}

/// Font families installed here, from the OS font folders (names as files carry them).
fn installed_font(name: &str) -> Option<String> {
    let mut dirs: Vec<std::path::PathBuf> = vec![];
    if cfg!(target_os = "macos") {
        dirs.extend(["/System/Library/Fonts", "/Library/Fonts"].map(std::path::PathBuf::from));
        if let Some(h) = dirs::home_dir() {
            dirs.push(h.join("Library/Fonts"));
        }
    } else if cfg!(windows) {
        dirs.push(std::path::PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into())).join("Fonts"));
        if let Some(l) = dirs::data_local_dir() {
            dirs.push(l.join("Microsoft\\Windows\\Fonts"));
        }
    } else {
        dirs.extend(["/usr/share/fonts", "/usr/local/share/fonts"].map(std::path::PathBuf::from));
    }
    let want: String = name.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    fn walk(d: &std::path::Path, want: &str, depth: u32) -> Option<()> {
        for e in std::fs::read_dir(d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() && depth < 3 {
                if walk(&p, want, depth + 1).is_some() {
                    return Some(());
                }
                continue;
            }
            let stem: String = p.file_stem()?.to_string_lossy().to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
            if stem == want || stem.starts_with(want) && stem[want.len()..].chars().all(|c| c.is_alphabetic()) && stem.len() <= want.len() + 12 {
                return Some(());
            }
        }
        None
    }
    dirs.iter().find_map(|d| walk(d, &want, 0)).map(|_| name.to_string())
}

fn set_title_style(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if clip.kind != ClipKind::Text {
        return Err("That clip isn't a title.".into());
    }
    let mut font = None;
    if let Some(f) = string(c.args, "font").map(str::trim) {
        font = Some(if f.is_empty() || f.eq_ignore_ascii_case("system") {
            String::new()
        } else {
            installed_font(f).ok_or_else(|| {
                ToolError(format!("{f} isn't installed {}. Try {}.", super::super::on_this(), super::super::defs::suggested_fonts()))
            })?
        });
    }
    let color = color_arg(c.args.get("color"))?;
    let words = string(c.args, "text").map(str::to_string);
    let size = num(c.args, "size").map(|v| v.clamp(12.0, 600.0));
    let bold = boolean(c.args, "bold");
    let x = num(c.args, "x").map(|v| v.clamp(0.0, 1.0));
    let y = num(c.args, "y").map(|v| v.clamp(0.0, 1.0));
    if font.is_none() && color.is_none() && words.is_none() && size.is_none() && bold.is_none() && x.is_none() && y.is_none() {
        return Err("Give at least one of text, font, size, bold, color, x, y.".into());
    }
    let mut style = clip.text.clone();
    if let Some(w) = words.clone() {
        style.string = w;
    }
    if let Some(f) = font {
        style.font_name = f;
    }
    if let Some(v) = color {
        style.color = v;
    }
    if let Some(v) = size {
        style.size = v;
    }
    if let Some(v) = bold {
        style.bold = v;
    }
    if let Some(v) = x {
        style.x = v;
    }
    if let Some(v) = y {
        style.y = v;
    }
    let label = words.unwrap_or_else(|| "Title style".into());
    let after = c.perform(&label, Spot::clips(&p, &[clip.id]), |q| {
        apply_edit(q, Edit::Update { ids: vec![clip.id], patch: ClipPatch { text: Some(style), ..Default::default() } });
        Ok(())
    })?;
    Ok(json_text(json::clips(&[clip.id], &after)))
}

fn freeze_frame(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if clip.kind != ClipKind::Video || clip.is_freeze() {
        return Err("Freeze frames are made from a video clip.".into());
    }
    let t = p.snap_frame(num(c.args, "at").unwrap_or(clip.start + clip.duration / 2.0));
    if !(t > clip.start && t < clip.end()) {
        return Err(format!("at has to be inside the clip ({}…{}).", r3(clip.start), r3(clip.end())).into());
    }
    let hold = num(c.args, "seconds").unwrap_or(2.0).max(1.0 / p.fps);
    let mut source = clip.source_time(t);
    if clip.plays_backwards()
        && let Some(l) = p.asset(clip.asset_id).map(|a| a.duration)
    {
        source = (l - source - 0.001).max(0.0);
    }
    let made = Id::new();
    let after = c.perform("Freeze", Spot::at(t, clip.track_id), |q| {
        let group = q.linked(&one(clip.id));
        q.split(&group, t);
        let tracks: Ids = q.clips.iter().filter(|x| group.contains(&x.id)).map(|x| x.track_id).collect();
        let later: Ids = q.clips.iter().filter(|x| tracks.contains(&x.track_id) && x.start >= t - 1e-6).map(|x| x.id).collect();
        let mut shifting = q.unlocked(&q.linked(&later));
        for x in q.clips.iter_mut().filter(|x| shifting.contains(&x.id)) {
            x.start += hold;
        }
        q.clips.push(Clip {
            id: made,
            track_id: clip.track_id,
            kind: ClipKind::Video,
            asset_id: clip.asset_id,
            start: t,
            duration: hold,
            source_start: source,
            freeze: Some(true),
            grade: clip.grade.clone(),
            transform: clip.transform,
            ..Clip::default()
        });
        shifting.insert(made);
        q.resolve_overlaps(&shifting);
        Ok(())
    })?;
    Ok(json_text(json::clips(&[made], &after)))
}

fn reverse_clip(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if !clip.plays_source() || clip.reversed_from.is_some() {
        return Err("Only video and sound from a file can be reversed.".into());
    }
    let group = p.unlocked(&p.linked(&one(clip.id)));
    let order = ordered(&p, &group);
    let label = if clip.plays_backwards() { "Forwards" } else { "Reverse" };
    // The engine makes reversed sound from the extracted PCM when the clip next plays.
    let after = c.perform(label, Spot::clips(&p, &[clip.id]), |q| {
        apply_edit(q, Edit::Reverse { selection: vec![clip.id] });
        Ok(())
    })?;
    Ok(json_text(json::clips(&order, &after)))
}

fn detach_audio(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if clip.link_id.is_none() {
        return Err("That clip isn't linked to anything.".into());
    }
    let group = p.linked(&one(clip.id));
    let order = ordered(&p, &group);
    let after = c.perform("Detach", Spot::clips(&p, &[clip.id]), |q| {
        apply_edit(q, Edit::DetachAudio { ids: order.clone() });
        Ok(())
    })?;
    Ok(json_text(json::clips(&order, &after)))
}

// Fresh random link ids, not `Id::default()` (the nil id), so the lint's suggestion would be wrong.
#[allow(clippy::unwrap_or_default)]
fn duplicate_clip(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    let linked = p.linked(&one(clip.id));
    let group: Vec<Clip> = p.clips.iter().filter(|x| linked.contains(&x.id)).cloned().collect();
    let t0 = group.iter().map(|x| x.start).fold(clip.start, f64::min);
    let at = p.snap_frame(num(c.args, "start").unwrap_or_else(|| group.iter().map(Clip::end).fold(clip.end(), f64::max)).max(0.0));
    let mut links: HashMap<Id, Id> = HashMap::new();
    let copies: Vec<Clip> = group
        .iter()
        .map(|o| {
            let mut n = o.clone();
            n.id = Id::new();
            n.link_id = o.link_id.map(|l| *links.entry(l).or_insert_with(Id::new));
            n.start = at + (o.start - t0);
            n
        })
        .collect();
    let ids: Vec<Id> = copies.iter().map(|x| x.id).collect();
    let after = c.perform("Place", Spot::at(at, clip.track_id), |q| {
        q.insert(copies);
        Ok(())
    })?;
    Ok(json_text(json::clips(&ids, &after)))
}

fn set_track(c: &Call) -> Out {
    let p = c.now();
    let tn = string(c.args, "track").ok_or("track is needed (V1, A1…).")?;
    let n = tn.trim().to_uppercase();
    let kind = if n.starts_with('V') { TrackKind::Video } else { TrackKind::Audio };
    let i = n.get(1..).and_then(|r| r.parse::<usize>().ok()).filter(|i| *i >= 1 && *i <= p.tracks(kind).len()).ok_or_else(|| ToolError(format!("There's no {tn}.")))?;
    let id = p.tracks(kind)[i - 1].id;
    let patch = TrackPatch {
        hidden: boolean(c.args, "hidden"),
        muted: boolean(c.args, "muted"),
        solo: boolean(c.args, "solo"),
        locked: boolean(c.args, "locked"),
        gain_db: num(c.args, "gain_db").map(|g| g.clamp(-60.0, 12.0)),
        ..Default::default()
    };
    if patch.hidden.is_none() && patch.muted.is_none() && patch.solo.is_none() && patch.locked.is_none() && patch.gain_db.is_none() {
        return Err("Give hidden, muted, solo, locked or gain_db.".into());
    }
    let after = c.perform("Track", Spot { track: Some(id), ..Spot::none() }, |q| {
        apply_edit(q, Edit::SetTrack { id, patch });
        Ok(())
    })?;
    let t: &Track = &after.tracks(kind)[i - 1];
    Ok(json_text(json!({"track": n, "hidden": t.hidden, "muted": t.muted, "solo": t.solo, "locked": t.locked, "gain_db": r3(t.gain_db)})))
}

fn add_solid(c: &Call) -> Out {
    let p = c.now();
    let color = color_arg(c.args.get("color"))?.unwrap_or(promptedit_core::Rgba::BLACK);
    let start = p.snap_frame(num(c.args, "start").unwrap_or(0.0).max(0.0));
    let length = p.snap_frame(num(c.args, "duration").unwrap_or(3.0).max(1.0 / p.fps));
    let named = match string(c.args, "track") {
        Some(n) => Some(track_arg(n, &p, TrackKind::Video)?),
        None => free_video_track(&p, start, length, false),
    };
    let solid = Clip { kind: ClipKind::Solid, start, duration: length, color, ..Clip::default() };
    let id = solid.id;
    let after = c.perform("Place", Spot::at(start, named.unwrap_or_default()), |q| {
        let mut s = solid;
        s.track_id = named.unwrap_or_else(|| new_video_track(q));
        q.insert(vec![s]);
        Ok(())
    })?;
    Ok(json_text(json::clips(&[id], &after)))
}

fn set_solid_color(c: &Call) -> Out {
    let p = c.now();
    let clip = clip_arg(c.args, &p)?;
    if clip.kind != ClipKind::Solid {
        return Err("That clip isn't a solid.".into());
    }
    let color = color_arg(c.args.get("color"))?.ok_or("color is needed, like #000000.")?;
    let after = c.perform("Colour", Spot::clips(&p, &[clip.id]), |q| {
        apply_edit(q, Edit::Update { ids: vec![clip.id], patch: ClipPatch { color: Some(color), ..Default::default() } });
        Ok(())
    })?;
    Ok(json_text(json::clips(&[clip.id], &after)))
}
