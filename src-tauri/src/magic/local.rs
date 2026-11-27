//! Local Magic (Editroom's `LocalMagic.run` and `MagicShow.start`): a cut made on this computer with
//! no AI service. An empty request improves the edit (or makes a new cut from the library); a typed
//! request goes through Editroom's router — pauses, zoom, title + captions together, captions, title,
//! speed ramps — and otherwise is read into a recipe (local model or keywords) for the improver or
//! the new-cut planner. The result goes onto the timeline as one undo step.
//!
//! Not ported yet: `LocalAdd` (adding shots to an existing edit) and `LocalPointed` (reordering and
//! editing the selection/range by name); requests for those fall through to the recipe.

use super::analyzer::{self, ClipAnalysis, MusicAnalysis};
use super::mentions::{self, Mention, Pointers};
use super::plan::{Step, applied};
use super::recipe::{self, Frame, Music, Recipe};
use super::{improver, planner};
use crate::mcp::host::Host;
use crate::mcp::providers;
use promptedit_core::project::Ids;
use promptedit_core::{ClipKind, ClipTransform, Id, MediaAsset, MediaKind, Project, TrackKind, ZoomMode, ZoomMove};
use std::collections::{HashMap, HashSet};

/// What a Local run did, for the note under the Magic button.
pub struct Done {
    pub text: String,
    pub changed: bool,
}

/// Progress for the Magic button ("Analyzing 2 of 5"), and whether the run was stopped.
pub trait Progress {
    fn status(&self, s: Option<&str>);
    fn stopped(&self) -> bool;
}

struct Quiet;
impl Progress for Quiet {
    fn status(&self, _: Option<&str>) {}
    fn stopped(&self) -> bool {
        false
    }
}

fn has(t: &str, w: &[&str]) -> bool {
    w.iter().any(|x| t.contains(x))
}

/// Lays a finished project onto the document as one undo step (keeping library changes made meanwhile).
fn commit(host: &dyn Host, base: &Project, done: &Project) -> bool {
    let changed = {
        let mut doc = host.state().doc.lock().unwrap();
        let now = doc.project.clone();
        doc.mutate(|p| *p = crate::mcp::draft::merged(base, done, &now))
    };
    if changed {
        host.project_changed();
    }
    changed
}

/// The `auto_edit` tool: Local Magic with an empty request.
pub fn auto_edit(host: &dyn Host) -> Result<(), String> {
    let base = host.state().doc.lock().unwrap().project.clone();
    let d = auto(host, &base, &Recipe::default(), &Quiet)?;
    if !d.changed {
        return Err(d.text);
    }
    Ok(())
}

