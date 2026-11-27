//! Local Magic on a timeline that already has an edit (Editroom's `LocalImprover`): makes that
//! edit better instead of starting over, with no AI. It keeps the person's shots, order and music, and
//! takes out repeats and the weakest shots; trims long shots to their best moment; with music, puts
//! every cut on a beat and ends on a bar; closes the gaps; gives every shot the look most of them
//! already have, evens out exposure, and sets the sound (clips under the music, fades in and out).

use super::analyzer::{ClipAnalysis, MusicAnalysis, Sample};
use super::plan::{Step, applied};
use super::planner::{percentile, scorer};
use super::recipe::{Frame, Music, Pace, Recipe};
use promptedit_core::{Clip, ClipKind, Id, MediaAsset, MediaKind, Project, TrackKind};
use std::collections::HashMap;

pub struct Outcome {
    pub steps: Vec<Step>,
    /// What changed, in a sentence.
    pub summary: String,
    pub notes: Vec<String>,
    pub focused: bool,
    /// The whole reply, when it chose not to change anything.
    pub message: Option<String>,
}

fn is_shot(c: &Clip) -> bool {
    matches!(c.kind, ClipKind::Video | ClipKind::Image) && c.asset_id.is_some()
}

fn ids_of(p: &Project, id: Id) -> Vec<Id> {
    let set = p.unlocked(&p.linked(&[id].into_iter().collect()));
    p.clips.iter().filter(|c| set.contains(&c.id)).map(|c| c.id).collect()
}

/// How long a shot could run from its start to the end of its file.
fn source_room(c: &Clip, p: &Project) -> f64 {
    match p.source_limit(c) {
        Some(limit) => c.duration.max((limit - c.source_start) / c.speed.max(0.01)),
        None => c.duration,
    }
}

