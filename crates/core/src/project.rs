//! Queries and edits on a project (the `extension Project` parts of Editroom/Model/Project.swift).
//! Each function follows its Swift original; comments say what it does, not how it differs.

use crate::id::Id;
use crate::model::*;
use std::collections::{HashMap, HashSet};

pub type Ids = HashSet<Id>;

pub const MIN_CLIP: f64 = 1.0 / 60.0;

/// The pieces of a transition into a clip, in timeline seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransitionSpan {
    pub start: f64,
    pub end: f64,
    /// Uses media from before the incoming clip's in point (ends at the cut).
    pub from_head: bool,
}

/// A stretch over which a clip is brought in or taken out by a transition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransitionEdge {
    pub start: f64,
    pub end: f64,
    pub kind: TransitionKind,
}

impl TransitionEdge {
    pub fn progress(&self, t: f64) -> f64 {
        ((t - self.start) / (self.end - self.start).max(1e-6)).clamp(0.0, 1.0)
    }
}

/// How transitions change the way one clip is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct TransitionPlan {
    /// Seconds shown before the clip's start, from media before its in point.
    pub lead_in: f64,
    /// Seconds shown after its end, from media after its out point.
    pub tail_out: f64,
    pub reveal: Option<TransitionEdge>,
    pub conceal: Option<TransitionEdge>,
}

impl Project {
    // MARK: Queries

    pub fn duration(&self) -> f64 {
        self.clips.iter().map(Clip::end).fold(0.0, f64::max)
    }
    pub fn aspect(&self) -> f64 {
        self.width as f64 / self.height.max(1) as f64
    }
    pub fn snap_frame(&self, t: f64) -> f64 {
        (t * self.fps).round() / self.fps
    }
    pub fn asset(&self, id: Option<Id>) -> Option<&MediaAsset> {
        let id = id?;
        self.assets.iter().find(|a| a.id == id)
    }
    pub fn clip(&self, id: Id) -> Option<&Clip> {
        self.clips.iter().find(|c| c.id == id)
    }
    pub fn index_of(&self, id: Id) -> Option<usize> {
        self.clips.iter().position(|c| c.id == id)
    }
    pub fn all_tracks(&self) -> impl Iterator<Item = &Track> {
        self.video_tracks.iter().chain(self.audio_tracks.iter())
    }
    pub fn track(&self, id: Id) -> Option<&Track> {
        self.all_tracks().find(|t| t.id == id)
    }
    pub fn is_locked(&self, track: Id) -> bool {
        self.track(track).is_some_and(|t| t.locked)
    }
    pub fn tracks(&self, kind: TrackKind) -> &[Track] {
        match kind {
            TrackKind::Video => &self.video_tracks,
            TrackKind::Audio => &self.audio_tracks,
        }
    }
    pub fn track_index(&self, id: Id, kind: TrackKind) -> Option<usize> {
        self.tracks(kind).iter().position(|t| t.id == id)
    }

    /// Drops clips on locked tracks.
    pub fn unlocked(&self, ids: &Ids) -> Ids {
        let locked: HashSet<Id> = self.all_tracks().filter(|t| t.locked).map(|t| t.id).collect();
        if locked.is_empty() {
            return ids.clone();
        }
        self.clips
            .iter()
            .filter(|c| ids.contains(&c.id) && !locked.contains(&c.track_id))
            .map(|c| c.id)
            .collect()
    }

    /// Whether an audio track is heard, taking mute and solo into account.
    pub fn is_audible(&self, track: &Track) -> bool {
        if track.muted {
            return false;
        }
        !self.audio_tracks.iter().any(|t| t.solo) || track.solo
    }

    pub fn name_of(&self, clip: &Clip) -> String {
        match clip.kind {
            ClipKind::Text => {
                let s = clip.text.string.replace('\n', " ");
                if s.is_empty() { "Text".into() } else { s }
            }
            ClipKind::Solid => "Solid".into(),
            _ => self.asset(clip.asset_id).map(|a| a.name.clone()).unwrap_or_else(|| "Missing".into()),
        }
    }