pub fn run(host: &dyn Host, typed_with_markers: &str, pointers: &Pointers, progress: &dyn Progress) -> Result<Done, String> {
    let base = host.state().doc.lock().unwrap().project.clone();
    // Markers named with @ are read as their times ("from @Jump to @Landing").
    let typed = mentions::markers_as_times(typed_with_markers, &base);
    let pointed: HashSet<Id> =
        mentions::find(&typed, &base.assets, &[], &[]).into_iter().filter_map(|(_, m)| if let Mention::Media(id) = m { Some(id) } else { None }).collect();
    let request = mentions::plain(&typed, &base);
    if request.trim().is_empty() {
        return auto(host, &base, &Recipe::default(), progress);
    }
    progress.status(Some("Reading your request"));
    let one = |steps: Vec<Step>, said: String| -> Result<Done, String> {
        if steps.is_empty() {
            return Ok(Done { text: said, changed: false });
        }
        let done = applied(&base, &steps);
        let changed = commit(host, &base, &done);
        Ok(Done { text: said, changed })
    };
    if speech_asks(&request) {
        let (steps, said) = speech(&base, &typed, pointers);
        return one(steps, said);
    }
    if zoom_asks(&request) {
        let (steps, said) = zoom(&typed, pointers, &base);
        return one(steps, said);
    }
    // More than one thing asked (a title and captions): each in turn on the result of the last.
    let wants_title = title_asks(&request, &base);
    let wants_captions = captions_asks(&request, &base);
    if wants_title && wants_captions {
        let (s1, t1) = title(&request, pointers.playhead, &base);
        let mid = applied(&base, &s1);
        let (s2, t2) = captions(&request, pointers, &mid);
        let mut steps = s1;
        steps.extend(s2);
        return one(steps, format!("{t1} {t2}"));
    }
    if wants_captions {
        let (steps, said) = captions(&request, pointers, &base);
        return one(steps, said);
    }
    if wants_title {
        let (steps, said) = title(&request, pointers.playhead, &base);
        return one(steps, said);
    }
    if ramp_asks(&request) {
        let (steps, said) = ramp(&typed, pointers, &base);
        return one(steps, said);
    }
    let has_edit = base.clips.iter().any(|c| matches!(c.kind, ClipKind::Video | ClipKind::Image));
    let (mut r, _model) = recipe::recipe(&request, &base, &pointed, has_edit)?;
    if progress.stopped() {
        return Ok(Done { text: String::new(), changed: false });
    }
    r.speed = recipe::speed(&request);
    r.sound_effects = recipe::wants_sound_effects(&request);
    r.asked_judgement = recipe::asks_judgement(&request);
    r.title = recipe::title_asked(&request);
    r.title_at_end = title_at_end(&request);
    r.whole_library = recipe::wants_library(&request);
    r.shots = recipe::shot_count(&request);
    r.every = recipe::wants_every(&request);
    if r.every {
        r.whole_library = true;
    }
    let drop_cannot = |r: &mut Recipe, words: &[&str]| {
        r.cannot_do = r.cannot_do.split(',').map(str::trim).filter(|p| !p.is_empty() && !words.iter().any(|w| p.to_lowercase().contains(w))).collect::<Vec<_>>().join(", ");
    };
    if r.title.is_some() {
        drop_cannot(&mut r, &["title", "text", "caption", "heading", "name"]);
    }
    let captions_after = captions_wanted_with_cut(&request);
    if captions_after {
        drop_cannot(&mut r, &["caption", "subtitle"]);
    }
    if recipe::wants_levels(&request) {
        r.level_audio = true;
        let clips: Vec<&promptedit_core::Clip> =
            base.clips.iter().filter(|c| c.kind == ClipKind::Audio && !base.is_locked(c.track_id) && base.track(c.track_id).is_none_or(|t| !t.muted)).collect();
        r.level_gains = level_gains(&base, &clips);
        let mut silent: Vec<String> = clips.iter().filter(|c| !r.level_gains.contains_key(&c.id)).filter_map(|c| base.asset(c.asset_id).map(|a| a.name.clone())).collect();
        silent.sort();
        silent.dedup();
        r.level_silent = silent;
        drop_cannot(&mut r, &["level", "volume", "loud", "equaliz", "equalis", "normaliz", "normalis", "balance", "db", "gain", "audio"]);
    }
    if r.sound_effects {
        drop_cannot(&mut r, &["sound", "sfx", "effect", "whoosh"]);
    }
    if r.speed.is_some() {
        drop_cannot(&mut r, &["speed", "fast", "slow", "%"]);
    }
    // Asked for something specific: do just that, not the general clean-up as well.
    r.only_asked = !recipe::is_general(&request);
    // Nothing in it Local can do (and it isn't just "make it better"): say so, edit nothing.
    if r.is_empty() && !recipe::is_general(&request) {
        let what = if r.cannot_do.is_empty() { "that".to_string() } else { r.cannot_do.clone() };
        let question = request.contains('?') && r.cannot_do.is_empty();
        let text = if question {
            "Local only edits your video, so it left it as it was. To ask a question, use Claude or ChatGPT.".to_string()
        } else {
            format!("Local can't do {what}. It can change the length, the pace, the look, the music, the frame shape (vertical, square), and which files to use or take out, by name. For anything that needs understanding what's in your shots, use Claude or ChatGPT.")
        };
        return Ok(Done { text, changed: false });
    }
    let mut d = auto(host, &base, &r, progress)?;
    // Captions on the new cut, in the same undo step.
    if captions_after && d.changed {
        let now = host.state().doc.lock().unwrap().project.clone();
        let (steps, said) = captions(&request, &Pointers::default(), &now);
        if !steps.is_empty() {
            let changed = host.state().doc.lock().unwrap().amend_last_step(|p| *p = applied(&now, &steps));
            if changed {
                host.project_changed();
            }
            d.text = format!("{} {said}", d.text);
        }
    }
    Ok(d)
}

