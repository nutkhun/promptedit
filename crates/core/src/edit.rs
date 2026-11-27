//! Editing commands: the operations the timeline, menus, inspector and MCP tools perform
//! (docs/spec/01-model.md §3). Each `Edit` is applied to a `Document` as one undo step,
//! or as a live change (drags, sliders) that commits to one step.

use crate::history::Document;
use crate::id::Id;
use crate::model::*;
use crate::project::Ids;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Something to put on the timeline.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Payload {
    Asset { id: Id },
    Text,
    Solid,
}

/// How long a payload lasts when added: a file's length (in whole frames), 5 s otherwise.
pub fn payload_duration(p: &Project, payload: &Payload) -> f64 {
    match payload {
        Payload::Asset { id } => match p.asset(Some(*id)) {
            Some(a) if a.kind != MediaKind::Image => (1.0 / p.fps).max((a.duration * p.fps + 1e-6).floor() / p.fps),
            _ => 5.0,
        },
        _ => 5.0,
    }
}

/// The clips for a payload at `start`: a video gets its sound on `audio_track`, linked.
pub fn make_clips(p: &Project, payload: &Payload, start: f64, video_track: Id, audio_track: Id) -> Vec<Clip> {
    let duration = payload_duration(p, payload);
    let base = |kind: ClipKind, track: Id| Clip { track_id: track, kind, start, duration, ..Clip::default() };
    match payload {
        Payload::Solid => vec![base(ClipKind::Solid, video_track)],
        Payload::Text => vec![base(ClipKind::Text, video_track)],
        Payload::Asset { id } => {
            let Some(a) = p.asset(Some(*id)) else { return vec![] };
            match a.kind {
                MediaKind::Image => vec![Clip { asset_id: Some(a.id), ..base(ClipKind::Image, video_track) }],
                MediaKind::Audio => vec![Clip { asset_id: Some(a.id), ..base(ClipKind::Audio, audio_track) }],
                MediaKind::Video => {
                    let mut v = Clip { asset_id: Some(a.id), ..base(ClipKind::Video, video_track) };
                    if !a.has_audio {
                        return vec![v];
                    }
                    let link = Id::new();
                    v.link_id = Some(link);
                    let s = Clip { asset_id: Some(a.id), link_id: Some(link), ..base(ClipKind::Audio, audio_track) };
                    vec![v, s]
                }
            }
        }
    }
}

/// A partial change to clips, for the inspector and the timeline's handles. Fields left out
/// are unchanged; `Some(None)` clears an optional field.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ClipPatch {
    pub fade_in: Option<f64>,
    pub fade_out: Option<f64>,
    #[serde(deserialize_with = "double_option")]
    pub fade_in_curve: Option<Option<FadeCurve>>,
    #[serde(deserialize_with = "double_option")]
    pub fade_out_curve: Option<Option<FadeCurve>>,
    #[serde(rename = "gainDB")]
    pub gain_db: Option<f64>,
    pub color: Option<Rgba>,
    pub text: Option<TextStyle>,
    #[serde(deserialize_with = "double_option")]
    pub grade: Option<Option<ColorGrade>>,
    #[serde(deserialize_with = "double_option")]
    pub transform: Option<Option<ClipTransform>>,
    #[serde(deserialize_with = "double_option")]
    pub transition_in: Option<Option<Transition>>,
}