    /// Expands a set of clip ids to include everything linked to them.
    pub fn linked(&self, ids: &Ids) -> Ids {
        let links: HashSet<Id> = self.clips.iter().filter(|c| ids.contains(&c.id)).filter_map(|c| c.link_id).collect();
        if links.is_empty() {
            return ids.clone();
        }
        let mut out = ids.clone();
        out.extend(self.clips.iter().filter(|c| c.link_id.is_some_and(|l| links.contains(&l))).map(|c| c.id));
        out
    }

    pub fn source_limit(&self, clip: &Clip) -> Option<f64> {
        if !clip.plays_source() {
            return None;
        }
        self.asset(clip.asset_id).map(|a| a.duration)
    }

    pub fn marker_list(&self) -> Vec<Marker> {
        let mut m = self.markers.clone().unwrap_or_default();
        m.sort_by(|a, b| a.time.total_cmp(&b.time));
        m
    }

    /// The in/out range, if one is set and longer than a frame.
    pub fn play_range(&self) -> Option<(f64, f64)> {
        if self.in_point.is_none() && self.out_point.is_none() {
            return None;
        }
        let a = self.in_point.unwrap_or(0.0);
        let b = self.out_point.unwrap_or_else(|| self.duration());
        let (lo, hi) = (a.min(b), a.max(b));
        if hi - lo >= 1.0 / self.fps { Some((lo, hi)) } else { None }
    }

    /// Just the in/out range, moved to start at zero.
    pub fn cropped(&self, range: (f64, f64)) -> Project {
        let mut p = self.clone();
        let all: Ids = p.clips.iter().map(|c| c.id).collect();
        p.split(&all, range.0);
        let all: Ids = p.clips.iter().map(|c| c.id).collect();
        p.split(&all, range.1);
        p.clips.retain(|c| !(c.end() <= range.0 + 1e-6 || c.start >= range.1 - 1e-6));
        for c in &mut p.clips {
            c.start -= range.0;
        }
        p.markers = p.markers.map(|ms| {
            ms.into_iter()
                .filter(|m| m.time >= range.0 && m.time <= range.1)
                .map(|mut m| {
                    m.time -= range.0;
                    m
                })
                .collect()
        });
        p.in_point = None;
        p.out_point = None;
        p
    }

    pub fn snap_targets(&self, excluding: &Ids) -> Vec<f64> {
        let mut out = vec![0.0];
        out.extend(self.markers.iter().flatten().map(|m| m.time));
        out.extend(self.in_point);
        out.extend(self.out_point);
        for c in self.clips.iter().filter(|c| !excluding.contains(&c.id)) {
            out.push(c.start);
            out.push(c.end());
        }
        out
    }

    /// Sorted, de-duplicated edit points for playhead jumping.
    pub fn edit_points(&self) -> Vec<f64> {
        let mut v = vec![0.0];
        for c in &self.clips {
            v.push(c.start);
            v.push(c.end());
        }
        v.extend(self.markers.iter().flatten().map(|m| m.time));
        v.sort_by(f64::total_cmp);
        v.dedup();
        v
    }

    /// Allowed delta range for dragging a clip edge.
    pub fn trim_limits(&self, c: &Clip, left: bool, excluding: &Ids) -> (f64, f64) {
        let others: Vec<&Clip> = self
            .clips
            .iter()
            .filter(|o| o.track_id == c.track_id && !excluding.contains(&o.id) && o.id != c.id)
            .collect();
        let min_dur = MIN_CLIP.max(1.0 / self.fps);
        if left {
            let prev_end = others.iter().filter(|o| o.end() <= c.start + 1e-6).map(|o| o.end()).fold(0.0, f64::max);
            let mut lo = prev_end - c.start;
            if c.plays_source() {
                lo = lo.max(-c.timeline_span(0.0, c.source_start));
            }
            let hi = c.duration - min_dur;
            (lo.min(hi), hi)
        } else {
            let next_start =
                others.iter().filter(|o| o.start >= c.end() - 1e-6).map(|o| o.start).fold(f64::INFINITY, f64::min);
            let mut hi = next_start - c.end();
            if let Some(limit) = self.source_limit(c) {
                hi = hi.min(c.timeline_span(c.source_start, limit) - c.duration);
            }
            let lo = min_dur - c.duration;
            (lo, lo.max(hi))
        }
    }