/// Studies the media and makes the cut (MagicShow.start).
fn auto(host: &dyn Host, base: &Project, r: &Recipe, progress: &dyn Progress) -> Result<Done, String> {
    let offline = |a: &MediaAsset| !std::path::Path::new(&a.path).exists() && a.playable_path.as_ref().is_none_or(|p| !std::path::Path::new(p).exists());
    // With an edit on the timeline, Magic improves that edit rather than starting over, unless they
    // asked for the whole library.
    let on_timeline: HashSet<Id> = base.clips.iter().filter(|c| matches!(c.kind, ClipKind::Video | ClipKind::Image)).filter_map(|c| c.asset_id).collect();
    let improving = !on_timeline.is_empty() && !r.whole_library;
    let visuals: Vec<MediaAsset> = base
        .assets
        .iter()
        .filter(|a| {
            !offline(a)
                && (a.kind == MediaKind::Image || (a.kind == MediaKind::Video && a.duration >= 1.0))
                && (!improving || on_timeline.contains(&a.id))
                && (r.keep_only.is_empty() || r.keep_only.contains(&a.id))
                && !r.take_out.contains(&a.id)
        })
        .cloned()
        .collect();
    if visuals.is_empty() {
        if r.is_focused() && !r.media_names.is_empty() {
            let n = r.media_names.len();
            return Ok(Done {
                text: format!("{} {} in your {}, so there was nothing to keep.", r.media_names.join(", "), if n == 1 { "isn't" } else { "aren't" }, if improving { "edit" } else { "Media" }),
                changed: false,
            });
        }
        return Ok(Done { text: "Magic couldn't find anything to make a cut from. Import some videos or photos first.".into(), changed: false });
    }
    // The song: the one the edit uses, or (for a new cut) the longest in the library (8 s or more).
    let song_on_timeline = base
        .clips
        .iter()
        .filter(|c| c.kind == ClipKind::Audio && c.link_id.is_none())
        .filter_map(|c| base.asset(c.asset_id).filter(|a| a.kind == MediaKind::Audio && a.duration >= 8.0))
        .max_by(|a, b| a.duration.total_cmp(&b.duration))
        .cloned();
    let library_song = base.assets.iter().filter(|a| a.kind == MediaKind::Audio && !offline(a) && a.duration >= 8.0).max_by(|a, b| a.duration.total_cmp(&b.duration)).cloned();
    let new_song = (improving && r.music == Music::Add && song_on_timeline.is_none()).then(|| library_song.clone()).flatten();
    let song = if r.music == Music::Off {
        None
    } else if improving {
        new_song.clone().or(song_on_timeline.clone().filter(|s| !offline(s)))
    } else {
        library_song
    };
    // Analyzing, with progress on the button.
    let total = visuals.len() + usize::from(song.is_some());
    let mut clips: Vec<(MediaAsset, ClipAnalysis)> = vec![];
    for (i, a) in visuals.iter().enumerate() {
        if progress.stopped() {
            return Ok(Done { text: String::new(), changed: false });
        }
        progress.status(Some(&format!("Analyzing {} of {total}", i + 1)));
        if let Some(x) = analyzer::clip(a) {
            clips.push((a.clone(), x));
        }
    }
    let music: Option<(MediaAsset, MusicAnalysis)> = song.as_ref().and_then(|s| {
        progress.status(Some(&format!("Analyzing {total} of {total}")));
        analyzer::music(s).map(|m| (s.clone(), m))
    });
    progress.status(None);
    if progress.stopped() {
        return Ok(Done { text: String::new(), changed: false });
    }
    let mut notes: Vec<String> = if r.cannot_do.is_empty() { vec![] } else { vec![r.cannot_do.clone()] };
    let (done, mut said) = if improving {
        let analyses: HashMap<Id, ClipAnalysis> = clips.iter().map(|(a, x)| (a.id, x.clone())).collect();
        match improver::plan(base, &analyses, music.as_ref().map(|m| &m.1), r, new_song.as_ref()) {
            Some(o) => {
                let said = match &o.message {
                    Some(m) => m.clone(),
                    None if o.focused => capitalized(&o.summary) + ".",
                    None => format!("Improved your edit: {}.", o.summary),
                };
                if o.message.is_none() {
                    notes.extend(o.notes);
                }
                ((!o.steps.is_empty()).then(|| applied(base, &o.steps)), said)
            }
            None => (None, "Your edit already looks good; nothing to change.".to_string()),
        }
    } else {
        let decision = planner::decide(&clips, music.as_ref().map(|(a, m)| (a, m)), r);
        match decision {
            Some(d) => {
                let length: f64 = d.shots.iter().map(|s| s.duration).sum();
                let said = made_note(&d, length, r);
                if let Some(s) = r.seconds
                    && length < s - 1.0
                {
                    notes.push(format!("your Media only had enough good footage for about {} seconds", length.round() as i64));
                }
                if r.every {
                    let used: HashSet<Id> = d.shots.iter().map(|s| s.asset.id).collect();
                    if used.len() < clips.len() {
                        notes.push(format!("{} of your clips were too short to use", clips.len() - used.len()));
                    }
                }
                let mut p = planner::build(base, &d);
                // The frame shape they asked for, from the start.
                if let (Some(q), Some((w, h))) = (p.as_mut(), frame_size(r.frame)) {
                    q.width = w;
                    q.height = h;
                    q.settings_locked = true;
                }
                (p, said)
            }
            None => (None, "Magic couldn't find anything to make a cut from.".to_string()),
        }
    };
    if !notes.is_empty() {
        said += &format!(" It couldn't do everything you asked: {}.", notes.join("; "));
    }
    let Some(done) = done else { return Ok(Done { text: said, changed: false }) };
    let changed = commit(host, base, &done);
    Ok(Done { text: said, changed })
}

fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn frame_size(f: Frame) -> Option<(i64, i64)> {
    match f {
        Frame::Vertical => Some((1080, 1920)),
        Frame::Horizontal => Some((1920, 1080)),
        Frame::Square => Some((1080, 1080)),
        Frame::Unchanged => None,
    }
}

