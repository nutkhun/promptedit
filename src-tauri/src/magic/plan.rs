//! Magic's edits (Editroom's `MagicEdit`): each one a person could make with one drag or click.
//! Local Magic's planners produce a list of them; applying the list gives the finished project, which
//! goes onto the timeline as one undo step. Unlike Editroom's, a `Change` is a typed operation rather
//! than a closure, so a plan can cross to the UI.

use promptedit_core::project::Ids;
use promptedit_core::{Clip, ColorGrade, Id, Project, Track, TrackKind, Transition};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Step {
    Place { clips: Vec<Clip> },
    TrimHead { ids: Vec<Id>, from: f64, to: f64 },
    TrimTail { ids: Vec<Id>, from: f64, to: f64 },
    Move { ids: Vec<Id>, from: f64, to: f64 },
    Remove { ids: Vec<Id>, ripple: bool },
    Gain { id: Id, from: f64, to: f64 },
    FadeIn { id: Id, to: f64 },
    FadeOut { id: Id, to: f64 },
    Look { id: Id, name: String },
    NoLook { id: Id },
    Exposure { id: Id, to: f64 },
    Contrast { id: Id, to: f64 },
    Saturation { id: Id, to: f64 },
    Transition { id: Id, transition: Option<Transition> },
    /// The frame shape (vertical, square…), locking the sequence settings.
    Size { width: i64, height: i64 },
    AddTrack { kind: TrackKind, id: Id },
    Speed { ids: Vec<Id>, speed: f64 },
    Ramp { ids: Vec<Id>, speed: f64, points: (f64, f64, f64, f64), around: f64 },
    Zoom { id: Id, transform: Option<promptedit_core::ClipTransform> },
    Captions { ids: Vec<Id>, remove: bool },
    /// Audio clip gains worked out from waveforms.
    Gains { gains: std::collections::HashMap<Id, f64> },
    /// Stretches of the timeline taken out of these tracks and closed up (pauses in the talking).
    RippleCuts { cuts: Vec<(f64, f64)>, tracks: Vec<Id> },
}

impl Step {
    /// What the cursor's tag says while it does this.
    pub fn label(&self) -> String {
        match self {
            Step::Place { clips } => match clips.first().map(|c| c.kind) {
                Some(promptedit_core::ClipKind::Audio) => "Music".into(),
                Some(promptedit_core::ClipKind::Text) => "Title".into(),
                _ => "Place".into(),
            },
            Step::TrimHead { .. } | Step::TrimTail { .. } => "Trim".into(),
            Step::Move { .. } => "Move".into(),
            Step::Remove { .. } => "Delete".into(),
            Step::Gain { to, .. } => format!("{:.0} dB", to).replace('-', "−"),
            Step::FadeIn { .. } => "Fade in".into(),
            Step::FadeOut { .. } => "Fade out".into(),
            Step::Look { name, .. } => name.clone(),
            Step::NoLook { .. } => "No look".into(),
            Step::Exposure { .. } => "Exposure".into(),
            Step::Contrast { .. } => "Contrast".into(),
            Step::Saturation { .. } => "Saturation".into(),
            Step::Transition { transition, .. } => transition.map(|t| t.kind.label().to_string()).unwrap_or_else(|| "No transition".into()),
            Step::Size { width, height } => if width < height { "Vertical" } else if width == height { "Square" } else { "Horizontal" }.into(),
            Step::AddTrack { kind, .. } => if *kind == TrackKind::Video { "Add video track" } else { "Add audio track" }.into(),
            Step::Speed { speed, .. } => format!("Speed ×{}", crate::mcp::tools::fmt_g(*speed)),
            Step::Ramp { .. } => "Speed ramp".into(),
            Step::Zoom { .. } => "Zoom".into(),
            Step::Captions { remove, .. } => if *remove { "No captions" } else { "Captions" }.into(),
            Step::Gains { .. } => "Levels".into(),
            Step::RippleCuts { .. } => "Cut pauses".into(),
        }
    }