    /// First track of a kind (bottom-up for video, top-down for audio) empty across a range.
    pub fn free_track(&self, kind: TrackKind, start: f64, duration: f64) -> Option<Id> {
        self.tracks(kind).iter().filter(|t| !t.locked).map(|t| t.id).find(|&tid| {
            !self
                .clips
                .iter()
                .any(|c| c.track_id == tid && c.start < start + duration - 1e-6 && c.end() > start + 1e-6)
        })
    }

    /// The earliest place at or after `time` where a clip of this length fits on an open video
    /// track, preferring lower tracks when two are equally early.
    pub fn first_free_video_spot(&self, time: f64, duration: f64) -> Option<(Id, f64)> {
        let mut best: Option<(Id, f64)> = None;
        for t in self.video_tracks.iter().filter(|t| !t.locked) {
            let mut here: Vec<&Clip> = self.clips.iter().filter(|c| c.track_id == t.id).collect();
            here.sort_by(|a, b| a.start.total_cmp(&b.start));
            let mut candidates: Vec<f64> = std::iter::once(time).chain(here.iter().map(|c| c.end()).filter(|&e| e > time)).collect();
            candidates.sort_by(f64::total_cmp);
            for start in candidates {
                let busy = here.iter().any(|c| c.start < start + duration - 1e-6 && c.end() > start + 1e-6);
                if !busy {
                    if best.is_none_or(|b| start < b.1 - 1e-9) {
                        best = Some((t.id, start));
                    }
                    break;
                }
            }
        }
        best
    }

    // MARK: Mutations

    pub fn add_track(&mut self, kind: TrackKind) -> Id {
        let t = Track::new(kind);
        let id = t.id;
        match kind {
            TrackKind::Video => self.video_tracks.push(t),
            TrackKind::Audio => self.audio_tracks.push(t),
        }
        id
    }

    pub fn remove_track(&mut self, id: Id) {
        if let Some(i) = self.video_tracks.iter().position(|t| t.id == id).filter(|_| self.video_tracks.len() > 1) {
            self.video_tracks.remove(i);
            self.clips.retain(|c| c.track_id != id);
        } else if let Some(i) = self.audio_tracks.iter().position(|t| t.id == id).filter(|_| self.audio_tracks.len() > 1)
        {
            self.audio_tracks.remove(i);
            self.clips.retain(|c| c.track_id != id);
        }
    }

    pub fn update_track(&mut self, id: Id, body: impl Fn(&mut Track)) {
        for t in self.video_tracks.iter_mut().chain(self.audio_tracks.iter_mut()) {
            if t.id == id {
                body(t);
            }
        }
    }

    /// Replaces placeholder track tokens with freshly created tracks.
    pub fn materialize_tokens(&mut self) {
        let (mut new_v, mut new_a) = (None, None);
        for i in 0..self.clips.len() {
            if self.clips[i].track_id == track_token::NEW_VIDEO {
                let id = *new_v.get_or_insert_with(|| self.add_track(TrackKind::Video));
                self.clips[i].track_id = id;
            } else if self.clips[i].track_id == track_token::NEW_AUDIO {
                let id = *new_a.get_or_insert_with(|| self.add_track(TrackKind::Audio));
                self.clips[i].track_id = id;
            }
        }
    }