fn made_note(d: &planner::Decision, length: f64, r: &Recipe) -> String {
    let mut names: Vec<String> = vec![];
    for s in &d.shots {
        if !names.contains(&s.asset.name) {
            names.push(s.asset.name.clone());
        }
    }
    let of = if r.asked.is_empty() { String::new() } else { format!(" of {}{}", if r.asked.starts_with("the ") { "" } else { "the " }, r.asked) };
    let n = d.shots.len();
    let clips = if n == 1 { "1 clip".to_string() } else { format!("{n} clips") };
    let from = if names.len() == 1 {
        format!(" from {}", names[0])
    } else if names.len() <= 3 || ((!r.asked.is_empty() || !r.keep_only.is_empty()) && names.len() <= 5) {
        format!(" from {} and {}", names[..names.len() - 1].join(", "), names[names.len() - 1])
    } else {
        let videos = if d.shots.iter().all(|s| s.asset.kind == MediaKind::Video) { "videos" } else { "files" };
        format!(" from {} {videos} in your Media", names.len())
    };
    format!("Made a {:.0}-second cut{of}: {clips}{from}{}.", length, if d.music.is_none() { "" } else { ", cut to the beat" })
}

/// Each audio clip's gain so they all read the same on the output meters (Editroom's
/// `levelGains(matchOutput:)`): the median output level, never louder than 1 dB under the peak.
fn level_gains(p: &Project, clips: &[&promptedit_core::Clip]) -> HashMap<Id, f64> {
    let mut measured = vec![];
    for c in clips {
        let Some(a) = p.asset(c.asset_id) else { continue };
        let Some((level, peak)) = clip_levels(a, c.source_start, c.source_length()) else { continue };
        let track = p.track(c.track_id).map(|t| t.gain_db).unwrap_or(0.0);
        measured.push((c.id, c.gain_db, level, peak, track));
    }
    if measured.is_empty() {
        return HashMap::new();
    }
    let mut outputs: Vec<f64> = measured.iter().map(|m| m.2 + m.1 + m.4).collect();
    outputs.sort_by(f64::total_cmp);
    let n = outputs.len();
    let target = if n % 2 == 1 { outputs[n / 2] } else { (outputs[n / 2 - 1] + outputs[n / 2]) / 2.0 };
    measured
        .into_iter()
        .map(|(id, _, level, peak, track)| {
            let g = (target - level - track).min(-1.0 - peak - track);
            (id, ((g * 10.0).round() / 10.0).clamp(-24.0, 12.0))
        })
        .collect()
}

/// A stretch of a file's sound: its level (RMS of the loud half of 50 ms windows) and peak, in dB.
/// Silence gives None. (Editroom measures its waveform envelope; this is the same idea on the PCM.)
fn clip_levels(a: &MediaAsset, from: f64, length: f64) -> Option<(f64, f64)> {
    let path = if std::path::Path::new(&a.path).exists() { a.path.clone() } else { a.playable_path.clone()? };
    let pcm = analyzer::read_mono(std::path::Path::new(&path), 22050)?;
    let (s, e) = ((from * 22050.0) as usize, (((from + length) * 22050.0) as usize).min(pcm.len()));
    let part = pcm.get(s..e)?;
    let peak = part.iter().fold(0f32, |m, v| m.max(v.abs())) as f64;
    if peak < 1e-4 {
        return None;
    }
    let mut windows: Vec<f64> = part.chunks(1102).map(|w| (w.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / w.len() as f64).sqrt()).collect();
    windows.sort_by(|a, b| b.total_cmp(a));
    let loud = &windows[..windows.len().div_ceil(2)];
    let rms = (loud.iter().map(|v| v * v).sum::<f64>() / loud.len() as f64).sqrt();
    Some((20.0 * rms.max(1e-9).log10(), 20.0 * peak.log10()))
}

// MARK: The router's planners

fn speech_asks(request: &str) -> bool {
    has(&request.to_lowercase(), &["dead space", "dead air", "pause", "silence", "silent", " um", "ums", "uhs", "filler", "jump cut", "jumpcut", "tighten the talk", "tighten the speech", "tighten what"])
}