/// Missing key → `None` (unchanged); `null` → `Some(None)` (clear); value → `Some(Some(v))`.
fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// A change to a track's switches and levels.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct TrackPatch {
    pub hidden: Option<bool>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
    pub locked: Option<bool>,
    #[serde(rename = "gainDB")]
    pub gain_db: Option<f64>,
    #[serde(deserialize_with = "double_option")]
    pub duck_under: Option<Option<Id>>,
    #[serde(rename = "duckDB")]
    pub duck_db: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Edit {
    /// Put payloads end to end from `start` (an overwrite edit). Track ids may be
    /// `track_token::NEW_VIDEO` / `NEW_AUDIO` for a new track.
    Add { payloads: Vec<Payload>, start: f64, video_track: Id, audio_track: Id, snap: bool },
    /// Add at the playhead the way double-click / "Add to Timeline" does.
    AddAtPlayhead { payloads: Vec<Payload>, playhead: f64 },
    /// Commit a drag (move or trim): the clips' new states, then overwrite what's beneath.
    Place { clips: Vec<Clip> },
    /// Insert copies (paste, ⌥-drag): fresh ids and links, overwrite edit.
    Insert { clips: Vec<Clip>, at: f64 },
    /// Copies of the clips right after the selection (⇧⌘D).
    Duplicate { ids: Vec<Id> },
    Split { ids: Vec<Id>, at: f64 },
    /// ⌘K: the selected clips under the playhead, or every clip under it.
    SplitAtPlayhead { selection: Vec<Id>, playhead: f64 },
    Delete { ids: Vec<Id>, ripple: bool },
    /// Q / W.
    RippleTrim { selection: Vec<Id>, playhead: f64, head: bool },
    Reverse { selection: Vec<Id> },
    FreezeFrame { selection: Vec<Id>, playhead: f64 },
    SetTransition { id: Id, transition: Option<Transition> },
    /// ⌘D.
    AddDissolve { selection: Vec<Id>, playhead: f64 },
    DetachAudio { ids: Vec<Id> },
    DeleteGap { track: Id, at: f64 },
    CloseAllGaps { tracks: Vec<Id> },
    SetSpeed { ids: Vec<Id>, speed: f64, sticky: bool },
    SetRamp { ids: Vec<Id>, speed: f64, points: (f64, f64, f64, f64), start: f64, end: f64, sticky: bool },
    Update { ids: Vec<Id>, patch: ClipPatch },
    /// ⌥⌘V: every selected visual clip gets this grade (None clears it).
    PasteGrade { ids: Vec<Id>, grade: Option<ColorGrade> },
    AddTrack { kind: TrackKind },
    RemoveTrack { id: Id },
    SetTrack { id: Id, patch: TrackPatch },
    SetSequence { width: i64, height: i64 },
    SetFps { fps: f64 },
    MatchSequence { asset: Id },
    RemoveAssets { ids: Vec<Id> },
    AddMarker { playhead: f64 },
    UpdateMarker { marker: Marker },
    RemoveMarker { id: Id },
    ClearMarkers,
    SetIn { playhead: f64 },
    SetOut { playhead: f64 },
    ClearInOut,
    AddCaptions { ids: Vec<Id> },
    RemoveCaptions { ids: Vec<Id> },
    RemoveCaptionTrack,
    SetCaptionsHidden { hidden: bool },
    SetCaptionStyle { style: CaptionStyle },
    /// Word fixes for one file's transcript (a retyped or deleted caption). Each fix replaces
    /// any existing fix for the same word (same source start within 0.5 ms).
    SetCaptionFixes { asset: Id, fixes: Vec<CaptionFix> },
    /// Clip gains worked out from waveforms (Even Out Levels).
    SetGains { gains: HashMap<Id, f64> },
}

/// Frame rates offered for a sequence.
pub const STANDARD_FPS: &[f64] = &[23.976, 24.0, 25.0, 29.97, 30.0, 48.0, 50.0, 59.94, 60.0];

pub fn standard_fps(fps: f64) -> f64 {
    if fps <= 1.0 {
        return 30.0;
    }
    *STANDARD_FPS.iter().min_by(|a, b| (*a - fps).abs().total_cmp(&(*b - fps).abs())).unwrap()
}

pub const SEQUENCE_PRESETS: &[(i64, i64)] =
    &[(3840, 2160), (2560, 1440), (1920, 1080), (1280, 720), (1080, 1920), (2160, 3840), (1080, 1080)];

fn set(v: &[Id]) -> Ids {
    v.iter().copied().collect()
}