    /// Overwrite edit: the given clips win, anything underneath is trimmed, split or removed.
    pub fn resolve_overlaps(&mut self, keeping: &Ids) {
        let eps = 1e-6;
        let mut rights: HashMap<Id, (Id, f64, f64)> = HashMap::new();
        let movers: Vec<Clip> = self.clips.iter().filter(|c| keeping.contains(&c.id)).cloned().collect();
        for m in movers {
            let mut result = Vec::with_capacity(self.clips.len() + 1);
            for c in std::mem::take(&mut self.clips) {
                let mut c = c;
                if keeping.contains(&c.id) || c.track_id != m.track_id || c.end() <= m.start + eps || c.start >= m.end() - eps
                {
                    result.push(c);
                    continue;
                }
                let head = c.start < m.start - eps;
                let tail = c.end() > m.end() + eps;
                if head && tail {
                    let mut right = c.clone();
                    right.id = Id::new();
                    right.link_id = None;
                    if let Some(link) = c.link_id {
                        rights.insert(right.id, (link, m.start, m.end()));
                    }
                    right.fade_in = 0.0;
                    right.trim_head(m.end());
                    c.fade_out = 0.0;
                    c.trim_tail(m.start);
                    result.push(c);
                    result.push(right);
                } else if head {
                    c.trim_tail(m.start);
                    result.push(c);
                } else if tail {
                    c.trim_head(m.end());
                    result.push(c);
                }
            }
            self.clips = result;
        }
        // Right-hand pieces of a linked pair split by the same drop are linked to each other.
        let mut groups: HashMap<String, Vec<Id>> = HashMap::new();
        for (id, (link, from, to)) in &rights {
            groups
                .entry(format!("{link}|{}|{}", (from * 1000.0).round(), (to * 1000.0).round()))
                .or_default()
                .push(*id);
        }
        for pieces in groups.values() {
            let kinds: HashSet<TrackKind> =
                pieces.iter().filter_map(|p| self.clip(*p)).map(|c| c.kind.track_kind()).collect();
            if pieces.len() <= 1 || kinds.len() <= 1 {
                continue;
            }
            let link = Id::new();
            for p in pieces {
                if let Some(i) = self.index_of(*p) {
                    self.clips[i].link_id = Some(link);
                }
            }
        }
    }

    /// Splits clips at a time. Returns ids of the new right-hand pieces.
    pub fn split(&mut self, ids: &Ids, t: f64) -> Ids {
        let min_dur = 0.5 / self.fps;
        let mut created = Ids::new();
        let mut link_map: HashMap<Id, Id> = HashMap::new();
        // In clip order, so results don't depend on hash order.
        let order: Vec<Id> = self.clips.iter().filter(|c| ids.contains(&c.id)).map(|c| c.id).collect();
        for id in order {
            let Some(i) = self.index_of(id) else { continue };
            let c = self.clips[i].clone();
            if !(t > c.start + min_dur && t < c.end() - min_dur) {
                continue;
            }
            let mut right = c.clone();
            right.id = Id::new();
            right.fade_in = 0.0;
            right.trim_head(t);
            if let Some(l) = c.link_id {
                right.link_id = Some(*link_map.entry(l).or_insert_with(Id::new));
            }
            self.clips[i].fade_out = 0.0;
            self.clips[i].trim_tail(t);
            created.insert(right.id);
            self.clips.push(right);
        }
        created
    }

    pub fn remove(&mut self, ids: &Ids, ripple: bool) {
        let mut removed: Vec<Clip> = self.clips.iter().filter(|c| ids.contains(&c.id)).cloned().collect();
        removed.sort_by(|a, b| b.start.total_cmp(&a.start));
        self.clips.retain(|c| !ids.contains(&c.id));
        if !ripple {
            return;
        }
        for r in removed {
            for c in self.clips.iter_mut() {
                if c.track_id == r.track_id && c.start >= r.end() - 1e-6 {
                    c.start = (c.start - r.duration).max(0.0);
                }
            }
        }
    }

