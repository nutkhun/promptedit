//! Local Magic's new cut (Editroom's `AutoPlanner` and `Choreographer`): picks the best moments of
//! each clip and cuts them to the music, with no network and no key.
//!
//! Each frame sample is scored for focus, exposure, colour, faces and steadiness. Windows of the
//! right length are scored by their samples, and shots are taken round-robin across the clips in
//! the order they were filmed. With music, every shot is a whole number of beats, cuts land on beats,
//! the cut ends on a bar, and the song starts on a bar where it lifts.
//!
//! Editroom's Choreographer turns the decision into a plan its cursor swarm performs (a rough cut on
//! V2, trimmed and dragged down to V1); `build` makes the finished project that plan arrives at.

use super::analyzer::{ClipAnalysis, MusicAnalysis, Sample};
use super::recipe::{Pace, Recipe};
use promptedit_core::{Clip, ClipKind, ColorGrade, Id, MediaAsset, MediaKind, Project, Track, TrackKind, Transition, TransitionKind};

#[derive(Clone, Debug)]
pub struct Shot {
    pub asset: MediaAsset,
    /// Where the shot starts in its file.
    pub source: f64,
    pub duration: f64,
    /// Brings the shot to a matching brightness.
    pub exposure: f64,
    /// Level for the shot's own sound; 0 leaves it alone.
    pub gain_db: f64,
    /// A dissolve into this shot.
    pub dissolve: bool,
    pub score: f64,
}

#[derive(Clone, Debug)]
pub struct Song {
    pub asset: MediaAsset,
    pub source: f64,
    pub duration: f64,
    pub fade_out: f64,
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub shots: Vec<Shot>,
    pub music: Option<Song>,
    pub title: String,
    pub look: String,
    pub bpm: Option<f64>,
    pub title_at_end: bool,
}

pub fn percentile(v: &[f64], p: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    if s.is_empty() { 0.0 } else { s[((s.len() - 1) as f64 * p) as usize].min(s[s.len() - 1]) }
}

/// How good each frame sample is, with focus, motion and colour measured against all the footage.
pub fn scorer(all: &[Sample]) -> impl Fn(&Sample) -> f64 + use<> {
    let sharp_log: Vec<f64> = all.iter().map(|s| s.sharpness.ln_1p()).collect();
    let s10 = percentile(&sharp_log, 0.1);
    let s90 = percentile(&sharp_log, 0.9).max(s10 + 1e-6);
    let m90 = percentile(&all.iter().map(|s| s.motion).collect::<Vec<_>>(), 0.9).max(0.02);
    let c90 = percentile(&all.iter().map(|s| s.color).collect::<Vec<_>>(), 0.9).max(0.05);
    move |s: &Sample| {
        let sharp = ((s.sharpness.ln_1p() - s10) / (s90 - s10)).clamp(0.0, 1.0);
        let exposure = 1.0 - ((s.luma - 0.45).abs() / 0.38).min(1.0);
        let color = (s.color / c90).min(1.0);
        let motion = s.motion / m90;
        let mut q = 0.36 * sharp + 0.2 * exposure + 0.14 * color;
        q += if s.faces > 0 { 0.16 } else { 0.0 };
        q += s.aesthetic.map(|a| 0.26 * (a + 1.0) / 2.0).unwrap_or(0.12);
        if s.utility == Some(true) {
            q -= 0.35;
        }
        if motion > 1.1 {
            q -= ((motion - 1.1) * 0.3).min(0.3);
        }
        q
    }
}

pub struct Moment {
    pub start: f64,
    pub end: f64,
    pub score: f64,
    pub faces: i64,
}

/// A window's value: the average, held down by its worst moment.
fn window_value(vals: &[f64]) -> f64 {
    vals.iter().sum::<f64>() / vals.len() as f64 * 0.75 + vals.iter().cloned().fold(f64::INFINITY, f64::min) * 0.25
}