/// Cuts the pauses in what's said (Editroom's `LocalSpeech`), from transcripts.
fn speech(p: &Project, typed: &str, ptr: &Pointers) -> (Vec<Step>, String) {
    const JOIN: f64 = 0.45;
    const KEEP_BEFORE: f64 = 0.12;
    const KEEP_AFTER: f64 = 0.2;
    const SHORTEST: f64 = 0.3;
    if !providers::transcripts_available() {
        return (vec![], format!("Cutting pauses needs speech recognition, which isn't set up in {} {} yet.", crate::mcp::APP_NAME, crate::mcp::on_this()));
    }
    let Some(track) = p.video_tracks.iter().find(|t| p.clips.iter().any(|c| c.track_id == t.id && c.kind == ClipKind::Video)) else {
        return (vec![], "There are no video shots on the timeline.".into());
    };
    if track.locked {
        return (vec![], "The main video track is locked, so nothing was changed.".into());
    }
    let found = mentions::find(typed, &p.assets, &mentions::clip_labels(p), &[]);
    let mut only: HashSet<Id> = found.iter().filter_map(|(_, m)| if let Mention::Clip(id) = m { Some(*id) } else { None }).collect();
    if found.iter().any(|f| f.1 == Mention::Selected) || typed.to_lowercase().contains("selected") {
        only.extend(ptr.selected.iter().copied());
    }
    let mut shots: Vec<&promptedit_core::Clip> = p.clips.iter().filter(|c| c.track_id == track.id && c.kind == ClipKind::Video && (only.is_empty() || only.contains(&c.id))).collect();
    shots.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut cuts: Vec<(f64, f64)> = vec![];
    let (mut talking, mut unheard) = (0, 0);
    for c in &shots {
        let Some(a) = p.asset(c.asset_id) else { continue };
        let Some(t) = providers::transcript_ready(a) else {
            unheard += 1;
            continue;
        };
        if (c.speed - 1.0).abs() > 1e-3 || c.is_reversed() {
            continue;
        }
        let (s0, s1) = (c.source_start, c.source_start + c.duration);
        let talk: Vec<(f64, f64)> = t.speech(JOIN).into_iter().filter(|s| s.1 > s0 && s.0 < s1).collect();
        if talk.is_empty() {
            continue;
        }
        talking += 1;
        let mut keep: Vec<(f64, f64)> = vec![];
        for s in talk {
            let (a, b) = ((s.0 - KEEP_BEFORE).max(s0), (s.1 + KEEP_AFTER).min(s1));
            match keep.last_mut() {
                Some(l) if a <= l.1 => l.1 = l.1.max(b),
                _ => keep.push((a, b)),
            }
        }
        let mut at = s0;
        for (a, b) in keep {
            if a - at >= SHORTEST {
                cuts.push((c.start + (at - s0), c.start + (a - s0)));
            }
            at = b;
        }
        if s1 - at >= SHORTEST {
            cuts.push((c.start + (at - s0), c.start + (s1 - s0)));
        }
    }
    if talking == 0 {
        return (
            vec![],
            if unheard > 0 {
                format!("{} is still listening to your clips. Try again in a moment.", crate::mcp::APP_NAME)
            } else {
                format!("Nobody talks in {}, so there were no pauses to cut.", if only.is_empty() { "the edit" } else { "those clips" })
            },
        );
    }
    if cuts.is_empty() {
        return (vec![], "The talking is already tight: no pauses long enough to cut.".into());
    }
    let total: f64 = cuts.iter().map(|c| c.1 - c.0).sum();
    // The main picture track and its shots' own sound: cut together, so picture and sound stay in sync.
    let links: HashSet<Id> = p.clips.iter().filter(|c| c.track_id == track.id).filter_map(|c| c.link_id).collect();
    let mut tracks: Ids = p.clips.iter().filter(|c| c.track_id != track.id && c.link_id.is_some_and(|l| links.contains(&l))).map(|c| c.track_id).collect();
    tracks.insert(track.id);
    tracks.retain(|t| !p.is_locked(*t));
    let n = cuts.len();
    let said = format!("Cut {n} pause{} ({total:.1} seconds) from {talking} shot{} with talking.", if n == 1 { "" } else { "s" }, if talking == 1 { "" } else { "s" });
    (vec![Step::RippleCuts { cuts, tracks: tracks.into_iter().collect() }], said)
}

fn zoom_asks(request: &str) -> bool {
    has(&request.to_lowercase(), &["zoom", "push in", "punch in", "push-in", "punch-in", "ken burns"])
}

fn pointed_clips(typed: &str, ptr: &Pointers, p: &Project) -> HashSet<Id> {
    let t = typed.to_lowercase();
    let found = mentions::find(typed, &p.assets, &mentions::clip_labels(p), &[]);
    let mut pointed: HashSet<Id> = found.iter().filter_map(|(_, m)| if let Mention::Clip(id) = m { Some(*id) } else { None }).collect();
    if found.iter().any(|f| f.1 == Mention::Selected) || t.contains("selected") || pointed.is_empty() {
        pointed.extend(ptr.selected.iter().copied());
    }
    pointed
}