    /// Takes the time from `a` to `b` out of these tracks and closes it up.
    pub fn ripple_remove(&mut self, a: f64, b: f64, tracks: &Ids) {
        let tracks: Ids = tracks.iter().filter(|t| !self.is_locked(**t)).copied().collect();
        let gap = b - a;
        if gap <= 1e-9 || tracks.is_empty() {
            return;
        }
        let at_a: Ids =
            self.clips.iter().filter(|c| tracks.contains(&c.track_id) && c.start < a && c.end() > a).map(|c| c.id).collect();
        self.split(&at_a, a);
        let at_b: Ids =
            self.clips.iter().filter(|c| tracks.contains(&c.track_id) && c.start < b && c.end() > b).map(|c| c.id).collect();
        self.split(&at_b, b);
        let eps = 0.5 / self.fps;
        self.clips.retain(|c| !(tracks.contains(&c.track_id) && c.start >= a - eps && c.end() <= b + eps));
        for c in self.clips.iter_mut() {
            if tracks.contains(&c.track_id) && c.start >= b - eps {
                c.start = (c.start - gap).max(0.0);
            }
        }
    }

    /// Changes playback speed of the given clips, keeping each one's source span.
    pub fn set_speed(&mut self, ids: &Ids, speed: f64, sticky: bool) {
        let speed = speed.clamp(0.05, 100.0);
        self.retime(ids, sticky, &|c: &mut Clip| c.speed = speed);
    }

    /// Sets the speed ramp drawn in the inspector on these clips.
    pub fn set_ramp(&mut self, ids: &Ids, speed: f64, points: (f64, f64, f64, f64), start: f64, end: f64, sticky: bool) {
        let clamp = |v: f64| v.clamp(0.05, 100.0);
        self.retime(ids, sticky, &|c: &mut Clip| {
            let s0 = c.source_start;
            let s1 = c.source_start + c.source_length();
            c.speed = clamp(speed);
            c.ramp = SpeedRamp::drawn(s0, s1, points, clamp(start), clamp(end), c.speed);
        });
    }

    /// Changes how the given clips play, each keeping its footage so its length follows.
    pub fn retime(&mut self, ids: &Ids, sticky: bool, change: &dyn Fn(&mut Clip)) {
        if sticky {
            let mut plain = self.clone();
            plain.retime(ids, false, change);
            let edited: HashMap<Id, Clip> =
                plain.clips.iter().filter(|c| ids.contains(&c.id)).map(|c| (c.id, c.clone())).collect();
            let carried = self.carried(&edited);
            for c in self.clips.iter_mut() {
                if let Some(n) = edited.get(&c.id).or_else(|| carried.get(&c.id)) {
                    *c = n.clone();
                }
            }
            return;
        }
        let fps = self.fps;
        let snap = move |t: f64| (t * fps).round() / fps;
        let track_ids: Vec<Id> = self.all_tracks().map(|t| t.id).collect();
        for track in track_ids {
            let mut order: Vec<usize> = (0..self.clips.len()).filter(|&i| self.clips[i].track_id == track).collect();
            order.sort_by(|&a, &b| self.clips[a].start.total_cmp(&self.clips[b].start));
            if !order.iter().any(|&i| ids.contains(&self.clips[i].id) && self.clips[i].plays_source()) {
                continue;
            }
            let mut shift = 0.0;
            let mut prev_end = 0.0;
            for i in order {
                let mut c = self.clips[i].clone();
                if ids.contains(&c.id) && c.plays_source() {
                    let before = c.duration;
                    c.retime(snap, 1.0 / fps, change);
                    c.start += shift;
                    shift += c.duration - before;
                } else if ids.contains(&c.id) {
                    c.start += shift;
                }
                c.start = c.start.max(prev_end);
                prev_end = c.end();
                self.clips[i] = c;
            }
        }
    }