/// A clip's best moments of about `length` seconds, best first, not overlapping.
pub fn moments(a: &ClipAnalysis, limit: f64, length: f64, count: usize, score: &dyn Fn(&Sample) -> f64) -> Vec<Moment> {
    let scores: Vec<f64> = a.samples.iter().map(score).collect();
    let end = a.duration.min(limit);
    let len = length.min(end);
    let mut windows = vec![];
    let mut start = 0.0;
    while start + len <= end + 1e-6 {
        let inside: Vec<usize> = (0..a.samples.len()).filter(|&i| a.samples[i].time >= start && a.samples[i].time <= start + len).collect();
        if !inside.is_empty() {
            let vals: Vec<f64> = inside.iter().map(|&i| scores[i]).collect();
            windows.push((start, window_value(&vals), inside.iter().map(|&i| a.samples[i].faces).max().unwrap_or(0)));
        }
        start += 0.25;
    }
    windows.sort_by(|x, y| y.1.total_cmp(&x.1));
    let mut picked: Vec<Moment> = vec![];
    for w in windows {
        if picked.len() >= count {
            break;
        }
        if picked.iter().all(|m| w.0 + len <= m.start || w.0 >= m.end) {
            picked.push(Moment { start: w.0, end: w.0 + len, score: w.1, faces: w.2 });
        }
    }
    picked
}

struct Source {
    asset: MediaAsset,
    analysis: ClipAnalysis,
    scores: Vec<f64>,
    picked: Vec<(f64, f64)>,
}