    /// Applies the edit, all the way through (MagicEdit.apply at p = 1).
    pub fn apply(&self, p: &mut Project) {
        let set = |ids: &[Id]| -> Ids { ids.iter().copied().collect() };
        fn grade(p: &mut Project, id: Id, f: impl FnOnce(&mut ColorGrade)) {
            if let Some(i) = p.index_of(id) {
                let mut g = p.clips[i].grade.clone().unwrap_or_default();
                f(&mut g);
                p.clips[i].grade = if g.is_neutral() { None } else { Some(g) };
            }
        }
        match self {
            Step::Place { clips } => {
                let ids: Ids = clips.iter().map(|c| c.id).collect();
                p.clips.extend(clips.iter().cloned());
                p.resolve_overlaps(&ids);
            }
            Step::TrimHead { ids, to, .. } => {
                let t = p.snap_frame(*to);
                let s = set(ids);
                for c in p.clips.iter_mut().filter(|c| s.contains(&c.id)) {
                    c.trim_head(t);
                }
                p.resolve_overlaps(&s);
            }
            Step::TrimTail { ids, to, .. } => {
                let t = p.snap_frame(*to);
                let s = set(ids);
                for c in p.clips.iter_mut().filter(|c| s.contains(&c.id)) {
                    c.trim_tail(t);
                }
                p.resolve_overlaps(&s);
            }
            Step::Move { ids, from, to } => {
                let delta = p.snap_frame(*to) - from;
                let s = set(ids);
                for c in p.clips.iter_mut().filter(|c| s.contains(&c.id)) {
                    c.start += delta;
                }
                p.resolve_overlaps(&s);
            }
            Step::Remove { ids, ripple } => p.remove(&set(ids), *ripple),
            Step::Gain { id, to, .. } => {
                if let Some(i) = p.index_of(*id) {
                    p.clips[i].gain_db = (to * 10.0).round() / 10.0;
                }
            }
            Step::FadeIn { id, to } => {
                if let Some(i) = p.index_of(*id) {
                    p.clips[i].fade_in = *to;
                    p.clips[i].clamp_fades();
                }
            }
            Step::FadeOut { id, to } => {
                if let Some(i) = p.index_of(*id) {
                    p.clips[i].fade_out = *to;
                    p.clips[i].clamp_fades();
                }
            }
            Step::Look { id, name } => grade(p, *id, |g| g.look = Some(name.clone())),
            Step::NoLook { id } => grade(p, *id, |g| g.look = None),
            Step::Exposure { id, to } => grade(p, *id, |g| g.exposure = *to),
            Step::Contrast { id, to } => grade(p, *id, |g| g.contrast = *to),
            Step::Saturation { id, to } => grade(p, *id, |g| g.saturation = *to),
            Step::Transition { id, transition } => {
                if let Some(i) = p.index_of(*id) {
                    p.clips[i].transition_in = *transition;
                }
            }
            Step::Size { width, height } => {
                p.width = *width;
                p.height = *height;
                p.settings_locked = true;
            }
            Step::AddTrack { kind, id } => {
                let mut t = Track::new(*kind);
                t.id = *id;
                match kind {
                    TrackKind::Video => p.video_tracks.push(t),
                    TrackKind::Audio => p.audio_tracks.push(t),
                }
            }
            Step::Speed { ids, speed } => p.set_speed(&set(ids), *speed, false),
            Step::Ramp { ids, speed, points, around } => p.set_ramp(&set(ids), *speed, *points, *around, *around, false),
            Step::Zoom { id, transform } => {
                if let Some(i) = p.index_of(*id) {
                    p.clips[i].transform = transform.filter(|t| !t.is_identity());
                }
            }
            Step::Captions { ids, remove } => {
                let e = match (remove, ids.is_empty()) {
                    (true, true) => promptedit_core::edit::Edit::RemoveCaptionTrack,
                    (true, false) => promptedit_core::edit::Edit::RemoveCaptions { ids: ids.clone() },
                    (false, _) => promptedit_core::edit::Edit::AddCaptions { ids: ids.clone() },
                };
                crate::mcp::tools::apply_edit(p, e);
            }
            Step::Gains { gains } => {
                crate::mcp::tools::apply_edit(p, promptedit_core::edit::Edit::SetGains { gains: gains.clone() });
            }
            Step::RippleCuts { cuts, tracks } => {
                let tracks = set(tracks);
                let mut ordered = cuts.clone();
                // Latest first, so earlier ones keep their place.
                ordered.sort_by(|a, b| b.0.total_cmp(&a.0));
                for (a, b) in ordered {
                    p.ripple_remove(a, b, &tracks);
                }
            }
        }
    }
}

/// The project a list of steps arrives at.
pub fn applied(base: &Project, steps: &[Step]) -> Project {
    let mut p = base.clone();
    for s in steps {
        s.apply(&mut p);
    }
    p.sanitize();
    p
}