    /// Sticky edges: when edited clips' ends move, clips touching those ends ride along.
    pub fn carried(&self, edited: &HashMap<Id, Clip>) -> HashMap<Id, Clip> {
        let touch = 0.5 / self.fps;
        let mut out: HashMap<Id, Clip> = HashMap::new();
        let mut queue: std::collections::VecDeque<(Id, f64, f64)> = std::collections::VecDeque::new();
        // In clip order, for stable results.
        for c in &self.clips {
            if let Some(e) = edited.get(&c.id) {
                queue.push_back((c.track_id, c.end(), e.end()));
            }
        }
        while let Some((track, old_end, new_end)) = queue.pop_front() {
            let shift = new_end - old_end;
            if shift.abs() <= 1e-9 || self.is_locked(track) {
                continue;
            }
            let after: Vec<&Clip> = self
                .clips
                .iter()
                .filter(|c| c.track_id == track && !edited.contains_key(&c.id) && c.start >= old_end - touch)
                .collect();
            let Some(nearest) = after.iter().map(|c| c.start).reduce(f64::min) else { continue };
            for c in after {
                if !(c.start <= nearest + 1e-9 && !out.contains_key(&c.id)) {
                    continue;
                }
                let touching = (c.start - old_end).abs() <= touch;
                let run_into = shift > 0.0 && c.start < new_end - 1e-9;
                if !(touching || run_into) {
                    continue;
                }
                let s = new_end - c.start;
                let group: Ids = [c.id].into_iter().collect();
                for id in self.linked(&group) {
                    if edited.contains_key(&id) || out.contains_key(&id) {
                        continue;
                    }
                    let Some(m) = self.clip(id) else { continue };
                    let mut m = m.clone();
                    let old = m.end();
                    m.start += s;
                    queue.push_back((m.track_id, old, m.end()));
                    out.insert(id, m);
                }
            }
        }
        out
    }

    /// True when applying `changed` leaves nothing before zero and no overlaps on a track.
    pub fn fits(&self, changed: &HashMap<Id, Clip>) -> bool {
        if changed.values().any(|c| c.start < -1e-9) {
            return false;
        }
        let mut by_track: HashMap<Id, Vec<&Clip>> = HashMap::new();
        for c in &self.clips {
            let c = changed.get(&c.id).unwrap_or(c);
            by_track.entry(c.track_id).or_default().push(c);
        }
        for group in by_track.values_mut() {
            group.sort_by(|a, b| a.start.total_cmp(&b.start));
            for w in group.windows(2) {
                let (a, b) = (w[0], w[1]);
                if (changed.contains_key(&a.id) || changed.contains_key(&b.id)) && a.end() > b.start + 1e-6 {
                    return false;
                }
            }
        }
        true
    }

    // MARK: Transitions

    /// The clip ending where this one starts, on the same track.
    pub fn previous_touching(&self, c: &Clip) -> Option<&Clip> {
        let tol = 0.5 / self.fps;
        self.clips
            .iter()
            .find(|o| o.id != c.id && o.track_id == c.track_id && o.kind != ClipKind::Audio && (o.end() - c.start).abs() <= tol)
    }

    /// The clip starting where this one ends, on the same track.
    pub fn next_touching(&self, c: &Clip) -> Option<&Clip> {
        let tol = 0.5 / self.fps;
        self.clips
            .iter()
            .find(|o| o.id != c.id && o.track_id == c.track_id && o.kind != ClipKind::Audio && (o.start - c.end()).abs() <= tol)
    }

    fn head_room(&self, c: &Clip) -> f64 {
        if c.plays_source() { c.timeline_span(0.0, c.source_start) } else { f64::INFINITY }
    }

    fn tail_room(&self, c: &Clip) -> f64 {
        match (c.plays_source(), self.source_limit(c)) {
            (true, Some(limit)) => c.timeline_span(c.source_start + c.source_length(), limit).max(0.0),
            _ => f64::INFINITY,
        }
    }