/// What the cut should be: which moments, how long, in what order, over which part of the song.
pub fn decide(clips: &[(MediaAsset, ClipAnalysis)], music: Option<(&MediaAsset, &MusicAnalysis)>, recipe: &Recipe) -> Option<Decision> {
    let usable: Vec<&(MediaAsset, ClipAnalysis)> = clips.iter().filter(|c| !c.1.samples.is_empty()).collect();
    if usable.is_empty() {
        return None;
    }
    let all: Vec<Sample> = usable.iter().flat_map(|c| c.1.samples.clone()).collect();
    let score = scorer(&all);
    // In the order things were filmed; undated files keep their library order, last.
    let mut indexed: Vec<(usize, Source)> = usable
        .iter()
        .enumerate()
        .map(|(i, c)| (i, Source { asset: c.0.clone(), analysis: c.1.clone(), scores: c.1.samples.iter().map(&score).collect(), picked: vec![] }))
        .collect();
    indexed.sort_by(|a, b| match (a.1.analysis.created, b.1.analysis.created) {
        (Some(x), Some(y)) => x.total_cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });
    let mut sources: Vec<Source> = indexed.into_iter().map(|x| x.1).collect();
    let all_scores: Vec<f64> = sources.iter().flat_map(|s| s.scores.clone()).collect();
    let floor = percentile(&all_scores, 0.3);

    let mut period = music.map(|m| m.1.period());
    let wanted = if recipe.every { Some(recipe.shots.unwrap_or(0).max(sources.len())) } else { recipe.shots };
    let mut sub = 1usize;
    let pace = match recipe.pace {
        Pace::Fast => 0.55,
        Pace::Calm => 1.7,
        Pace::Unchanged => 1.0,
    };
    let (mut long_beats, mut short_beats) = (4usize, 2usize);
    if let Some(p) = period {
        long_beats = [2, 4, 8, 16].into_iter().find(|b| *b as f64 * p >= 1.5 * pace).unwrap_or(16);
        short_beats = if (long_beats / 2) as f64 * p >= 0.8 { long_beats / 2 } else { long_beats };
    }
    let mut per_shot: Option<f64> = None;
    if let Some(n) = wanted {
        let length = recipe.seconds.unwrap_or(n as f64 * if recipe.pace == Pace::Calm { 2.5 } else if recipe.pace == Pace::Fast { 0.9 } else { 1.5 });
        let ps = (length / n as f64).max(if recipe.every { 0.2 } else { 0.35 });
        per_shot = Some(ps);
        if recipe.every
            && let Some(p) = period
            && ps < p * 0.9
        {
            sub = 2;
            period = Some(p / 2.0);
        }
        if let Some(p) = period {
            let b = ((ps / p).floor() as usize).max(1);
            long_beats = b;
            short_beats = b;
        }
    }
    let rhythm = [true, false, false, true, true, false];
    let beats_for = |k: usize| if rhythm[k % rhythm.len()] { long_beats } else { short_beats };
    let length_for = |k: usize| -> f64 {
        if let Some(p) = period {
            return beats_for(k) as f64 * p;
        }
        if let Some(ps) = per_shot {
            return ps * [1.08, 0.94, 1.0, 1.06, 0.92, 1.0][k % 6];
        }
        [2.4, 1.8, 2.1, 2.8, 1.7, 2.2][k % 6] * pace
    };
    // How long: about half the good footage, between 12 and 40 seconds, and no longer than the song allows.
    let good: f64 = sources
        .iter()
        .map(|s| {
            let step = if s.analysis.samples.len() > 1 { s.analysis.duration / s.analysis.samples.len() as f64 } else { 2.5 };
            s.scores.iter().filter(|v| **v >= floor).count() as f64 * step
        })
        .sum();
    let mut target = recipe.seconds.or(per_shot.map(|p| p * wanted.unwrap_or(1) as f64)).unwrap_or((good * 0.5).clamp(12.0, 40.0));
    if let Some((_, m)) = music {
        target = target.min(m.duration - 2.0);
    }

    // The best window of `length` in a source that doesn't overlap what's been taken from it.
    let best_window = |s: &Source, length: f64, apart: f64| -> Option<(f64, f64)> {
        let a = &s.analysis;
        if s.asset.kind == MediaKind::Image {
            return s.picked.is_empty().then(|| (0.0, s.scores.first().copied().unwrap_or(0.0)));
        }
        let limit = a.duration.min(s.asset.duration);
        if limit < length + 0.1 {
            return None;
        }
        let wanted_times = recipe.moments.get(&s.asset.id).cloned().unwrap_or_default();
        let (mut best, mut best_wanted): (Option<(f64, f64)>, Option<(f64, f64)>) = (None, None);
        let mut start = 0.05;
        while start + length <= limit - 0.05 {
            let end = start + length;
            if s.picked.iter().all(|p| end + apart <= p.0 || start >= p.1 + apart) {
                let vals: Vec<f64> = (0..a.samples.len()).filter(|&i| a.samples[i].time >= start && a.samples[i].time <= end).map(|i| s.scores[i]).collect();
                if !vals.is_empty() {
                    let v = window_value(&vals);
                    if best.is_none_or(|b| v > b.1) {
                        best = Some((start, v));
                    }
                    let margin = 0.3f64.min(length / 4.0);
                    if wanted_times.iter().any(|t| *t >= start + margin && *t <= end - margin) && best_wanted.is_none_or(|b| v > b.1) {
                        best_wanted = Some((start, v));
                    }
                }
            }
            start += 0.25;
        }
        best_wanted.or(best)
    };

    let mut shots: Vec<Shot> = vec![];
    let mut shot_beats: Vec<usize> = vec![];
    let mut total = 0.0;
    let mut round = 0;
    while total < target {
        let mut added = 0;
        for i in 0..sources.len() {
            if !(total < target || (recipe.every && round == 0)) {
                continue;
            }
            // A second shot from a clip only if it's long and well away from the first.
            if round > 0 && sources[i].analysis.duration.min(sources[i].asset.duration) < 12.0 {
                continue;
            }
            let apart = if round > 0 { 4.0 } else { 0.3 };
            let mut length = length_for(shots.len());
            let mut beats = beats_for(shots.len());
            let mut found = best_window(&sources[i], length + 0.08, apart);
            if found.is_none() && (beats != short_beats || period.is_none()) {
                beats = short_beats;
                length = period.map(|p| short_beats as f64 * p).unwrap_or(1.6f64.min(per_shot.unwrap_or(1.6)));
                found = best_window(&sources[i], length + 0.08, apart);
            }
            let Some(w) = found else { continue };
            let bar = if round == 0 || total < 18.0 { percentile(&all_scores, 0.12) } else { floor };
            if !((recipe.every && round == 0) || w.1 >= bar) {
                continue;
            }
            // Not two shots from one clip in a row.
            if shots.last().is_some_and(|l| l.asset.id == sources[i].asset.id) && sources.len() > 1 {
                continue;
            }
            sources[i].picked.push((w.0, w.0 + length));
            let lumas: Vec<f64> = sources[i].analysis.samples.iter().filter(|s| s.time >= w.0 && s.time <= w.0 + length).map(|s| s.luma).collect();
            let m = if lumas.is_empty() { 0.45 } else { lumas.iter().sum::<f64>() / lumas.len() as f64 };
            let exposure = (((0.45 / m.max(0.05)).log2() * 0.5).clamp(-0.5, 0.5) * 10.0).round() / 10.0;
            shots.push(Shot { asset: sources[i].asset.clone(), source: w.0, duration: length, exposure, gain_db: 0.0, dissolve: false, score: w.1 });
            shot_beats.push(beats);
            total += length;
            added += 1;
        }
        if added == 0 {
            break;
        }
        round += 1;
        if recipe.every {
            break;
        }
    }
    // Short of the length: shots grow a beat (or a quarter second) at a time, in turn, as far as their clips allow.
    {
        let unit = period.unwrap_or(0.25);
        let mut grew = true;
        while total + unit <= target + 0.05 && grew {
            grew = false;
            for i in 0..shots.len() {
                if total + unit > target + 0.05 {
                    break;
                }
                let s = &shots[i];
                let file_len = sources.iter().find(|x| x.asset.id == s.asset.id).map(|x| x.analysis.duration).unwrap_or(s.asset.duration);
                if s.asset.kind != MediaKind::Video || s.source + s.duration + unit > s.asset.duration.min(file_len) - 0.05 {
                    continue;
                }
                let end = s.source + s.duration + unit;
                let clear = (0..shots.len()).all(|j| {
                    j == i || shots[j].asset.id != s.asset.id || end + 0.1 <= shots[j].source || shots[j].source + shots[j].duration <= s.source
                });
                if !clear {
                    continue;
                }
                shots[i].duration += unit;
                shot_beats[i] += 1;
                total += unit;
                grew = true;
            }
        }
    }
    // Every clip in a length they gave: extra shots come off the end, then the last shot is cut down.
    if recipe.every
        && let Some(limit) = recipe.seconds
    {
        while total > limit + 0.15 && shots.len() > sources.len() {
            total -= shots.pop().map(|s| s.duration).unwrap_or(0.0);
            shot_beats.pop();
        }
        if total > limit + 0.15
            && let Some(last) = shots.len().checked_sub(1)
        {
            if let Some(p) = period {
                while total > limit + 0.15 && shot_beats[last] > 1 {
                    shot_beats[last] -= 1;
                    shots[last].duration -= p;
                    total -= p;
                }
            } else {
                let cut = (total - limit).min(shots[last].duration - 0.3).max(0.0);
                shots[last].duration -= cut;
            }
        }
    }
    if shots.is_empty() {
        return None;
    }
    // A title only when they asked for one: their words, or "Title" to type over.
    let asked = recipe.title.as_ref().map(|t| if t.is_empty() { "Title".to_string() } else { t.clone() }).unwrap_or_default();
    let mut d = Decision {
        shots,
        music: None,
        title: asked,
        look: recipe.look.clone().map(|l| if l == "none" { String::new() } else { l }).unwrap_or_default(),
        bpm: None,
        title_at_end: recipe.title_at_end,
    };
    if let Some((asset, m)) = music.filter(|m| !m.1.beats.is_empty()) {
        d.bpm = Some(m.bpm);
        // The beats cut on: the song's own, or with half beats between them.
        let (mut grid, mut energy) = (m.beats.clone(), m.energy.clone());
        if sub == 2 {
            grid = (0..m.beats.len()).flat_map(|i| if i + 1 < m.beats.len() { vec![m.beats[i], (m.beats[i] + m.beats[i + 1]) / 2.0] } else { vec![m.beats[i]] }).collect();
            energy = m.energy.iter().flat_map(|e| [*e, *e]).collect();
        }
        let bar = 4 * sub;
        let phase = m.bar_phase * sub;
        let step = m.period() / sub as f64;
        // End on a bar: lengthen the last shot to the bar line if its clip allows.
        let count: usize = shot_beats.iter().sum();
        let extra = if recipe.every && recipe.seconds.is_some() { 0 } else { (bar - count % bar) % bar };
        if extra > 0
            && let Some(last) = d.shots.len().checked_sub(1)
        {
            let s = d.shots[last].clone();
            let needed = s.duration + extra as f64 * step;
            let fits = |start: f64| -> bool {
                if s.asset.kind != MediaKind::Video {
                    return true;
                }
                if start < 0.0 || start + needed > s.asset.duration - 0.05 {
                    return false;
                }
                (0..d.shots.len()).all(|j| {
                    j == last || d.shots[j].asset.id != s.asset.id || start + needed + 0.1 <= d.shots[j].source || start >= d.shots[j].source + d.shots[j].duration + 0.1
                })
            };
            if let Some(start) = [s.source, s.source - (needed - s.duration)].into_iter().find(|x| fits(*x)) {
                shot_beats[last] += extra;
                d.shots[last].source = start;
            } else if shot_beats[last] > bar - extra {
                shot_beats[last] -= bar - extra;
            } else if shot_beats[last] == bar - extra && last > 0 && !recipe.every {
                // Exactly the overhang: leave it out.
                shot_beats.pop();
                d.shots.pop();
            }
        }
        let mut total_beats: usize = shot_beats.iter().sum();
        // Drop shots from the end until the song is long enough.
        while total_beats + 2 >= grid.len() && shot_beats.len() > 1 {
            total_beats -= shot_beats.pop().unwrap();
            d.shots.pop();
        }
        // Start the song on a bar where it's lively and lifting.
        let (mut best_b, mut best_s) = (phase, f64::NEG_INFINITY);
        let look = 8 * sub;
        let mut b = phase;
        while b + total_beats + 1 < grid.len() && b + total_beats <= energy.len() {
            let window = &energy[b..b + total_beats];
            let mean = window.iter().map(|v| *v as f64).sum::<f64>() / window.len().max(1) as f64;
            let before = if b >= look { energy[b - look..b].iter().map(|v| *v as f64).sum::<f64>() / look as f64 } else { mean };
            let hi = energy.len().min(b + look);
            let after = energy[b..hi].iter().map(|v| *v as f64).sum::<f64>() / (hi - b).max(1) as f64;
            let s = mean + 0.5 * (after - before).max(0.0) - if b == phase && b < bar { 0.05 } else { 0.0 };
            if s > best_s {
                best_s = s;
                best_b = b;
            }
            b += bar;
        }
        let b0 = best_b;
        // Cut exactly on the song's beats.
        let mut at = b0;
        for (i, shot) in d.shots.iter_mut().enumerate() {
            let next = (at + shot_beats[i]).min(grid.len() - 1);
            shot.duration = grid[next] - grid[at];
            // On the first beat of each four-bar phrase, dissolve rather than cut.
            shot.dissolve = sub == 1 && i > 0 && (at - b0) % 16 == 0;
            at = next;
        }
        let length = grid[at] - grid[b0];
        let tail = (m.duration - grid[at]).clamp(0.0, 1.2);
        d.music = Some(Song { asset: asset.clone(), source: grid[b0], duration: length + tail, fade_out: tail + 0.6 });
        for s in d.shots.iter_mut().filter(|s| s.asset.has_audio) {
            s.gain_db = -16.0;
        }
    } else {
        for (i, s) in d.shots.iter_mut().enumerate() {
            s.dissolve = i > 0 && i % 4 == 0;
        }
    }
    // Keep shots inside their files after any lengthening.
    for s in d.shots.iter_mut().filter(|s| s.asset.kind == MediaKind::Video) {
        s.source = s.source.min(s.asset.duration - s.duration - 0.02).max(0.0);
    }
    Some(d)
}