/// A zoom on the shots pointed at, or the top one under the playhead (Editroom's `LocalZoom`).
fn zoom(typed: &str, ptr: &Pointers, p: &Project) -> (Vec<Step>, String) {
    let t = format!(" {} ", typed.to_lowercase());
    let pointed = pointed_clips(typed, ptr, p);
    let mut targets: Vec<&promptedit_core::Clip> = p.clips.iter().filter(|c| pointed.contains(&c.id) && c.is_transformable() && !p.is_locked(c.track_id)).collect();
    if targets.is_empty() {
        let under: Vec<&promptedit_core::Clip> = p.clips.iter().filter(|c| c.is_transformable() && !p.is_locked(c.track_id) && ptr.playhead >= c.start && ptr.playhead < c.end()).collect();
        if let Some(top) = p.video_tracks.iter().rev().find_map(|tr| under.iter().find(|c| c.track_id == tr.id)) {
            targets = vec![top];
        }
    }
    if targets.is_empty() {
        return (vec![], "Select a clip, or put the playhead on one, to zoom.".into());
    }
    let off = has(&t, &[" remove", " take off", " turn off", " no zoom", " without zoom", " stop zoom", " get rid of", " undo the zoom"]);
    let mode = if has(&t, &[" in and out", " in & out", " in/out", " in then out", " in, then out", " back out"]) {
        ZoomMode::InOut
    } else if has(&t, &["zoom out", "zoom-out", "pull out", "pull back"]) {
        ZoomMode::ZoomOut
    } else {
        ZoomMode::ZoomIn
    };
    let even = has(&t, &[" linear", " steady", " even pace", " constant"]);
    let amount = regex::Regex::new(r"(\d+(\.\d+)?)\s*[x×]").unwrap().captures(&t).and_then(|c| c[1].parse::<f64>().ok()).filter(|v| *v > 1.0 && *v <= 10.0).or_else(|| {
        regex::Regex::new(r"(\d+)\s*%").unwrap().captures(&t).and_then(|c| c[1].parse::<f64>().ok()).filter(|v| *v > 100.0 && *v <= 1000.0).map(|v| v / 100.0)
    });
    let steps: Vec<Step> = targets
        .iter()
        .map(|c| {
            let mut tf = c.transform.unwrap_or_default();
            if off {
                tf.zoom = None;
            } else {
                if let Some(a) = amount {
                    tf.scale = a;
                } else if tf.scale <= 1.01 {
                    tf.scale = 2.0;
                }
                let mut mv = ZoomMove::starter(mode, c.duration);
                mv.smooth = !even;
                tf.zoom = Some(mv);
                if tf.fills() {
                    (tf.x, tf.y) = tf.zoomed_offset();
                }
            }
            Step::Zoom { id: c.id, transform: (!tf.is_identity()).then_some(tf) }
        })
        .collect();
    let n = targets.len();
    let shots = if n == 1 { "the shot".to_string() } else { format!("{n} shots") };
    let said = if off {
        format!("Took the zoom off {shots}.")
    } else {
        let how = match mode {
            ZoomMode::ZoomIn => "Zooms in on",
            ZoomMode::ZoomOut => "Zooms out of",
            ZoomMode::InOut => "Zooms in and back out on",
        };
        format!("{how} {shots}{}. Change it with the zoom button on Scale.", if even { " at a steady pace" } else { "" })
    };
    let _ = ClipTransform::default();
    (steps, said)
}

fn new_cut(request: &str) -> bool {
    let t = request.to_lowercase();
    has(&t, &["new cut", "new edit", "new video", "montage", "recut", "re-cut", "from scratch", "start over"])
        || recipe::wants_library(request)
        || (has(&t, &["make a", "make an", "make me", "create", "build a", "cut a", "edit a"]) && has(&t, &["video", "cut", "edit", "montage", "reel", "recap", "vlog", "movie", "film"]))
}

fn title_asks(request: &str, p: &Project) -> bool {
    p.clips.iter().any(|c| matches!(c.kind, ClipKind::Video | ClipKind::Image)) && !new_cut(request) && recipe::title_asked(request).is_some()
}

pub fn title_at_end(request: &str) -> bool {
    has(
        &request.to_lowercase(),
        &["at the end", "the end", "at end", "in the end", "to the end", "end of", "ending", "end screen", "end card", "end title", "outro", "closing", "at the close", "last shot", "at the finish", "final shot", "finale"],
    )
}

/// A title on the edit that's there: at the start, the end, the playhead or a typed time (`LocalTitle`).
fn title(request: &str, playhead: f64, p: &Project) -> (Vec<Step>, String) {
    let edit: Vec<&promptedit_core::Clip> = p.clips.iter().filter(|c| matches!(c.kind, ClipKind::Video | ClipKind::Image)).collect();
    let (Some(first), Some(last)) = (edit.iter().map(|c| c.start).reduce(f64::min), edit.iter().map(|c| c.end()).reduce(f64::max)) else {
        return (vec![], "There's no edit on the timeline to put a title on.".into());
    };
    let t = request.to_lowercase();
    let length = ((last - first) * 0.25).clamp(1.0, 3.0);
    let typed = mentions::span(request, p.fps).is_none().then(|| mentions::times(request, p.fps).into_iter().find(|x| !x.unit_only)).flatten();
    let (start, place) = if let Some(at) = typed {
        let s = at.seconds.max(first).min((last - length).max(first));
        (s, format!("at {}", mentions::clock(s)))
    } else if title_at_end(request) {
        ((last - length).max(first), format!("over the last {} seconds", length.round() as i64))
    } else if has(&t, &["playhead", "here", "right now", "this point"]) {
        (playhead.max(first).min((last - length).max(first)), "at the playhead".into())
    } else {
        (first, "at the start".into())
    };
    let words = recipe::title_asked(request).filter(|w| !w.is_empty()).unwrap_or_else(|| "Title".into());
    let (s, d) = (p.snap_frame(start), p.snap_frame(length));
    let mut steps = vec![];
    let track = match p.video_tracks.iter().skip(1).find(|tr| !tr.locked && !p.clips.iter().any(|c| c.track_id == tr.id && c.start < s + d && c.end() > s)) {
        Some(tr) => tr.id,
        None => {
            let id = Id::new();
            steps.push(Step::AddTrack { kind: TrackKind::Video, id });
            id
        }
    };
    let mut clip = promptedit_core::Clip { track_id: track, kind: ClipKind::Text, start: s, duration: d, ..Default::default() };
    clip.text.string = words.clone();
    clip.text.size = 130.0;
    let id = clip.id;
    steps.push(Step::Place { clips: vec![clip] });
    steps.push(Step::FadeIn { id, to: 0.4 });
    steps.push(Step::FadeOut { id, to: 0.5 });
    (steps, format!("Added a title, \u{201C}{words}\u{201D}, {place}."))
}