    /// Where the transition into `b` from `a` sits.
    pub fn transition_span(&self, a: &Clip, b: &Clip) -> Option<TransitionSpan> {
        let t = b.transition_in?;
        if b.kind == ClipKind::Audio || a.kind == ClipKind::Audio {
            return None;
        }
        let cut = b.start;
        let frame = 1.0 / self.fps;
        if t.kind == TransitionKind::DipToBlack {
            let d = t.duration.min(2.0 * a.duration).min(2.0 * b.duration);
            return (d >= frame).then_some(TransitionSpan { start: cut - d / 2.0, end: cut + d / 2.0, from_head: false });
        }
        let want = t.duration.min(a.duration).min(b.duration);
        let head = self.head_room(b);
        let tail = self.tail_room(a);
        if head >= want {
            return Some(TransitionSpan { start: cut - want, end: cut, from_head: true });
        }
        if tail >= want {
            return Some(TransitionSpan { start: cut, end: cut + want, from_head: false });
        }
        let d = head.max(tail);
        if d < frame {
            return None;
        }
        Some(if head >= tail {
            TransitionSpan { start: cut - d, end: cut, from_head: true }
        } else {
            TransitionSpan { start: cut, end: cut + d, from_head: false }
        })
    }

    /// How transitions on either side of a clip change the way it's drawn.
    pub fn transition_plan(&self, c: &Clip) -> TransitionPlan {
        let mut plan = TransitionPlan::default();
        if c.kind == ClipKind::Audio {
            return plan;
        }
        if let (Some(a), Some(kind)) = (self.previous_touching(c), c.transition_in.map(|t| t.kind))
            && let Some(span) = self.transition_span(a, c)
        {
            if kind == TransitionKind::DipToBlack {
                plan.reveal = Some(TransitionEdge { start: c.start, end: span.end, kind });
            } else {
                plan.reveal = Some(TransitionEdge { start: span.start, end: span.end, kind });
                if span.from_head {
                    plan.lead_in = c.start - span.start;
                }
            }
        }
        if let Some(b) = self.next_touching(c)
            && let (Some(span), Some(kind)) = (self.transition_span(c, b), b.transition_in.map(|t| t.kind))
        {
            if kind == TransitionKind::DipToBlack {
                plan.conceal = Some(TransitionEdge { start: span.start, end: c.end(), kind });
            } else if !span.from_head {
                plan.tail_out = span.end - c.end();
            }
        }
        plan
    }

    // MARK: Gaps

    /// The empty stretch on a track around a time. None if on a clip or past the last one.
    pub fn gap(&self, track: Id, t: f64) -> Option<(f64, f64)> {
        let here: Vec<&Clip> = self.clips.iter().filter(|c| c.track_id == track).collect();
        if here.iter().any(|c| t >= c.start && t < c.end()) {
            return None;
        }
        let before = here.iter().filter(|c| c.end() <= t + 1e-9).map(|c| c.end()).fold(0.0, f64::max);
        let after = here.iter().filter(|c| c.start >= t - 1e-9).map(|c| c.start).reduce(f64::min)?;
        (after - before > 1e-6).then_some((before, after))
    }

    /// Pulls everything on a track from a time onward left, with linked clips moving too.
    /// Returns how far it moved.
    pub fn pull_left(&mut self, track: Id, time: f64, amount: f64) -> f64 {
        if self.is_locked(track) || amount <= 1e-9 {
            return 0.0;
        }
        let on: Ids = self.clips.iter().filter(|c| c.track_id == track && c.start >= time - 1e-6).map(|c| c.id).collect();
        let movers = self.unlocked(&self.linked(&on));
        if movers.is_empty() {
            return 0.0;
        }
        let moved = |p: &Project, d: f64| -> HashMap<Id, Clip> {
            p.clips
                .iter()
                .filter(|c| movers.contains(&c.id))
                .map(|c| {
                    let mut m = c.clone();
                    m.start -= d;
                    (c.id, m)
                })
                .collect()
        };
        let mut d = amount;
        if !self.fits(&moved(self, d)) {
            let (mut ok, mut bad) = (0.0, d);
            for _ in 0..30 {
                let mid = (ok + bad) / 2.0;
                if self.fits(&moved(self, mid)) {
                    ok = mid;
                } else {
                    bad = mid;
                }
            }
            d = if self.snap_frame(ok) <= ok + 1e-9 { self.snap_frame(ok) } else { ok };
            if !self.fits(&moved(self, d)) {
                d = ok;
            }
        }
        if d <= 1e-9 {
            return 0.0;
        }
        for (id, c) in moved(self, d) {
            if let Some(i) = self.index_of(id) {
                self.clips[i] = c;
            }
        }
        d
    }