/// The finished new cut (where Editroom's Choreographer plan lands): shots back to back on V1 with
/// their sound linked on A1, the song on A3, a title on V2 if asked, levels, fades, dissolves and colour.
pub fn build(project: &Project, d: &Decision) -> Option<Project> {
    if d.shots.is_empty() {
        return None;
    }
    let mut base = project.clone();
    base.clips.clear();
    base.in_point = None;
    base.out_point = None;
    while base.video_tracks.len() < 2 {
        base.video_tracks.push(Track::new(TrackKind::Video));
    }
    while base.audio_tracks.len() < if d.music.is_none() { 2 } else { 3 } {
        base.audio_tracks.push(Track::new(TrackKind::Audio));
    }
    for t in base.video_tracks.iter_mut().chain(base.audio_tracks.iter_mut()) {
        t.locked = false;
    }
    let (v1, v2, a1) = (base.video_tracks[0].id, base.video_tracks[1].id, base.audio_tracks[0].id);
    let fps = base.fps;
    let frames = |t: f64| (t * fps).round() / fps;
    // Music first, so it's under everything from the start.
    if let Some(m) = &d.music {
        let dur = frames(m.duration);
        let mut c = Clip { track_id: base.audio_tracks[2].id, kind: ClipKind::Audio, asset_id: Some(m.asset.id), start: 0.0, duration: dur, ..Clip::default() };
        c.source_start = m.source;
        c.fade_in = 0.3;
        c.fade_out = m.fade_out.min(m.duration / 3.0);
        c.gain_db = -2.0;
        c.clamp_fades();
        base.clips.push(c);
    }
    let mut t = 0.0;
    let mut videos: Vec<Id> = vec![];
    let n = d.shots.len();
    for (i, s) in d.shots.iter().enumerate() {
        let (a, b) = (frames(t), frames(t + s.duration));
        let len = (b - a).max(1.0 / fps);
        t += s.duration;
        let image = s.asset.kind == MediaKind::Image;
        let mut v = Clip {
            track_id: v1,
            kind: if image { ClipKind::Image } else { ClipKind::Video },
            asset_id: Some(s.asset.id),
            start: a,
            duration: len,
            source_start: if image { 0.0 } else { s.source },
            ..Clip::default()
        };
        if i > 0 && s.dissolve {
            v.transition_in = Some(Transition { kind: TransitionKind::Dissolve, duration: 0.5 });
        }
        if i == n - 1 {
            v.fade_out = 0.6;
        }
        let mut g = ColorGrade::default();
        if !d.look.is_empty() {
            g.look = Some(d.look.clone());
            g.contrast = 12.0;
            g.saturation = 18.0;
        }
        if s.exposure.abs() >= 0.2 {
            g.exposure = s.exposure;
        }
        v.grade = (!g.is_neutral()).then_some(g);
        v.clamp_fades();
        if s.asset.kind == MediaKind::Video && s.asset.has_audio {
            let link = Id::new();
            v.link_id = Some(link);
            let mut au = Clip { track_id: a1, kind: ClipKind::Audio, asset_id: Some(s.asset.id), start: a, duration: len, source_start: s.source, link_id: Some(link), ..Clip::default() };
            au.gain_db = s.gain_db;
            if i % 2 == 0 {
                au.fade_in = 0.2;
            } else {
                au.fade_out = 0.25;
            }
            au.clamp_fades();
            base.clips.push(au);
        }
        videos.push(v.id);
        base.clips.push(v);
    }
    let total = frames(t);
    // A title on V2 (only one they asked for), at the start or over the last seconds.
    if !d.title.is_empty() {
        let length = (total * 0.12).clamp(2.0, 3.0);
        let start = if d.title_at_end { frames((total - length).max(0.0)) } else { 0.0 };
        let mut title = Clip { track_id: v2, kind: ClipKind::Text, start, duration: frames(length), fade_in: 0.4, fade_out: 0.5, ..Clip::default() };
        title.text.string = d.title.clone();
        title.text.size = 130.0;
        title.clamp_fades();
        base.clips.push(title);
    }
    base.sanitize();
    Some(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, dur: f64) -> MediaAsset {
        MediaAsset {
            id: Id::new(),
            path: format!("/m/{name}"),
            relative_path: None,
            playable_path: None,
            name: name.into(),
            kind: MediaKind::Video,
            duration: dur,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            bookmark: None,
        }
    }

    fn analysis(dur: f64, seed: f64) -> ClipAnalysis {
        let step = (dur / 60.0).max(0.25);
        let samples = (0..((dur / step) as usize))
            .map(|i| {
                let t = step / 2.0 + i as f64 * step;
                Sample { time: t, luma: 0.4 + 0.1 * (t + seed).sin(), sharpness: 200.0 + 100.0 * (t * 0.7 + seed).cos(), motion: 0.02, color: 0.4, faces: 0, aesthetic: None, utility: None }
            })
            .collect();
        ClipAnalysis { duration: dur, created: None, samples }
    }

    #[test]
    fn a_new_cut_from_two_clips() {
        let clips = vec![(asset("a.mov", 20.0), analysis(20.0, 0.0)), (asset("b.mov", 15.0), analysis(15.0, 1.0))];
        let d = decide(&clips, None, &Recipe::default()).expect("a cut");
        assert!(d.shots.len() >= 2);
        assert!(d.shots.windows(2).all(|w| w[0].asset.id != w[1].asset.id), "no clip twice in a row");
        let p = build(&Project::default(), &d).unwrap();
        let v1 = p.video_tracks[0].id;
        let mut on_v1: Vec<&Clip> = p.clips.iter().filter(|c| c.track_id == v1).collect();
        on_v1.sort_by(|a, b| a.start.total_cmp(&b.start));
        assert!(on_v1.windows(2).all(|w| (w[0].end() - w[1].start).abs() < 1e-6), "back to back");
        assert_eq!(p.clips.iter().filter(|c| c.kind == ClipKind::Audio).count(), on_v1.len(), "each with its sound");
    }
}