impl Project {
    /// Clips with fresh ids and consistent fresh links, moved so the earliest starts at `at`.
    /// Tracks that are gone or locked become the first unlocked track of the kind, or a new one.
    pub fn placed(&self, clips: &[Clip], at: f64) -> Vec<Clip> {
        let t0 = clips.iter().map(|c| c.start).fold(f64::INFINITY, f64::min);
        let mut links: HashMap<Id, Id> = HashMap::new();
        clips
            .iter()
            .map(|c| {
                let mut n = c.clone();
                n.id = Id::new();
                n.link_id = c.link_id.map(|l| *links.entry(l).or_insert_with(Id::new));
                n.start = at + (c.start - t0);
                let kind = c.kind.track_kind();
                if self.track(n.track_id).is_none_or(|t| t.locked) {
                    n.track_id = self.tracks(kind).iter().find(|t| !t.locked).map(|t| t.id).unwrap_or(match kind {
                        TrackKind::Video => track_token::NEW_VIDEO,
                        TrackKind::Audio => track_token::NEW_AUDIO,
                    });
                }
                n
            })
            .collect()
    }

    /// Append clips as an overwrite edit. Returns their ids.
    pub fn insert(&mut self, clips: Vec<Clip>) -> Ids {
        let ids: Ids = clips.iter().map(|c| c.id).collect();
        self.clips.extend(clips);
        self.materialize_tokens();
        self.resolve_overlaps(&ids);
        ids
    }

    fn under(&self, t: f64) -> Vec<&Clip> {
        self.clips.iter().filter(|c| c.start < t && t < c.end()).collect()
    }
}

/// What an edit did, for the UI: the selection to show and where the playhead goes.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub selection: Option<Vec<Id>>,
    pub seek: Option<f64>,
}

impl Edit {
    /// Applies the edit as one undo step.
    pub fn apply(&self, doc: &mut Document) -> Outcome {
        let mut out = Outcome::default();
        out.changed = doc.mutate(|p| run(self, p, &mut out));
        out
    }

    /// Applies the edit as part of a continuous change (commit with `Document::commit_live`).
    pub fn apply_live(&self, doc: &mut Document) -> Outcome {
        let mut out = Outcome::default();
        out.changed = doc.live(|p| run(self, p, &mut out));
        out
    }
}