fn captions_removes(request: &str) -> bool {
    has(&request.to_lowercase(), &["remove", "delete", "take off", "take away", "get rid", "no caption", "no subtitle", "without caption", "without subtitle", "turn off", "hide the caption", "hide caption"])
}

fn captions_asks(request: &str, p: &Project) -> bool {
    let t = request.to_lowercase();
    if !has(&t, &["caption", "subtitle", "closed caption", "transcribe the", "words on screen as they talk"]) {
        return false;
    }
    if recipe::quoted_words(request).is_some() || new_cut(request) {
        return false;
    }
    captions_removes(request) || p.clips.iter().any(|c| c.kind == ClipKind::Audio)
}

fn captions_wanted_with_cut(request: &str) -> bool {
    let t = request.to_lowercase();
    has(&t, &["caption", "subtitle"]) && !captions_removes(request) && recipe::quoted_words(request).is_none()
}

/// Adds or removes the caption track (`LocalCaptions`).
fn captions(request: &str, ptr: &Pointers, p: &Project) -> (Vec<Step>, String) {
    if captions_removes(request) {
        if p.captions.is_none() {
            return (vec![], "There are no captions to remove.".into());
        }
        return (vec![Step::Captions { ids: vec![], remove: true }], "Removed the captions.".into());
    }
    if !providers::transcripts_available() {
        return (vec![], format!("Captions need speech recognition, which isn't set up in {} {} yet.", crate::mcp::APP_NAME, crate::mcp::on_this()));
    }
    let sel: Vec<Id> = ptr.selected.clone();
    let mut probe = p.clone();
    crate::mcp::tools::apply_edit(&mut probe, promptedit_core::edit::Edit::AddCaptions { ids: sel.clone() });
    let targets: Vec<&promptedit_core::Clip> = probe.clips.iter().filter(|c| c.captioned == Some(true) && p.clip(c.id).is_some_and(|o| o.captioned != Some(true))).collect();
    if targets.is_empty() {
        return (vec![], "There's no one talking to caption. Pick a clip with sound and ask again.".into());
    }
    let heard = targets.iter().filter_map(|c| p.asset(c.asset_id)).filter_map(providers::transcript_ready).filter(|t| !t.is_empty()).count();
    let n = targets.len();
    let said = if heard == 0 {
        format!("Added a caption track, but no speech was heard in {}.", if n == 1 { "that clip" } else { "those clips" })
    } else {
        "Captioned what's said on the caption track.".to_string()
    };
    (vec![Step::Captions { ids: sel, remove: false }], said)
}

fn ramp_asks(request: &str) -> bool {
    let t = request.to_lowercase();
    t.contains("ramp") || has(&t, &["slow-mo moment", "slow mo moment", "slowmo moment", "slow motion moment", "slow-motion moment"])
}