pub fn plan(p: &Project, analyses: &HashMap<Id, ClipAnalysis>, music: Option<&MusicAnalysis>, recipe: &Recipe, new_song: Option<&MediaAsset>) -> Option<Outcome> {
    let level_steps = |q: &Project| -> Vec<Step> {
        q.clips
            .iter()
            .filter_map(|c| recipe.level_gains.get(&c.id).filter(|g| (**g - c.gain_db).abs() > 0.05).map(|g| Step::Gain { id: c.id, from: c.gain_db, to: *g }))
            .collect()
    };
    let level_part = |n: usize| {
        let s = &recipe.level_silent;
        let silent = if s.is_empty() {
            String::new()
        } else if s.len() == 1 {
            format!(" ({} has no sound, so it was left as it is)", s.join(", "))
        } else {
            format!(" ({} have no sound, so they were left as they are)", s.join(", "))
        };
        format!("set {n} audio clip{} to the same level{silent}", if n == 1 { "" } else { "s" })
    };
    let real_look = recipe.look.clone().filter(|l| l != "none");
    // Only the audio levels (and maybe a look): just that.
    if recipe.only_levels() {
        let mut steps = level_steps(p);
        let levels = steps.len();
        if let Some(look) = &real_look {
            for c in p.clips.iter().filter(|c| matches!(c.kind, ClipKind::Video | ClipKind::Image) && c.grade.as_ref().and_then(|g| g.look.as_ref()) != Some(look)) {
                steps.push(Step::Look { id: c.id, name: look.clone() });
            }
        }
        let empty = |m: &str| Some(Outcome { steps: vec![], summary: String::new(), notes: vec![], focused: true, message: Some(m.into()) });
        if recipe.level_gains.is_empty() {
            return empty("There's no audio on the timeline to level.");
        }
        if steps.is_empty() {
            return empty("Your audio clips are already at the same level.");
        }
        let mut parts = if levels > 0 { vec![level_part(levels)] } else { vec![] };
        if let Some(l) = &real_look {
            parts.push(format!("one look ({l})"));
        }
        return Some(Outcome { steps, summary: parts.join(", "), notes: vec![], focused: true, message: None });
    }
    // The main picture track: the lowest video track with shots on it.
    let track = p.video_tracks.iter().find(|t| p.clips.iter().any(|c| c.track_id == t.id && is_shot(c)))?;
    if track.locked {
        return None;
    }
    let track = track.id;
    let mut shots: Vec<Clip> = p.clips.iter().filter(|c| c.track_id == track && is_shot(c)).cloned().collect();
    shots.sort_by(|a, b| a.start.total_cmp(&b.start));
    let first = shots.first()?.clone();
    let all: Vec<Sample> = shots.iter().filter_map(|c| c.asset_id.and_then(|a| analyses.get(&a))).flat_map(|a| a.samples.clone()).collect();
    let score: Box<dyn Fn(&Sample) -> f64> = if all.is_empty() { Box::new(|_| 0.5) } else { Box::new(scorer(&all)) };
    let fps = p.fps;
    let frames = |t: f64| (t * fps).round() / fps;
    let range = |c: &Clip| (c.source_start, c.source_start + c.source_length());
    let shot_score = |c: &Clip| -> f64 {
        let Some(a) = c.asset_id.and_then(|id| analyses.get(&id)) else { return 0.5 };
        let (lo, hi) = range(c);
        let v: Vec<f64> = a.samples.iter().filter(|s| c.kind == ClipKind::Image || (s.time >= lo && s.time <= hi)).map(&*score).collect();
        if v.is_empty() { 0.5 } else { v.iter().sum::<f64>() / v.len() as f64 }
    };
    let best = |c: &Clip, length: f64| -> (f64, f64) {
        let Some(a) = c.asset_id.and_then(|id| analyses.get(&id)).filter(|a| c.kind == ClipKind::Video && !a.samples.is_empty()) else {
            return (c.source_start, shot_score(c));
        };
        let (lo, hi) = range(c);
        let span = length * c.speed;
        let (mut bs, mut bv) = (c.source_start, f64::NEG_INFINITY);
        let mut s = lo;
        while s + span <= hi + 1e-6 {
            let inside: Vec<f64> = a.samples.iter().filter(|x| x.time >= s && x.time <= s + span).map(&*score).collect();
            if !inside.is_empty() {
                let v = inside.iter().sum::<f64>() / inside.len() as f64 * 0.75 + inside.iter().cloned().fold(f64::INFINITY, f64::min) * 0.25;
                if v > bv {
                    bv = v;
                    bs = s;
                }
            }
            s += 0.1;
        }
        (bs, if bv.is_finite() { bv } else { shot_score(c) })
    };
    // A speed for every shot: that (with any look asked for too), and nothing else.
    if let Some(speed) = recipe.speed {
        let ids: Vec<Id> = {
            let set = p.unlocked(&p.linked(&shots.iter().map(|c| c.id).collect()));
            p.clips.iter().filter(|c| set.contains(&c.id)).map(|c| c.id).collect()
        };
        let mut steps = vec![];
        if shots.iter().any(|c| c.kind == ClipKind::Video && (c.speed - speed).abs() > 1e-3) {
            steps.push(Step::Speed { ids, speed });
        }
        if let Some(look) = &real_look {
            for c in shots.iter().filter(|c| c.grade.as_ref().and_then(|g| g.look.as_ref()) != Some(look)) {
                steps.push(Step::Look { id: c.id, name: look.clone() });
            }
        }
        let q = applied(p, &steps);
        let levels = level_steps(&q);
        let nl = levels.len();
        steps.extend(levels);
        if steps.is_empty() {
            return None;
        }
        let before = shots.iter().map(Clip::end).fold(0.0, f64::max) - first.start;
        let after = q.clips.iter().filter(|c| c.track_id == track).map(Clip::end).fold(0.0, f64::max) - first.start;
        let mut parts = vec![format!("set every clip to {}% speed ({before:.1}s to {after:.1}s)", crate::mcp::tools::fmt_g(speed * 100.0))];
        if let Some(l) = &recipe.look {
            parts.push(format!("one look ({l})"));
        }
        if nl > 0 {
            parts.push(level_part(nl));
        }
        return Some(Outcome { steps, summary: parts.join(", "), notes: vec![], focused: true, message: None });
    }
    // 0. Media they named: only those, or not those, and nothing else unasked.
    let focused = recipe.is_focused();
    let mut keep = shots.clone();
    let mut dropped: Vec<Clip> = vec![];
    if !recipe.keep_only.is_empty() {
        dropped.extend(keep.iter().filter(|c| !c.asset_id.is_some_and(|a| recipe.keep_only.contains(&a))).cloned());
        keep.retain(|c| c.asset_id.is_some_and(|a| recipe.keep_only.contains(&a)));
    }
    if !recipe.take_out.is_empty() {
        dropped.extend(keep.iter().filter(|c| c.asset_id.is_some_and(|a| recipe.take_out.contains(&a))).cloned());
        keep.retain(|c| !c.asset_id.is_some_and(|a| recipe.take_out.contains(&a)));
    }
    let named = dropped.len();
    if keep.is_empty() {
        return None;
    }
    // 1. Repeats: the same file, mostly the same part. Keep the better-scoring one.
    let mut i = if focused { keep.len() } else { 0 };
    while i < keep.len() {
        let mut j = i + 1;
        while j < keep.len() {
            let (a, b) = (keep[i].clone(), keep[j].clone());
            if a.asset_id.is_some() && a.asset_id == b.asset_id && a.kind == b.kind {
                let (ra, rb) = (range(&a), range(&b));
                let overlap = (ra.1.min(rb.1) - ra.0.max(rb.0)).max(0.0);
                let shorter = (ra.1 - ra.0).min(rb.1 - rb.0).max(0.01);
                if a.kind == ClipKind::Image || overlap / shorter > 0.5 {
                    if shot_score(&b) > shot_score(&a) {
                        dropped.push(a);
                        keep[i] = b;
                    } else {
                        dropped.push(b);
                    }
                    keep.remove(j);
                    continue;
                }
            }
            j += 1;
        }
        i += 1;
    }
    let repeats = dropped.len() - named;
    // 2. The weakest shots, when there are enough to spare: at most a quarter, never below four.
    if keep.len() > 4 && !focused {
        let scores: Vec<f64> = keep.iter().map(shot_score).collect();
        let floor = percentile(&scores, 0.15) - 0.05;
        let mut weak: Vec<usize> = (0..keep.len()).filter(|&k| scores[k] < floor).collect();
        weak.sort_by(|a, b| scores[*a].total_cmp(&scores[*b]));
        let can_drop = weak.len().min(keep.len() / 4).min(keep.len() - 4);
        let gone: Vec<Id> = weak.iter().take(can_drop).map(|&k| keep[k].id).collect();
        dropped.extend(keep.iter().filter(|c| gone.contains(&c.id)).cloned());
        keep.retain(|c| !gone.contains(&c.id));
    }
    keep.sort_by(|a, b| a.start.total_cmp(&b.start));
    // 3. How long each shot plays, never longer than now.
    let paced = |c: &Clip| -> f64 {
        match recipe.pace {
            Pace::Calm => if c.duration > 6.0 { (c.duration * 0.8).max(4.0) } else { c.duration },
            Pace::Fast => if c.duration > 2.0 { (c.duration * 0.5).clamp(1.2, 2.5) } else { c.duration },
            Pace::Unchanged => {
                if focused {
                    c.duration
                } else if c.duration > 3.5 {
                    c.duration.min((c.duration * 0.6).clamp(2.5, 4.5))
                } else {
                    c.duration
                }
            }
        }
    };
    let mut notes: Vec<String> = vec![];
    let mut planned: HashMap<Id, f64> = keep.iter().map(|c| (c.id, paced(c))).collect();
    let mut growing = false;
    let file_length = |c: &Clip| -> f64 {
        if c.kind == ClipKind::Image { 30.0 } else { c.duration.max(p.asset(c.asset_id).map(|a| a.duration).unwrap_or(c.duration) / c.speed.max(0.01)) }
    };
    if let Some(target) = recipe.seconds {
        let mut paced_total: f64 = keep.iter().map(paced).sum();
        while paced_total * 0.6 > target && keep.len() > 2 {
            let Some(w) = (0..keep.len()).min_by(|a, b| shot_score(&keep[*a]).total_cmp(&shot_score(&keep[*b]))) else { break };
            dropped.push(keep.remove(w));
            paced_total = keep.iter().map(paced).sum();
        }
        let now_total: f64 = keep.iter().map(|c| c.duration).sum();
        if target <= paced_total {
            for c in &keep {
                planned.insert(c.id, (paced(c) * target / paced_total.max(0.01)).max(0.8));
            }
        } else if target <= now_total {
            let f = (target - paced_total) / (now_total - paced_total).max(0.01);
            for c in &keep {
                planned.insert(c.id, paced(c) + (c.duration - paced(c)) * f);
            }
        } else {
            growing = true;
            let mut lengths: HashMap<Id, f64> = keep.iter().map(|c| (c.id, c.duration)).collect();
            let mut need = target - now_total;
            for _ in 0..6 {
                if need <= 0.05 {
                    break;
                }
                let open: Vec<&Clip> = keep.iter().filter(|c| file_length(c) - lengths[&c.id] > 0.05).collect();
                if open.is_empty() {
                    break;
                }
                let share = need / open.len() as f64;
                for c in open {
                    let add = share.min(file_length(c) - lengths[&c.id]);
                    *lengths.get_mut(&c.id).unwrap() += add;
                    need -= add;
                }
            }
            planned = lengths;
            if need > 0.5 {
                notes.push(format!("it can't be {} seconds long: all the footage in your shots only adds up to about {}", target as i64, (target - need).round() as i64));
            }
        }
    }
    let wanted = |c: &Clip| planned.get(&c.id).copied().unwrap_or_else(|| paced(c));
    let weak_out = dropped.len() - repeats - named;
    // The song: the longest sound-only clip from a music file; none if they asked for no music; or a
    // song from the library put under the edit when they asked for music and there wasn't any.
    let song_on_timeline = p
        .clips
        .iter()
        .filter(|c| c.kind == ClipKind::Audio && c.link_id.is_none() && p.asset(c.asset_id).is_some_and(|a| a.kind == MediaKind::Audio && a.duration >= 8.0))
        .max_by(|a, b| a.duration.total_cmp(&b.duration))
        .cloned();
    let first_start = first.start;
    let mut song = if recipe.music == Music::Off { None } else { song_on_timeline.clone() };
    let mut placing: Option<Clip> = None;
    if recipe.music == Music::Add && song_on_timeline.is_none() {
        if let (Some(ns), Some(m)) = (new_song, music) {
            // From its first bar, so the cut starts on a downbeat.
            let bar = (0..m.beats.len()).find(|i| m.is_bar_start(*i)).map(|i| m.beats[i]).unwrap_or(0.0);
            let c = Clip { kind: ClipKind::Audio, asset_id: Some(ns.id), start: first_start, duration: (ns.duration - bar).max(1.0), source_start: bar, ..Clip::default() };
            placing = Some(c.clone());
            song = Some(c);
        } else {
            notes.push("there's no music in your Media to add".into());
        }
    }
    let mut cuts = vec![first_start];
    let mut lengths: Vec<f64> = vec![];
    // Cut to the beat, unless it's a focused request that didn't ask for a length or pace.
    let snap = !focused || recipe.seconds.is_some() || recipe.pace != Pace::Unchanged || placing.is_some();
    match (snap, &song, music) {
        (true, Some(song), Some(m)) if m.beats.len() > 8 => {
            // Beats on the timeline, with the song's own beat number.
            let beats: Vec<(usize, f64)> = m
                .beats
                .iter()
                .enumerate()
                .map(|(i, b)| (i, song.start + (b - song.source_start) / song.speed.max(0.01)))
                .filter(|(_, t)| *t > first_start + 0.2)
                .collect();
            let min_len = (2.0 * m.period()).max(0.8);
            for (k, c) in keep.iter().enumerate() {
                let last = k == keep.len() - 1;
                let from = *cuts.last().unwrap();
                let target = from + wanted(c);
                let room = if growing { file_length(c) } else if last { if c.kind == ClipKind::Image { 3600.0 } else { source_room(c, p) } } else { c.duration };
                let options: Vec<&(usize, f64)> = beats.iter().filter(|(_, t)| *t >= from + min_len - 1e-6 && *t <= from + room + 1e-6).collect();
                let nearest = |v: &Vec<&(usize, f64)>| v.iter().min_by(|a, b| (a.1 - target).abs().total_cmp(&(b.1 - target).abs())).map(|x| x.1);
                let pick = if last {
                    // End on a bar: the bar start nearest the target that it can reach.
                    let bars: Vec<&(usize, f64)> = options.iter().filter(|(i, _)| m.is_bar_start(*i)).copied().collect();
                    nearest(&bars).or_else(|| nearest(&options)).unwrap_or(from + wanted(c).min(room))
                } else {
                    nearest(&options).unwrap_or(from + wanted(c))
                };
                lengths.push(frames(pick - from));
                cuts.push(from + lengths[k]);
            }
        }
        _ => {
            for c in &keep {
                lengths.push(frames(wanted(c)));
                let last = *cuts.last().unwrap();
                cuts.push(last + *lengths.last().unwrap());
            }
        }
    }
    let new_end = *cuts.last().unwrap();
    let old_end = shots.iter().map(Clip::end).fold(new_end, f64::max);
    // 4. The edits, in an order that's always safe: the frame shape first; repeats and weak shots out;
    // then each shot trimmed to its moment and slid left into place, left to right.
    let mut steps: Vec<Step> = vec![];
    let size = match recipe.frame {
        Frame::Vertical => Some((1080, 1920)),
        Frame::Horizontal => Some((1920, 1080)),
        Frame::Square => Some((1080, 1080)),
        Frame::Unchanged => None,
    };
    if let Some((w, h)) = size
        && (p.width != w || p.height != h)
    {
        steps.push(Step::Size { width: w, height: h });
    }
    for c in &dropped {
        steps.push(Step::Remove { ids: ids_of(p, c.id), ripple: false });
    }
    let mut trimmed = 0;
    if growing {
        // Longer shots can't slide into place without landing on each other: lifted off and laid back
        // down at their new lengths, each the best part of its file that long.
        for c in &keep {
            steps.push(Step::Remove { ids: ids_of(p, c.id), ripple: false });
        }
        for (k, c) in keep.iter().enumerate() {
            let length = lengths[k];
            let mut from = c.source_start;
            if c.kind == ClipKind::Video
                && let (Some(a), Some(asset)) = (c.asset_id.and_then(|id| analyses.get(&id)), p.asset(c.asset_id))
            {
                let span = length * c.speed;
                let mut bv = f64::NEG_INFINITY;
                let mut s0 = 0.0;
                while s0 + span <= asset.duration + 1e-6 {
                    let inside: Vec<f64> = a.samples.iter().filter(|x| x.time >= s0 && x.time <= s0 + span).map(&*score).collect();
                    if !inside.is_empty() {
                        let v = inside.iter().sum::<f64>() / inside.len() as f64 * 0.75 + inside.iter().cloned().fold(f64::INFINITY, f64::min) * 0.25 - (s0 - c.source_start).abs() * 0.01;
                        if v > bv {
                            bv = v;
                            from = s0;
                        }
                    }
                    s0 += 0.1;
                }
                if !bv.is_finite() {
                    from = c.source_start.min((asset.duration - span).max(0.0));
                }
            }
            let group: Vec<Clip> = p
                .clips
                .iter()
                .filter(|g| g.id == c.id || (c.link_id.is_some() && g.link_id == c.link_id))
                .map(|g| {
                    let mut n = g.clone();
                    n.start = frames(cuts[k]);
                    n.duration = frames(length);
                    if n.kind != ClipKind::Image {
                        n.source_start = from;
                    }
                    n.clamp_fades();
                    n
                })
                .collect();
            steps.push(Step::Place { clips: group });
            trimmed += 1;
        }
    } else {
        for (k, c) in keep.iter().enumerate() {
            let ids = ids_of(p, c.id);
            let length = lengths[k];
            let mut head = c.start;
            if c.kind == ClipKind::Video && length < c.duration - 0.5 / fps {
                let (ss, _) = best(c, length);
                head = frames(c.start + (ss - c.source_start) / c.speed.max(0.01));
                if (head - c.start).abs() > 0.5 / fps {
                    steps.push(Step::TrimHead { ids: ids.clone(), from: c.start, to: head });
                }
            }
            let tail = frames(head + length);
            if (tail - c.end()).abs() > 0.5 / fps {
                steps.push(Step::TrimTail { ids: ids.clone(), from: c.end(), to: tail });
                trimmed += 1;
            }
            let target = frames(cuts[k]);
            if (target - head).abs() > 0.5 / fps {
                steps.push(Step::Move { ids, from: head, to: target });
            }
        }
    }
    // 5. Titles and overlays above: the same title twice at the same time goes, and anything past the
    // new end is shortened or goes.
    let order: HashMap<Id, usize> = p.video_tracks.iter().enumerate().map(|(i, t)| (t.id, i)).collect();
    let mut titles: Vec<&Clip> = p.clips.iter().filter(|c| c.kind == ClipKind::Text).collect();
    titles.sort_by_key(|c| order.get(&c.track_id).copied().unwrap_or(0));
    let is_video_track = |id: Id| p.video_tracks.iter().any(|t| t.id == id);
    let mut doubled: Vec<Id> = vec![];
    if recipe.clear_rest {
        for c in p.clips.iter().filter(|c| c.track_id != track && is_video_track(c.track_id) && !p.is_locked(c.track_id) && !c.asset_id.is_some_and(|a| recipe.keep_only.contains(&a))) {
            doubled.push(c.id);
            steps.push(Step::Remove { ids: vec![c.id], ripple: false });
        }
    }
    if !focused {
        for (k, t) in titles.iter().enumerate() {
            if doubled.contains(&t.id) {
                continue;
            }
            for u in &titles[k + 1..] {
                if !doubled.contains(&u.id) && u.text.string == t.text.string && u.start < t.end() && u.end() > t.start && !p.is_locked(u.track_id) {
                    doubled.push(u.id);
                    steps.push(Step::Remove { ids: vec![u.id], ripple: false });
                }
            }
        }
    }
    for c in p.clips.iter().filter(|c| c.track_id != track && is_video_track(c.track_id) && !p.is_locked(c.track_id) && !doubled.contains(&c.id)) {
        if c.start >= new_end - 0.2 {
            steps.push(Step::Remove { ids: vec![c.id], ripple: false });
        } else if c.end() > new_end {
            steps.push(Step::TrimTail { ids: vec![c.id], from: c.end(), to: new_end });
        }
    }
    // 6. Sound: the song trimmed to the new end and faded out (or taken out, or put in); the clips' own
    // sound under it.
    let kept_audio: Vec<&Clip> = p.clips.iter().filter(|a| a.kind == ClipKind::Audio && a.link_id.is_some() && keep.iter().any(|k| k.link_id == a.link_id)).collect();
    let music_goes = recipe.music == Music::Off
        || (recipe.clear_rest && recipe.music != Music::Add && !song_on_timeline.as_ref().and_then(|s| s.asset_id).is_some_and(|a| recipe.keep_only.contains(&a)));
    if music_goes
        && let Some(s) = &song_on_timeline
        && !p.is_locked(s.track_id)
    {
        steps.push(Step::Remove { ids: vec![s.id], ripple: false });
    }
    if let (Some(mut c), Some(ns)) = (placing.clone(), new_song) {
        // On a sound track that's free for the whole edit, or a new one.
        match p.audio_tracks.iter().find(|t| !t.locked && !p.clips.iter().any(|x| x.track_id == t.id && x.start < new_end && x.end() > first_start)) {
            Some(t) => c.track_id = t.id,
            None => {
                let id = Id::new();
                steps.push(Step::AddTrack { kind: TrackKind::Audio, id });
                c.track_id = id;
            }
        }
        c.duration = frames(new_end - first_start);
        let fade = (c.duration * 0.15).min(2.0);
        let cid = c.id;
        let _ = ns;
        steps.push(Step::Place { clips: vec![c] });
        steps.push(Step::FadeOut { id: cid, to: fade });
        for a in kept_audio.iter().filter(|a| a.gain_db > -10.0) {
            steps.push(Step::Gain { id: a.id, from: a.gain_db, to: -16.0 });
        }
    } else if let Some(s) = song.as_ref().filter(|s| !music_goes && !p.is_locked(s.track_id)) {
        if s.end() > new_end + 1e-3 {
            steps.push(Step::TrimTail { ids: vec![s.id], from: s.end(), to: new_end });
        }
        if s.fade_out < 1.5 {
            steps.push(Step::FadeOut { id: s.id, to: ((s.end().min(new_end) - s.start) * 0.15).clamp(0.5, 2.0) });
        }
        for a in kept_audio.iter().filter(|a| a.gain_db > -10.0) {
            steps.push(Step::Gain { id: a.id, from: a.gain_db, to: -16.0 });
        }
    } else if !focused
        && let (Some(f), Some(l)) = (kept_audio.iter().min_by(|a, b| a.start.total_cmp(&b.start)), kept_audio.iter().max_by(|a, b| a.start.total_cmp(&b.start)))
    {
        if f.fade_in < 0.2 {
            steps.push(Step::FadeIn { id: f.id, to: 0.3 });
        }
        if l.fade_out < 0.3 {
            steps.push(Step::FadeOut { id: l.id, to: 0.6 });
        }
    }
    // 7. One look: the one they asked for, or the one most shots have, on all of them; exposure evened out.
    let looks: Vec<String> = keep.iter().filter_map(|c| c.grade.as_ref().and_then(|g| g.look.clone())).collect();
    let common = recipe.look.clone().or_else(|| {
        if focused {
            return None;
        }
        let mut counts: Vec<(String, usize)> = vec![];
        for l in &looks {
            match counts.iter_mut().find(|x| &x.0 == l) {
                Some(x) => x.1 += 1,
                None => counts.push((l.clone(), 1)),
            }
        }
        counts.into_iter().max_by_key(|x| x.1).map(|x| x.0)
    });
    let mut graded = 0;
    for c in keep.iter().filter(|c| c.kind != ClipKind::Audio) {
        let has = c.grade.as_ref().and_then(|g| g.look.clone());
        if common.as_deref() == Some("none") {
            if has.is_some() {
                steps.push(Step::NoLook { id: c.id });
                graded += 1;
            }
        } else if let Some(l) = &common
            && has.as_ref() != Some(l)
        {
            steps.push(Step::Look { id: c.id, name: l.clone() });
            graded += 1;
        }
        if !focused
            && c.grade.as_ref().map(|g| g.exposure).unwrap_or(0.0) == 0.0
            && let Some(a) = c.asset_id.and_then(|id| analyses.get(&id))
        {
            let (lo, hi) = range(c);
            let lumas: Vec<f64> = a.samples.iter().filter(|s| c.kind == ClipKind::Image || (s.time >= lo && s.time <= hi)).map(|s| s.luma).collect();
            if !lumas.is_empty() {
                let mean = lumas.iter().sum::<f64>() / lumas.len() as f64;
                let exposure = (((0.45 / mean.max(0.05)).log2() * 0.5).clamp(-0.5, 0.5) * 10.0).round() / 10.0;
                if exposure.abs() >= 0.2 {
                    steps.push(Step::Exposure { id: c.id, to: exposure });
                }
            }
        }
    }
    // 8. Sound effects they asked for: the short sound files in their Media, on the cuts.
    let mut effects_placed = 0;
    let mut judged_none = false;
    if recipe.sound_effects {
        let effects: Vec<&MediaAsset> = p.assets.iter().filter(|a| a.kind == MediaKind::Audio && a.duration > 0.05 && a.duration < 10.0).collect();
        if effects.is_empty() {
            notes.push("there are no sound effects in your Media (sound files under 10 seconds)".into());
        } else {
            let named_like = |a: &MediaAsset, w: &[&str]| w.iter().any(|x| a.name.to_lowercase().contains(x));
            let swooshes: Vec<&MediaAsset> = effects.iter().copied().filter(|a| named_like(a, &["whoosh", "swoosh", "swish", "woosh", "transition", "riser", "sweep"])).collect();
            let hits: Vec<&MediaAsset> = effects.iter().copied().filter(|a| named_like(a, &["hit", "impact", "boom", "thud", "punch", "slam", "bass drop", "drop"])).collect();
            let others: Vec<&MediaAsset> = effects.iter().copied().filter(|e| !swooshes.iter().any(|s| s.id == e.id) && !hits.iter().any(|h| h.id == e.id)).collect();
            let pool = if !swooshes.is_empty() { &swooshes } else if !others.is_empty() { &others } else { &hits };
            let mut spots: Vec<(f64, &MediaAsset, bool)> = vec![];
            if recipe.asked_judgement {
                for (k, (t, motion)) in strong_moments(&keep, &cuts, analyses).into_iter().take(8).enumerate() {
                    if motion && let Some(h) = hits.first() {
                        spots.push((t, h, false));
                    } else {
                        let e = pool[k % pool.len()];
                        spots.push((t, e, swooshes.iter().any(|s| s.id == e.id)));
                    }
                }
                spots.sort_by(|a, b| a.0.total_cmp(&b.0));
                if spots.is_empty() {
                    judged_none = true;
                    notes.push("Local could add your sound effects, but it doesn't see a strong moment for them: the cuts don't change the picture much, and nothing in the shots moves suddenly. Say where you'd like them (for example \"a whoosh on every cut\" or \"an impact at the start\"), or ask Claude or ChatGPT, which can watch the footage".into());
                }
            } else {
                if let Some(h) = hits.first() {
                    spots.push((first_start, h, false));
                }
                let cut_times: Vec<f64> = cuts.iter().skip(1).take(cuts.len().saturating_sub(2)).copied().collect();
                for (k, t) in cut_times.iter().enumerate() {
                    if spots.len() >= 8 {
                        break;
                    }
                    let e = pool[k % pool.len()];
                    spots.push((*t, e, swooshes.iter().any(|s| s.id == e.id)));
                }
                if cut_times.is_empty() && spots.is_empty() {
                    spots.push((first_start, pool[0], false));
                }
            }
            if !spots.is_empty() {
                let spans: Vec<(f64, f64)> = spots
                    .iter()
                    .map(|(t, e, lead)| {
                        let start = first_start.max(if *lead { t - (e.duration * 0.6).min(0.5) } else { t - 0.03 });
                        (start, new_end.min(start + e.duration))
                    })
                    .collect();
                let lo = spans.iter().map(|s| s.0).fold(f64::INFINITY, f64::min);
                let hi = spans.iter().map(|s| s.1).fold(0.0, f64::max);
                let song_track = song_on_timeline.as_ref().map(|s| s.track_id);
                let placing_track = placing.as_ref().map(|s| s.track_id);
                let track_id = match p.audio_tracks.iter().find(|t| {
                    !t.locked && Some(t.id) != song_track && Some(t.id) != placing_track && !p.clips.iter().any(|x| x.track_id == t.id && x.start < hi && x.end() > lo)
                }) {
                    Some(t) => t.id,
                    None => {
                        let id = Id::new();
                        steps.push(Step::AddTrack { kind: TrackKind::Audio, id });
                        id
                    }
                };
                let effect_ids: Vec<Id> = effects.iter().map(|a| a.id).collect();
                let mut last_end = f64::NEG_INFINITY;
                for (k, (_, e, _)) in spots.iter().enumerate() {
                    let (mut start, end) = spans[k];
                    // A sound effect is already there: leave it.
                    if p.clips.iter().any(|x| x.asset_id.is_some_and(|a| effect_ids.contains(&a)) && x.start < end && x.end() > start) {
                        continue;
                    }
                    start = start.max(last_end);
                    if end - start <= 0.1 {
                        continue;
                    }
                    let mut c = Clip { track_id, kind: ClipKind::Audio, asset_id: Some(e.id), start: frames(start), duration: frames(end - start), gain_db: -6.0, ..Clip::default() };
                    c.fade_out = (c.duration / 3.0).min(0.15);
                    steps.push(Step::Place { clips: vec![c] });
                    last_end = end;
                    effects_placed += 1;
                }
            }
        }
    }
    // The audio levels, once everything else is in place.
    let fin = applied(p, &steps);
    let levels = level_steps(&fin);
    let nl = levels.len();
    steps.extend(levels);
    if effects_placed == 0 && recipe.sound_effects && !judged_none && notes.is_empty() && recipe.is_focused() {
        notes.push("every cut already has a sound effect, so there was nowhere new to put one".into());
    }
    if steps.is_empty() && (judged_none || !notes.is_empty()) {
        let text: Vec<String> = notes.iter().map(|n| n[..1].to_uppercase() + &n[1..]).collect();
        let text = text.join(". ");
        return Some(Outcome {
            steps: vec![],
            summary: String::new(),
            notes,
            focused: true,
            message: Some(if text.is_empty() { "Your edit already looks good; nothing to change.".into() } else { text + "." }),
        });
    }
    if steps.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = if focused && recipe.seconds.is_none() { vec![] } else { vec![format!("{:.1}s to {:.1}s", old_end - first_start, new_end - first_start)] };
    let plural = |n: usize, one: &str, many: &str| if n == 1 { one.to_string() } else { many.to_string() };
    if effects_placed > 0 {
        parts.push(format!("added {effects_placed} sound effect{} on the cuts", plural(effects_placed, "", "s")));
    }
    if !recipe.keep_only.is_empty() {
        parts.push(format!("kept only {} ({named} shot{} out)", recipe.media_names.join(", "), plural(named, "", "s")));
    }
    if !recipe.take_out.is_empty() {
        parts.push(format!("took out {} ({named} shot{})", recipe.media_names.join(", "), plural(named, "", "s")));
    }
    if recipe.clear_rest {
        parts.push("cleared everything else off the timeline".into());
    }
    if repeats > 0 {
        parts.push(format!("{repeats} repeat{} out", plural(repeats, "", "s")));
    }
    if !doubled.is_empty() && !recipe.clear_rest {
        parts.push(format!("{} doubled title{} out", doubled.len(), plural(doubled.len(), "", "s")));
    }
    if weak_out > 0 {
        parts.push(format!("{weak_out} weak shot{} out", plural(weak_out, "", "s")));
    }
    if trimmed > 0 {
        parts.push(format!("{trimmed} shot{} {}", plural(trimmed, "", "s"), if growing { "lengthened" } else { "trimmed" }));
    }
    if placing.is_some() {
        parts.push("music added".into());
    } else if recipe.music == Music::Off && song_on_timeline.is_some() {
        parts.push("music out".into());
    }
    if snap && !music_goes && song.is_some() && music.is_some() {
        parts.push("cut to the beat".into());
    }
    if graded > 0 {
        parts.push(if common.as_deref() == Some("none") { "looks off".into() } else { format!("one look ({})", common.clone().unwrap_or_default()) });
    }
    if size.is_some() {
        parts.push(match recipe.frame {
            Frame::Vertical => "vertical",
            Frame::Horizontal => "horizontal",
            _ => "square",
        }
        .into());
    }
    if nl > 0 {
        parts.push(level_part(nl));
    }
    Some(Outcome { steps, summary: parts.join(", "), notes, focused, message: None })
}