fn run(edit: &Edit, p: &mut Project, out: &mut Outcome) {
    let fps = p.fps;
    match edit {
        Edit::Add { payloads, start, video_track, audio_track, snap } => {
            let mut t = *start;
            let mut clips = vec![];
            for pl in payloads {
                clips.extend(make_clips(p, pl, t, *video_track, *audio_track));
                let d = payload_duration(p, pl);
                t = if *snap { p.snap_frame(t + d) } else { t + d };
            }
            let ids = p.insert(clips);
            out.selection = Some(ids.into_iter().collect());
        }
        Edit::AddAtPlayhead { payloads, playhead } => {
            let mut selection = vec![];
            let mut t = *playhead;
            for pl in payloads {
                let d = payload_duration(p, pl);
                let first_audio = p.audio_tracks.first().map(|a| a.id).unwrap_or(track_token::NEW_AUDIO);
                let clips = match pl {
                    Payload::Text | Payload::Solid => match p.first_free_video_spot(t, d) {
                        Some((track, s)) => make_clips(p, pl, s, track, first_audio),
                        None => make_clips(p, pl, t, track_token::NEW_VIDEO, first_audio),
                    },
                    Payload::Asset { .. } => {
                        let v = p.free_track(TrackKind::Video, t, d).unwrap_or(track_token::NEW_VIDEO);
                        let a = p.free_track(TrackKind::Audio, t, d).unwrap_or(track_token::NEW_AUDIO);
                        make_clips(p, pl, t, v, a)
                    }
                };
                selection.extend(p.insert(clips));
                t = p.snap_frame(t + d);
            }
            out.selection = Some(selection);
        }
        Edit::Place { clips } => {
            let ids: Ids = clips.iter().map(|c| c.id).collect();
            for c in clips {
                match p.index_of(c.id) {
                    Some(i) => p.clips[i] = c.clone(),
                    None => p.clips.push(c.clone()),
                }
            }
            p.materialize_tokens();
            p.resolve_overlaps(&ids);
        }
        Edit::Insert { clips, at } => {
            let placed = p.placed(clips, *at);
            let end = placed.iter().map(Clip::end).fold(0.0, f64::max);
            let ids = p.insert(placed);
            out.selection = Some(ids.into_iter().collect());
            out.seek = Some(end);
        }
        Edit::Duplicate { ids } => {
            let chosen: Vec<Clip> = {
                let ids = p.unlocked(&p.linked(&set(ids)));
                p.clips.iter().filter(|c| ids.contains(&c.id)).cloned().collect()
            };
            if chosen.is_empty() {
                return;
            }
            let t1 = chosen.iter().map(Clip::end).fold(0.0, f64::max);
            let mut placed = p.placed(&chosen, t1);
            // Duplicates stay on their own tracks.
            for (n, c) in placed.iter_mut().zip(&chosen) {
                if !p.is_locked(c.track_id) {
                    n.track_id = c.track_id;
                }
            }
            let ids = p.insert(placed);
            out.selection = Some(ids.into_iter().collect());
        }
        Edit::Split { ids, at } => {
            let ids = p.unlocked(&p.linked(&set(ids)));
            p.split(&ids, *at);
        }
        Edit::SplitAtPlayhead { selection, playhead } => {
            let t = *playhead;
            let sel = set(selection);
            let under: Ids = p.under(t).iter().map(|c| c.id).collect();
            let picked: Ids = sel.intersection(&under).copied().collect();
            let targets = p.unlocked(&p.linked(if picked.is_empty() { &under } else { &picked }));
            p.split(&targets, t);
        }
        Edit::Delete { ids, ripple } => {
            let ids = p.unlocked(&p.linked(&set(ids)));
            p.remove(&ids, *ripple);
            out.selection = Some(vec![]);
        }
        Edit::RippleTrim { selection, playhead, head } => {
            let t = *playhead;
            let under: Vec<Clip> = p.under(t).into_iter().filter(|c| !p.is_locked(c.track_id)).cloned().collect();
            let sel = set(selection);
            let picked: Ids = under.iter().filter(|c| sel.contains(&c.id)).map(|c| c.id).collect();
            let tracks: Ids = if picked.is_empty() {
                p.all_tracks().map(|t| t.id).collect()
            } else {
                let l = p.linked(&picked);
                p.clips.iter().filter(|c| l.contains(&c.id)).map(|c| c.track_id).collect()
            };
            let edges: Vec<&Clip> = under.iter().filter(|c| tracks.contains(&c.track_id)).collect();
            if edges.is_empty() {
                return;
            }
            let range = if *head {
                (edges.iter().map(|c| c.start).fold(f64::NEG_INFINITY, f64::max), t)
            } else {
                (t, edges.iter().map(|c| c.end()).fold(f64::INFINITY, f64::min))
            };
            if range.1 - range.0 < 0.5 / fps {
                return;
            }
            let unlocked: Ids = tracks.into_iter().filter(|t| !p.is_locked(*t)).collect();
            p.ripple_remove(range.0, range.1, &unlocked);
            if *head {
                out.seek = Some(range.0);
            }
        }
        Edit::Reverse { selection } => {
            let sel = set(selection);
            let Some(c) = p.clips.iter().find(|c| sel.contains(&c.id) && c.plays_source() && !p.is_locked(c.track_id)).cloned()
            else {
                return;
            };
            let group = p.unlocked(&p.linked(&[c.id].into_iter().collect()));
            if c.reversed_from.is_some() {
                for x in p.clips.iter_mut().filter(|x| group.contains(&x.id)) {
                    if let Some(from) = x.reversed_from.take() {
                        x.asset_id = Some(from.asset_id);
                        x.source_start = from.source_start;
                    }
                }
                return;
            }
            let backwards = !c.plays_backwards();
            let lengths: HashMap<Id, f64> = p.assets.iter().map(|a| (a.id, a.duration)).collect();
            for x in p.clips.iter_mut().filter(|x| group.contains(&x.id)) {
                let Some(l) = x.asset_id.and_then(|a| lengths.get(&a)).copied() else { continue };
                if !x.plays_source() || x.reversed_from.is_some() {
                    continue;
                }
                x.source_start = (l - (x.source_start + x.source_length())).max(0.0);
                x.ramp = x.ramp.map(|r| r.mirrored(l));
                x.reversed = backwards.then_some(true);
            }
        }
        Edit::FreezeFrame { selection, playhead } => {
            const HOLD: f64 = 2.0;
            let t = p.snap_frame(*playhead);
            let sel = set(selection);
            let Some(c) = p
                .clips
                .iter()
                .find(|c| {
                    sel.contains(&c.id)
                        && c.kind == ClipKind::Video
                        && !c.is_freeze()
                        && !p.is_locked(c.track_id)
                        && c.start <= t
                        && t < c.end()
                })
                .cloned()
            else {
                return;
            };
            let mut source = c.source_time(t);
            if c.plays_backwards()
                && let Some(l) = p.asset(c.asset_id).map(|a| a.duration)
            {
                source = (l - source - 0.001).max(0.0);
            }
            let group = p.linked(&[c.id].into_iter().collect());
            p.split(&group, t);
            let tracks: Ids = p.clips.iter().filter(|x| group.contains(&x.id)).map(|x| x.track_id).collect();
            let later: Ids = p.clips.iter().filter(|x| tracks.contains(&x.track_id) && x.start >= t - 1e-6).map(|x| x.id).collect();
            let mut shifting = p.unlocked(&p.linked(&later));
            for x in p.clips.iter_mut().filter(|x| shifting.contains(&x.id)) {
                x.start += HOLD;
            }
            let freeze = Clip {
                track_id: c.track_id,
                kind: ClipKind::Video,
                asset_id: c.asset_id,
                start: t,
                duration: HOLD,
                source_start: source,
                freeze: Some(true),
                grade: c.grade.clone(),
                transform: c.transform,
                ..Clip::default()
            };
            let fid = freeze.id;
            p.clips.push(freeze);
            shifting.insert(fid);
            p.resolve_overlaps(&shifting);
            out.selection = Some(vec![fid]);
        }
        Edit::SetTransition { id, transition } => {
            if let Some(i) = p.index_of(*id) {
                p.clips[i].transition_in = *transition;
            }
        }
        Edit::AddDissolve { selection, playhead } => {
            let sel = set(selection);
            let best = p
                .clips
                .iter()
                .filter(|c| c.kind != ClipKind::Audio && !p.is_locked(c.track_id))
                .filter_map(|c| p.previous_touching(c).map(|a| (c, a)))
                .filter(|(c, a)| sel.contains(&c.id) || sel.contains(&a.id))
                .min_by(|(x, _), (y, _)| (x.start - playhead).abs().total_cmp(&(y.start - playhead).abs()))
                .map(|(c, _)| c.id);
            if let Some(id) = best {
                let i = p.index_of(id).unwrap();
                p.clips[i].transition_in.get_or_insert_with(Transition::default);
            }
        }
        Edit::DetachAudio { ids } => p.unlink(&set(ids)),
        Edit::DeleteGap { track, at } => {
            if let Some((a, b)) = p.gap(*track, *at) {
                p.pull_left(*track, b, b - a);
            }
        }
        Edit::CloseAllGaps { tracks } => {
            let tracks: Vec<Id> = if tracks.is_empty() { p.all_tracks().map(|t| t.id).collect() } else { tracks.clone() };
            for t in tracks {
                p.close_all_gaps(t);
            }
        }
        Edit::SetSpeed { ids, speed, sticky } => {
            let ids = p.unlocked(&set(ids));
            p.set_speed(&ids, *speed, *sticky);
        }
        Edit::SetRamp { ids, speed, points, start, end, sticky } => {
            let ids = p.unlocked(&set(ids));
            p.set_ramp(&ids, *speed, *points, *start, *end, *sticky);
        }
        Edit::Update { ids, patch } => {
            let ids = p.unlocked(&set(ids));
            for c in p.clips.iter_mut().filter(|c| ids.contains(&c.id)) {
                apply_patch(c, patch, fps);
            }
        }
        Edit::PasteGrade { ids, grade } => {
            let ids = p.unlocked(&set(ids));
            for c in p.clips.iter_mut().filter(|c| ids.contains(&c.id) && c.kind != ClipKind::Audio) {
                c.grade = grade.clone().filter(|g| !g.is_neutral());
            }
        }
        Edit::AddTrack { kind } => {
            p.add_track(*kind);
        }
        Edit::RemoveTrack { id } => p.remove_track(*id),
        Edit::SetTrack { id, patch } => p.update_track(*id, |t| {
            if let Some(v) = patch.hidden {
                t.hidden = v;
            }
            if let Some(v) = patch.muted {
                t.muted = v;
            }
            if let Some(v) = patch.solo {
                t.solo = v;
            }
            if let Some(v) = patch.locked {
                t.locked = v;
            }
            if let Some(v) = patch.gain_db {
                t.gain_db = ((v.clamp(-60.0, 12.0)) * 10.0).round() / 10.0;
            }
            if let Some(v) = patch.duck_under {
                t.duck_under = v;
            }
            if let Some(v) = patch.duck_db {
                t.duck_db = v;
            }
        }),
        Edit::SetSequence { width, height } => {
            let even = |v: i64| (v.clamp(16, 8192) / 2) * 2;
            p.width = even(*width);
            p.height = even(*height);
            p.settings_locked = true;
        }
        Edit::SetFps { fps } => {
            p.fps = *fps;
            p.settings_locked = true;
        }
        Edit::MatchSequence { asset } => {
            if let Some(a) = p.asset(Some(*asset)).cloned() {
                p.width = a.width;
                p.height = a.height;
                p.fps = standard_fps(a.fps);
                p.settings_locked = true;
            }
        }
        Edit::RemoveAssets { ids } => {
            let ids = set(ids);
            let mut hidden = p.hidden_media.clone().unwrap_or_default();
            for a in p.assets.iter().filter(|a| ids.contains(&a.id)) {
                if p.folders.iter().flatten().any(|f| crate::paths::folder_contains(&f.path, &a.path)) {
                    hidden.push(a.path.clone());
                }
            }
            p.hidden_media = (!hidden.is_empty()).then_some(hidden);
            p.assets.retain(|a| !ids.contains(&a.id));
            p.clips.retain(|c| c.asset_id.is_none_or(|a| !ids.contains(&a)));
            p.prune_folders(&Default::default());
            out.selection = Some(vec![]);
        }
        Edit::AddMarker { playhead } => {
            let t = p.snap_frame(*playhead);
            let markers = p.markers.get_or_insert_with(Vec::new);
            if markers.iter().any(|m| (m.time - t).abs() <= 0.5 / fps) {
                return;
            }
            let n = markers.len() + 1;
            markers.push(Marker { id: Id::new(), time: t, name: format!("Marker {n}"), tint: MarkerTint::Yellow });
        }
        Edit::UpdateMarker { marker } => {
            if let Some(m) = p.markers.iter_mut().flatten().find(|m| m.id == marker.id) {
                *m = Marker { time: marker.time.max(0.0), ..marker.clone() };
            }
        }
        Edit::RemoveMarker { id } => {
            if let Some(ms) = p.markers.as_mut() {
                ms.retain(|m| m.id != *id);
                if ms.is_empty() {
                    p.markers = None;
                }
            }
        }
        Edit::ClearMarkers => p.markers = None,
        Edit::SetIn { playhead } => {
            let t = p.snap_frame(*playhead);
            p.in_point = Some(t);
            if p.out_point.is_some_and(|o| o <= t) {
                p.out_point = None;
            }
        }
        Edit::SetOut { playhead } => {
            let t = p.snap_frame(*playhead);
            p.out_point = Some(t);
            if p.in_point.is_some_and(|i| i >= t) {
                p.in_point = None;
            }
        }
        Edit::ClearInOut => {
            p.in_point = None;
            p.out_point = None;
        }
        Edit::AddCaptions { ids } => {
            let picked = set(ids);
            let everything = picked.is_empty() || p.clips.iter().all(|c| picked.contains(&c.id));
            let targets: Ids = if everything {
                default_caption_targets(p)
            } else {
                let l = p.linked(&picked);
                p.clips.iter().filter(|c| l.contains(&c.id) && c.kind == ClipKind::Audio && c.plays_source()).map(|c| c.id).collect()
            };
            let targets = p.unlocked(&targets);
            if targets.is_empty() {
                return;
            }
            p.captions.get_or_insert_with(CaptionTrack::default);
            for c in p.clips.iter_mut().filter(|c| targets.contains(&c.id)) {
                c.captioned = Some(true);
            }
        }
        Edit::RemoveCaptions { ids } => {
            let l = p.linked(&set(ids));
            for c in p.clips.iter_mut().filter(|c| l.contains(&c.id)) {
                c.captioned = None;
            }
            let used: Ids = p.clips.iter().filter(|c| c.captioned == Some(true)).filter_map(|c| c.asset_id).collect();
            if let Some(f) = p.caption_fixes.as_mut() {
                f.retain(|k, _| used.contains(k));
            }
        }
        Edit::RemoveCaptionTrack => {
            p.captions = None;
            p.caption_fixes = None;
            for c in p.clips.iter_mut() {
                c.captioned = None;
            }
        }
        Edit::SetCaptionsHidden { hidden } => {
            if let Some(c) = p.captions.as_mut() {
                c.hidden = *hidden;
            }
        }
        Edit::SetCaptionStyle { style } => {
            if let Some(c) = p.captions.as_mut() {
                c.style = style.clone();
                let (lo, hi) = CaptionStyle::SIZE_RANGE;
                c.style.size = c.style.size.clamp(lo, hi);
            }
        }
        Edit::SetCaptionFixes { asset, fixes } => {
            let map = p.caption_fixes.get_or_insert_with(Default::default);
            let list = map.entry(*asset).or_default();
            for f in fixes {
                list.retain(|x| (x.start - f.start).abs() > 0.0005);
                list.push(f.clone());
            }
            list.sort_by(|a, b| a.start.total_cmp(&b.start));
        }
        Edit::SetGains { gains } => {
            for c in p.clips.iter_mut() {
                if let Some(g) = gains.get(&c.id)
                    && !p.audio_tracks.iter().any(|t| t.id == c.track_id && t.locked)
                {
                    c.gain_db = *g;
                }
            }
        }
    }
}