    /// Closes every gap between clips on a track, so they run back to back from the first clip.
    pub fn close_all_gaps(&mut self, track: Id) {
        for _ in 0..500 {
            let mut here: Vec<&Clip> = self.clips.iter().filter(|c| c.track_id == track).collect();
            here.sort_by(|a, b| a.start.total_cmp(&b.start));
            let Some(i) = (0..here.len().saturating_sub(1)).find(|&i| here[i + 1].start - here[i].end() > 1e-6) else {
                return;
            };
            let (next_start, shift) = (here[i + 1].start, here[i + 1].start - here[i].end());
            if self.pull_left(track, next_start, shift) < 1e-9 {
                return;
            }
        }
    }

    /// Breaks the link between the given clips and their partners.
    pub fn unlink(&mut self, ids: &Ids) {
        let all = self.linked(ids);
        for c in self.clips.iter_mut().filter(|c| all.contains(&c.id)) {
            c.link_id = None;
        }
    }

    /// After files got shorter: clips reaching past the new end stop there; ones past it go.
    pub fn fit_clips_to_media(&mut self, ids: &Ids) {
        let mut gone = Ids::new();
        for i in 0..self.clips.len() {
            let c = self.clips[i].clone();
            let Some(aid) = c.asset_id else { continue };
            if !ids.contains(&aid) {
                continue;
            }
            let Some(limit) = self.source_limit(&c) else { continue };
            if !(limit > 0.0 && c.source_start + c.source_length() > limit + 1e-4) {
                continue;
            }
            if c.source_start >= limit - 1e-3 {
                gone.insert(c.id);
                continue;
            }
            let (mut lo, mut hi) = (c.start, c.end());
            for _ in 0..40 {
                let m = (lo + hi) / 2.0;
                if c.source_time(m) < limit {
                    lo = m;
                } else {
                    hi = m;
                }
            }
            self.clips[i].trim_tail(lo);
        }
        self.clips.retain(|c| !gone.contains(&c.id));
    }

    pub fn sanitize(&mut self) {
        let track_ids: HashSet<Id> = self.all_tracks().map(|t| t.id).collect();
        self.clips.retain(|c| track_ids.contains(&c.track_id) && c.duration > 1e-6);
        for c in self.clips.iter_mut() {
            c.start = c.start.max(0.0);
            c.clamp_fades();
            let len = c.duration;
            if let Some(z) = c.transform.as_mut().and_then(|t| t.zoom.as_mut()) {
                z.fit(len);
            }
        }
        if self.captions.is_some() && !self.clips.iter().any(|c| c.captioned == Some(true)) {
            self.captions = None;
            self.caption_fixes = None;
        }
    }

    // MARK: Paths

    /// Records where each file sits relative to the project's folder.
    pub fn stamp_relative_paths(&mut self, project_dir: &std::path::Path) {
        for a in self.assets.iter_mut() {
            a.relative_path = Some(crate::paths::relative(project_dir, std::path::Path::new(&a.path)));
        }
        for f in self.folders.iter_mut().flatten() {
            f.relative_path = Some(crate::paths::relative(project_dir, std::path::Path::new(&f.path)));
        }
    }
}

pub fn db_to_linear(db: f64) -> f64 {
    if db <= -59.5 { 0.0 } else { 10f64.powf(db / 20.0) }
}

pub fn format_db(db: f64) -> String {
    if db <= -59.5 {
        return "−∞ dB".into();
    }
    let v = (db * 10.0).round() / 10.0;
    let sign = if v > 0.0 { "+" } else if v < 0.0 { "−" } else { "" };
    format!("{sign}{:.1} dB", v.abs())
}