/// Speed ramps: into and out of the cuts, or a slow-motion moment (`LocalRamp`).
fn ramp(typed: &str, ptr: &Pointers, p: &Project) -> (Vec<Step>, String) {
    let t = typed.to_lowercase();
    let Some(track) = p.video_tracks.iter().find(|tr| p.clips.iter().any(|c| c.track_id == tr.id && c.kind == ClipKind::Video)) else {
        return (vec![], "There are no video shots on the timeline.".into());
    };
    let mut shots: Vec<&promptedit_core::Clip> = p.clips.iter().filter(|c| c.track_id == track.id && c.kind == ClipKind::Video && c.plays_source() && !track.locked).collect();
    shots.sort_by(|a, b| a.start.total_cmp(&b.start));
    if shots.is_empty() {
        return (vec![], "The main video track is locked, so nothing was changed.".into());
    }
    let found = mentions::find(typed, &p.assets, &mentions::clip_labels(p), &[]);
    let mut pointed: HashSet<Id> = found.iter().filter_map(|(_, m)| if let Mention::Clip(id) = m { Some(*id) } else { None }).collect();
    if found.iter().any(|f| f.1 == Mention::Selected) || t.contains("selected") || pointed.is_empty() {
        pointed.extend(ptr.selected.iter().copied());
    }
    let mut chosen: Vec<&promptedit_core::Clip> = p.clips.iter().filter(|c| pointed.contains(&c.id) && c.kind == ClipKind::Video && c.plays_source() && !p.is_locked(c.track_id)).collect();
    chosen.sort_by(|a, b| a.start.total_cmp(&b.start));
    let asked = recipe::speed(typed);
    let ids_of = |id: Id| -> Vec<Id> {
        let s = p.unlocked(&p.linked(&[id].into_iter().collect()));
        p.clips.iter().filter(|c| s.contains(&c.id)).map(|c| c.id).collect()
    };
    let at_cuts = has(&t, &["cut", "transition", "between", "into each", "into the next", "whip"]);
    let mut steps = vec![];
    if at_cuts {
        let fast = asked.map(|a| if a > 1.0 { a } else { 4.0 }).unwrap_or(4.0);
        let set = if chosen.len() >= 2 { chosen.clone() } else { shots.clone() };
        let mut cuts = 0;
        for (i, c) in set.iter().enumerate() {
            let before = i > 0 && (set[i - 1].end() - c.start).abs() < 0.5 / p.fps;
            let after = i + 1 < set.len() && (set[i + 1].start - c.end()).abs() < 0.5 / p.fps;
            if !(before || after) {
                continue;
            }
            if after {
                cuts += 1;
            }
            let points = (0.0, if before { 0.25 } else { 0.0 }, if after { 0.75 } else { 1.0 }, 1.0);
            steps.push(Step::Ramp { ids: ids_of(c.id), speed: c.speed, points, around: fast });
        }
        if steps.is_empty() {
            return (vec![], "There are no cuts between shots to ramp into.".into());
        }
        return (steps, format!("Ramped up to {}% into {cuts} cut{} and back down out of {}.", (fast * 100.0).round() as i64, if cuts == 1 { "" } else { "s" }, if cuts == 1 { "it" } else { "them" }));
    }
    let at_playhead = shots.iter().find(|c| ptr.playhead >= c.start && ptr.playhead < c.end()).copied();
    let targets: Vec<&promptedit_core::Clip> =
        if !chosen.is_empty() { chosen } else { vec![at_playhead.unwrap_or_else(|| *shots.iter().max_by(|a, b| a.duration.total_cmp(&b.duration)).unwrap())] };
    let speed = asked.map(|a| if a == 1.0 { 0.3 } else { a }).unwrap_or(if t.contains("fast") || t.contains("speed up") { 3.0 } else { 0.3 });
    for c in &targets {
        let l = c.source_length().max(1e-6);
        let mut mid = 0.5;
        if ptr.playhead > c.start && ptr.playhead < c.end() {
            mid = (c.source_time(ptr.playhead) - c.source_start) / l;
        }
        let mid = mid.clamp(0.2, 0.8);
        steps.push(Step::Ramp { ids: ids_of(c.id), speed, points: (mid - 0.2, mid - 0.1, mid + 0.1, mid + 0.2), around: c.speed });
    }
    let n = targets.len();
    (
        steps,
        format!(
            "{} a moment in {} to {}%, easing in and out of it.",
            if speed < 1.0 { "Slowed" } else { "Sped up" },
            if n == 1 { "the shot".to_string() } else { format!("{n} shots") },
            (speed * 100.0).round() as i64
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::host::HeadlessHost;
    use promptedit_core::Clip;

    fn project_with_shot() -> (Project, Id) {
        let mut p = Project::default();
        let a = MediaAsset {
            id: Id::new(),
            path: "/nonexistent/a.mov".into(),
            relative_path: None,
            playable_path: None,
            name: "a.mov".into(),
            kind: MediaKind::Video,
            duration: 10.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: false,
            bookmark: None,
        };
        let c = Clip { track_id: p.video_tracks[0].id, kind: ClipKind::Video, asset_id: Some(a.id), duration: 8.0, ..Clip::default() };
        let id = c.id;
        p.assets.push(a);
        p.clips.push(c);
        (p, id)
    }

    #[test]
    fn title_and_zoom_are_one_step_each() {
        let host = HeadlessHost::default();
        let (p, id) = project_with_shot();
        *host.state.doc.lock().unwrap() = promptedit_core::history::Document::new(p);
        let ptr = Pointers { playhead: 1.0, selected: vec![id], range: None };
        let d = run(&host, "add a title saying \"Hello\" at the end", &ptr, &Quiet).unwrap();
        assert!(d.changed, "{}", d.text);
        assert!(d.text.contains("Hello"));
        let d = run(&host, "@selected zoom in 3x", &ptr, &Quiet).unwrap();
        assert!(d.changed, "{}", d.text);
        let mut doc = host.state.doc.lock().unwrap();
        let c = doc.project.clip(id).unwrap();
        assert_eq!(c.transform.unwrap().scale, 3.0);
        doc.undo();
        doc.undo();
        assert!(doc.project.clips.iter().all(|c| c.kind != ClipKind::Text), "two undos take both back");
    }

    #[test]
    fn says_what_it_cant_do() {
        let host = HeadlessHost::default();
        let (p, _) = project_with_shot();
        *host.state.doc.lock().unwrap() = promptedit_core::history::Document::new(p);
        let d = run(&host, "what's the weather like?", &Pointers::default(), &Quiet).unwrap();
        assert!(!d.changed);
        assert!(d.text.starts_with("Local only edits your video"), "{}", d.text);
    }
}