/// Audio clips whose file is a video, plus audio on any track another track ducks under.
fn default_caption_targets(p: &Project) -> Ids {
    let ducked: Ids = p.audio_tracks.iter().filter_map(|t| t.duck_under).collect();
    p.clips
        .iter()
        .filter(|c| c.kind == ClipKind::Audio && c.plays_source())
        .filter(|c| ducked.contains(&c.track_id) || p.asset(c.asset_id).is_some_and(|a| a.kind == MediaKind::Video))
        .map(|c| c.id)
        .collect()
}

fn apply_patch(c: &mut Clip, patch: &ClipPatch, fps: f64) {
    let snap = |t: f64| (t * fps).round() / fps;
    if let Some(v) = patch.fade_in {
        c.fade_in = snap(v.max(0.0)).min(c.duration - c.fade_out);
    }
    if let Some(v) = patch.fade_out {
        c.fade_out = snap(v.max(0.0)).min(c.duration - c.fade_in);
    }
    if let Some(v) = patch.fade_in_curve {
        c.fade_in_curve = v;
    }
    if let Some(v) = patch.fade_out_curve {
        c.fade_out_curve = v;
    }
    if let Some(v) = patch.gain_db {
        let v = (v.clamp(-60.0, 12.0) * 10.0).round() / 10.0;
        c.gain_db = if v <= -59.5 { -60.0 } else { v };
    }
    if let Some(v) = patch.color {
        c.color = v;
    }
    if let Some(v) = &patch.text
        && c.kind == ClipKind::Text
    {
        c.text = v.clone();
    }
    if let Some(v) = &patch.grade
        && c.kind != ClipKind::Audio
    {
        c.grade = v.clone().filter(|g| !g.is_neutral());
    }
    if let Some(v) = patch.transform
        && c.is_transformable()
    {
        c.transform = v.filter(|t| !t.is_identity());
    }
    if let Some(v) = patch.transition_in
        && c.kind != ClipKind::Audio
    {
        c.transition_in = v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_video(len: f64, has_audio: bool) -> (Document, Id) {
        let mut p = Project::default();
        let a = MediaAsset {
            id: Id::new(),
            path: "/m/a.mov".into(),
            relative_path: None,
            playable_path: None,
            name: "a.mov".into(),
            kind: MediaKind::Video,
            duration: len,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio,
            bookmark: None,
        };
        let id = a.id;
        p.assets.push(a);
        (Document::new(p), id)
    }

    #[test]
    fn add_links_picture_and_sound() {
        let (mut d, a) = with_video(10.0, true);
        let out = Edit::AddAtPlayhead { payloads: vec![Payload::Asset { id: a }], playhead: 0.0 }.apply(&mut d);
        assert_eq!(out.selection.unwrap().len(), 2);
        let p = &d.project;
        assert_eq!(p.clips.len(), 2);
        assert_eq!(p.clips[0].link_id, p.clips[1].link_id);
        assert_eq!(p.clips[1].kind, ClipKind::Audio);
        assert_eq!(p.clips[0].track_id, p.video_tracks[0].id);
    }

    #[test]
    fn freeze_frame_inserts_two_seconds() {
        let (mut d, a) = with_video(10.0, true);
        Edit::AddAtPlayhead { payloads: vec![Payload::Asset { id: a }], playhead: 0.0 }.apply(&mut d);
        let v = d.project.clips[0].id;
        let out = Edit::FreezeFrame { selection: vec![v], playhead: 4.0 }.apply(&mut d);
        let p = &d.project;
        let f = p.clip(out.selection.unwrap()[0]).unwrap();
        assert!(f.is_freeze());
        assert_eq!((f.start, f.duration, f.source_start), (4.0, 2.0, 4.0));
        assert!((p.duration() - 12.0).abs() < 1e-9, "everything after moves 2 s later");
    }

    #[test]
    fn reverse_mirrors_the_footage() {
        let (mut d, a) = with_video(10.0, false);
        Edit::Add { payloads: vec![Payload::Asset { id: a }], start: 0.0, video_track: d.project.video_tracks[0].id, audio_track: d.project.audio_tracks[0].id, snap: true }
            .apply(&mut d);
        let id = d.project.clips[0].id;
        let i = d.project.index_of(id).unwrap();
        d.project.clips[i].trim_head(2.0);
        d.project.clips[i].trim_tail(5.0); // footage 2..5
        Edit::Reverse { selection: vec![id] }.apply(&mut d);
        let c = d.project.clip(id).unwrap();
        assert_eq!(c.reversed, Some(true));
        assert!((c.source_start - 5.0).abs() < 1e-9, "10 - (2 + 3)");
        Edit::Reverse { selection: vec![id] }.apply(&mut d);
        let c = d.project.clip(id).unwrap();
        assert_eq!(c.reversed, None);
        assert!((c.source_start - 2.0).abs() < 1e-9);
    }

    #[test]
    fn ripple_trim_head_closes_up() {
        let (mut d, a) = with_video(10.0, true);
        Edit::AddAtPlayhead { payloads: vec![Payload::Asset { id: a }, Payload::Asset { id: a }], playhead: 0.0 }.apply(&mut d);
        assert!((d.project.duration() - 20.0).abs() < 1e-9);
        let out = Edit::RippleTrim { selection: vec![], playhead: 3.0, head: true }.apply(&mut d);
        assert_eq!(out.seek, Some(0.0));
        assert!((d.project.duration() - 17.0).abs() < 1e-9);
        assert!(d.project.clips.iter().all(|c| c.start == 0.0 || (c.start - 7.0).abs() < 1e-9));
    }

    #[test]
    fn edits_round_trip_as_json() {
        let e = Edit::SetSpeed { ids: vec![Id::new()], speed: 2.0, sticky: true };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""op":"setSpeed""#), "{s}");
        assert_eq!(serde_json::from_str::<Edit>(&s).unwrap(), e);
        let patch: ClipPatch = serde_json::from_str(r#"{"fadeIn":1,"grade":null}"#).unwrap();
        assert_eq!(patch.fade_in, Some(1.0));
        assert_eq!(patch.grade, Some(None), "null clears");
        assert_eq!(patch.transform, None, "missing leaves alone");
    }
}