/// Where a sound effect would land well: cuts where the picture changes a lot, and sudden bursts of
/// motion inside a shot. Best first. (time, is_motion)
fn strong_moments(keep: &[Clip], cuts: &[f64], analyses: &HashMap<Id, ClipAnalysis>) -> Vec<(f64, bool)> {
    let samples = |c: &Clip| -> Vec<Sample> {
        let Some(a) = c.asset_id.and_then(|id| analyses.get(&id)) else { return vec![] };
        let (lo, hi) = (c.source_start, c.source_start + c.source_length());
        a.samples.iter().filter(|s| c.kind == ClipKind::Image || (s.time >= lo && s.time <= hi)).cloned().collect()
    };
    let edge = |c: &Clip, end: bool| -> Option<(f64, f64)> {
        let s = samples(c);
        if s.is_empty() {
            return None;
        }
        let part: Vec<&Sample> = if end { s.iter().rev().take(2).collect() } else { s.iter().take(2).collect() };
        Some((part.iter().map(|x| x.luma).sum::<f64>() / part.len() as f64, part.iter().map(|x| x.color).sum::<f64>() / part.len() as f64))
    };
    let mut out: Vec<(f64, bool, f64)> = vec![];
    for k in 0..keep.len().saturating_sub(1) {
        let (Some(a), Some(b)) = (edge(&keep[k], true), edge(&keep[k + 1], false)) else { continue };
        let score = (a.0 - b.0).abs() * 3.0 + (a.1 - b.1).abs() * 1.5 + if keep[k].asset_id != keep[k + 1].asset_id { 0.1 } else { 0.0 };
        if score >= 0.5 {
            out.push((cuts[k + 1], false, score));
        }
    }
    let mut all: Vec<f64> = keep.iter().flat_map(|c| samples(c).into_iter().map(|s| s.motion)).collect();
    all.sort_by(f64::total_cmp);
    if all.len() >= 8 {
        let median = all[all.len() / 2];
        let p95 = all[((all.len() - 1) as f64 * 0.95) as usize];
        let bar = p95.max(median * 3.0).max(0.02);
        for (k, c) in keep.iter().enumerate() {
            for s in samples(c).iter().filter(|s| s.motion >= bar) {
                let t = cuts[k] + (s.time - c.source_start) / c.speed.max(0.01);
                if !out.iter().any(|o| (o.0 - t).abs() < 1.5) {
                    out.push((t, true, 0.5 + s.motion / bar.max(1e-6) * 0.1));
                }
            }
        }
    }
    out.sort_by(|a, b| b.2.total_cmp(&a.2));
    out.into_iter().map(|o| (o.0, o.1)).collect()
}
