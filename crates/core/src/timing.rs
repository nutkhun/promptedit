//! How clips map timeline time to footage: speed, ramps, freeze frames, fades, trims and zooms.
//! Ported from Editroom/Model/SpeedRamp.swift, ZoomMove.swift and the `Clip` parts of Project.swift.

use crate::model::{Clip, ClipTransform, FadeCurve, SpeedRamp, ZoomMode, ZoomMove};

impl SpeedRamp {
    /// Speed at a point in the footage, with `mid` the clip's own speed. Eased in log speed.
    pub fn speed_at(&self, s: f64, mid: f64) -> f64 {
        if s < self.in_to {
            if s <= self.in_from {
                return self.start_speed;
            }
            return blend(self.start_speed, mid, (s - self.in_from) / (self.in_to - self.in_from));
        }
        if s > self.out_from {
            if s >= self.out_to {
                return self.end_speed;
            }
            return blend(mid, self.end_speed, (s - self.out_from) / (self.out_to - self.out_from));
        }
        mid
    }

    /// The slowest and fastest it plays.
    pub fn extremes(&self, mid: f64) -> (f64, f64) {
        let all = [self.start_speed, mid, self.end_speed];
        (all.iter().cloned().fold(f64::INFINITY, f64::min), all.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    }

    fn marks(&self) -> [f64; 4] {
        [self.in_from, self.in_to, self.out_from, self.out_to]
    }

    /// Timeline seconds to play footage from `s0` to `s1` (negative if `s1` is before `s0`).
    pub fn span(&self, s0: f64, s1: f64, mid: f64) -> f64 {
        if s1 < s0 {
            return -self.span(s1, s0, mid);
        }
        let mut total = 0.0;
        let mut a = s0;
        for m in self.marks().into_iter().chain([s1]) {
            if m <= a {
                continue;
            }
            let b = m.min(s1);
            total += self.piece(a, b, mid);
            a = b;
            if a >= s1 {
                break;
            }
        }
        total
    }

    /// One stretch with no mark inside it: exact if the speed is constant, else Simpson's rule.
    fn piece(&self, a: f64, b: f64, mid: f64) -> f64 {
        if b <= a {
            return 0.0;
        }
        let va = self.speed_at(a, mid);
        let vb = self.speed_at(b, mid);
        let vm = self.speed_at((a + b) / 2.0, mid);
        if (va - vb).abs() < 1e-12 && (va - vm).abs() < 1e-12 {
            return (b - a) / va;
        }
        let n = 24;
        let h = (b - a) / n as f64;
        let mut sum = 1.0 / va + 1.0 / vb;
        for i in 1..n {
            sum += (if i % 2 == 0 { 2.0 } else { 4.0 }) / self.speed_at(a + i as f64 * h, mid);
        }
        sum * h / 3.0
    }

    /// The footage reached after playing `dt` timeline seconds from `s0` (backwards if negative).
    pub fn source(&self, s0: f64, dt: f64, mid: f64) -> f64 {
        if dt.abs() < 1e-12 {
            return s0;
        }
        let forward = dt > 0.0;
        let mut left = dt.abs();
        let mut a = s0;
        let mut stops: Vec<f64> = if forward {
            self.marks().into_iter().filter(|&m| m > s0).collect()
        } else {
            self.marks().into_iter().filter(|&m| m < s0).collect()
        };
        if forward {
            stops.sort_by(f64::total_cmp);
        } else {
            stops.sort_by(|a, b| b.total_cmp(a));
        }
        for m in stops {
            let t = self.span(a, m, mid).abs();
            if t >= left {
                return self.solve(a, m, left, mid);
            }
            left -= t;
            a = m;
        }
        let v = self.speed_at(if forward { a + 1e-9 } else { a - 1e-9 }, mid);
        a + if forward { 1.0 } else { -1.0 } * left * v
    }

    fn solve(&self, a: f64, b: f64, time: f64, mid: f64) -> f64 {
        let (mut lo, mut hi) = (0.0, 1.0);
        for _ in 0..40 {
            let m = (lo + hi) / 2.0;
            if self.span(a, a + (b - a) * m, mid).abs() < time {
                lo = m;
            } else {
                hi = m;
            }
        }
        a + (b - a) * (lo + hi) / 2.0
    }

    /// The same curve with the footage measured from `d` seconds later.
    pub fn shifted(&self, d: f64) -> SpeedRamp {
        SpeedRamp {
            in_from: self.in_from + d,
            in_to: self.in_to + d,
            out_from: self.out_from + d,
            out_to: self.out_to + d,
            ..*self
        }
    }

    /// The same curve measured from the other end of a file `length` long (for reversing).
    pub fn mirrored(&self, length: f64) -> SpeedRamp {
        SpeedRamp {
            in_from: length - self.out_to,
            in_to: length - self.out_from,
            out_from: length - self.in_to,
            out_to: length - self.in_from,
            start_speed: self.end_speed,
            end_speed: self.start_speed,
        }
    }

    /// A ramp drawn over footage `s0..s1` as the inspector's graph sets it: `start` speed up
    /// to `points.0`, easing to `mid` by `points.1`, holding until `points.2`, easing to `end`
    /// by `points.3`. None when there's no ramp at either end.
    pub fn drawn(s0: f64, s1: f64, points: (f64, f64, f64, f64), start: f64, end: f64, mid: f64) -> Option<SpeedRamp> {
        let l = s1 - s0;
        let (p1, p2, p3, p4) = points;
        let has_in = p2 - p1 > 0.001;
        let has_out = p4 - p3 > 0.001;
        if !(has_in || has_out) || l <= 0.0 {
            return None;
        }
        let at = |f: f64| s0 + l * f.clamp(0.0, 1.0);
        let in_from = if has_in { at(p1) } else { s0 };
        let in_to = if has_in { at(p2) } else { s0 };
        let out_from = if has_out { in_to.max(at(p3)) } else { s1 };
        let out_to = if has_out { in_to.max(at(p4)) } else { s1 };
        Some(SpeedRamp {
            in_from,
            in_to,
            out_from,
            out_to,
            start_speed: if has_in { start } else { mid },
            end_speed: if has_out { end } else { mid },
        })
    }
}

fn blend(a: f64, b: f64, u: f64) -> f64 {
    let e = u * u * (3.0 - 2.0 * u);
    (a.ln() + (b.ln() - a.ln()) * e).exp()
}

impl ZoomMove {
    /// A starting zoom for a clip `length` seconds long.
    pub fn starter(mode: ZoomMode, length: f64) -> ZoomMove {
        let m = (length * 0.25).max(0.5).min(2.0).min(length / 2.0);
        let (p1, p2, p3, p4) = match mode {
            ZoomMode::ZoomIn => (0.0, m, length, length),
            ZoomMode::ZoomOut => (0.0, 0.0, length - m, length),
            ZoomMode::InOut => (0.0, m, length - m, length),
        };
        ZoomMove { mode, p1, p2, p3, p4, smooth: true }
    }

    /// How far in at `u` seconds into the clip: 0 is the full frame, 1 the clip's Scale.
    pub fn amount(&self, u: f64) -> f64 {
        match self.mode {
            ZoomMode::ZoomIn => self.ramp(u, self.p1, self.p2),
            ZoomMode::ZoomOut => 1.0 - self.ramp(u, self.p3, self.p4),
            ZoomMode::InOut => {
                if u < self.p3 {
                    self.ramp(u, self.p1, self.p2)
                } else {
                    1.0 - self.ramp(u, self.p3, self.p4)
                }
            }
        }
    }

    fn ramp(&self, u: f64, a: f64, b: f64) -> f64 {
        if b - a <= 1e-6 {
            return if u >= a { 1.0 } else { 0.0 };
        }
        let k = ((u - a) / (b - a)).clamp(0.0, 1.0);
        if self.smooth { k * k * (3.0 - 2.0 * k) } else { k }
    }

    /// Where it's all the way in, for showing the zoomed framing.
    pub fn zoomed_time(&self, length: f64) -> f64 {
        let last = (length - 1e-3).max(0.0);
        match self.mode {
            ZoomMode::ZoomIn | ZoomMode::InOut => self.p2.max(0.0).min(last),
            ZoomMode::ZoomOut => (self.p3 - 1e-3).max(0.0).min(last),
        }
    }

    /// Kept within a clip `length` long and in order.
    pub fn fit(&mut self, length: f64) {
        let c = |v: f64| v.max(0.0).min(length);
        self.p1 = c(self.p1);
        self.p2 = self.p1.max(c(self.p2));
        self.p3 = self.p2.max(c(self.p3));
        self.p4 = self.p3.max(c(self.p4));
    }

    /// After the clip's start moves later by `d` seconds, so the zoom stays on its picture.
    pub fn shift(&mut self, d: f64, length: f64) {
        self.p1 -= d;
        self.p2 -= d;
        self.p3 -= d;
        self.p4 -= d;
        self.fit(length);
    }
}

impl ClipTransform {
    /// The framing at `u` seconds into the clip, with any zoom applied; None for the plain full frame.
    pub fn at(&self, u: f64) -> Option<ClipTransform> {
        let (ox, oy) = self.zoomed_offset();
        let t = match &self.zoom {
            None => ClipTransform { x: ox, y: oy, ..*self },
            Some(zoom) => {
                let k = zoom.amount(u);
                ClipTransform { scale: 1.0 + (self.scale - 1.0) * k, x: ox * k, y: oy * k, zoom: None }
            }
        };
        if t.is_identity() { None } else { Some(t) }
    }

    /// Bigger than the frame.
    pub fn fills(&self) -> bool {
        self.scale > 1.001
    }

    /// The offset when all the way in, kept so a picture bigger than the frame still covers it.
    pub fn zoomed_offset(&self) -> (f64, f64) {
        if !self.fills() {
            return (self.x, self.y);
        }
        let m = (self.scale - 1.0) / 2.0;
        (self.x.clamp(-m, m), self.y.clamp(-m, m))
    }
}

impl Clip {
    pub fn end(&self) -> f64 {
        self.start + self.duration
    }
    pub fn is_freeze(&self) -> bool {
        self.freeze == Some(true)
    }
    pub fn plays_backwards(&self) -> bool {
        self.reversed == Some(true)
    }
    pub fn is_reversed(&self) -> bool {
        self.plays_backwards() || self.reversed_from.is_some()
    }
    /// Plays through its source over time (so speed and source limits apply).
    pub fn plays_source(&self) -> bool {
        self.kind.uses_source() && !self.is_freeze()
    }
    /// Clips that can be scaled and moved in the frame (text has its own placement).
    pub fn is_transformable(&self) -> bool {
        use crate::model::ClipKind::*;
        matches!(self.kind, Video | Image | Solid)
    }
    pub fn in_curve(&self) -> FadeCurve {
        self.fade_in_curve.unwrap_or_default()
    }
    pub fn out_curve(&self) -> FadeCurve {
        self.fade_out_curve.unwrap_or_default()
    }

    /// Level from the fades at a time on the timeline, 0..1.
    pub fn fade_gain(&self, t: f64) -> f64 {
        let mut g: f64 = 1.0;
        if self.fade_in > 0.0 {
            g = g.min(self.in_curve().apply((t - self.start) / self.fade_in));
        }
        if self.fade_out > 0.0 {
            g = g.min(self.out_curve().apply((self.end() - t) / self.fade_out));
        }
        g.clamp(0.0, 1.0)
    }

    pub fn clamp_fades(&mut self) {
        self.fade_in = self.fade_in.max(0.0).min(self.duration);
        self.fade_out = self.fade_out.max(0.0).min(self.duration - self.fade_in);
    }

    pub fn trim_head(&mut self, t: f64) {
        let d = t - self.start;
        let new_source = self.source_time(t);
        self.start = t;
        self.duration -= d;
        if self.plays_source() {
            self.source_start = new_source.max(0.0);
        }
        self.clamp_fades();
        let len = self.duration;
        if let Some(z) = self.transform.as_mut().and_then(|t| t.zoom.as_mut()) {
            z.shift(d, len);
        }
    }

    pub fn trim_tail(&mut self, t: f64) {
        self.duration = t - self.start;
        self.clamp_fades();
        let len = self.duration;
        if let Some(z) = self.transform.as_mut().and_then(|t| t.zoom.as_mut()) {
            z.fit(len);
        }
    }

    /// Speed changes across the clip.
    pub fn is_ramped(&self) -> bool {
        self.ramp.is_some() && self.plays_source()
    }

    /// The speed at a point in its footage.
    pub fn speed_at_source(&self, s: f64) -> f64 {
        match (&self.ramp, self.plays_source()) {
            (Some(r), true) => r.speed_at(s, self.speed),
            _ => self.speed,
        }
    }

    /// The footage showing at timeline time `t` (any time, before or after the clip too).
    pub fn source_time(&self, t: f64) -> f64 {
        match (&self.ramp, self.plays_source()) {
            (Some(r), true) => r.source(self.source_start, t - self.start, self.speed),
            _ => self.source_start + (t - self.start) * self.speed,
        }
    }

    /// Footage the clip covers.
    pub fn source_length(&self) -> f64 {
        if !self.is_ramped() {
            return self.duration * self.speed;
        }
        self.source_time(self.end()) - self.source_start
    }

    /// Timeline seconds to play footage from `s0` to `s1`.
    pub fn timeline_span(&self, s0: f64, s1: f64) -> f64 {
        match (&self.ramp, self.plays_source()) {
            (Some(r), true) => r.span(s0, s1, self.speed),
            _ => (s1 - s0) / self.speed,
        }
    }

    /// The slowest and fastest it plays.
    pub fn speed_range(&self) -> (f64, f64) {
        match (&self.ramp, self.plays_source()) {
            (Some(r), true) => r.extremes(self.speed),
            _ => (self.speed, self.speed),
        }
    }

    /// Changes how it plays while keeping the same footage: its length follows.
    pub fn retime(&mut self, snap: impl Fn(f64) -> f64, minimum: f64, change: impl FnOnce(&mut Clip)) {
        if !self.plays_source() {
            change(self);
            return;
        }
        let s0 = self.source_start;
        let length = self.source_length();
        change(self);
        self.duration = snap(self.timeline_span(s0, s0 + length)).max(minimum);
        self.clamp_fades();
    }
}

/// Which footage a clip shows at each moment, for the renderer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SourceClock {
    pub start: f64,
    pub source_start: f64,
    pub speed: f64,
    pub ramp: Option<SpeedRamp>,
}

impl SourceClock {
    pub fn new(clip: &Clip) -> Self {
        SourceClock {
            start: clip.start,
            source_start: clip.source_start,
            speed: if clip.is_freeze() { 0.0 } else { clip.speed },
            ramp: if clip.is_freeze() { None } else { clip.ramp },
        }
    }
    pub fn source(&self, t: f64) -> f64 {
        match &self.ramp {
            None => self.source_start + (t - self.start) * self.speed,
            Some(r) => r.source(self.source_start, t - self.start, self.speed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp() -> SpeedRamp {
        SpeedRamp { in_from: 1.0, in_to: 2.0, out_from: 4.0, out_to: 5.0, start_speed: 1.0, end_speed: 1.0 }
    }

    #[test]
    fn constant_speed_spans_are_exact() {
        let r = ramp();
        // Between in_to and out_from the speed is `mid`.
        assert!((r.span(2.0, 4.0, 2.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn source_inverts_span() {
        let r = SpeedRamp { start_speed: 0.25, end_speed: 4.0, ..ramp() };
        for &s1 in &[0.5, 1.5, 3.0, 4.5, 6.0] {
            let dt = r.span(0.0, s1, 1.0);
            let back = r.source(0.0, dt, 1.0);
            assert!((back - s1).abs() < 1e-6, "{s1} -> {dt} -> {back}");
        }
    }

    #[test]
    fn trimming_keeps_footage_in_place() {
        let mut c = Clip { start: 10.0, duration: 4.0, source_start: 2.0, speed: 2.0, ..Clip::default() };
        c.trim_head(11.0);
        assert_eq!(c.start, 11.0);
        assert_eq!(c.duration, 3.0);
        assert_eq!(c.source_start, 4.0);
    }

    #[test]
    fn zoom_fits_into_shorter_clip() {
        let mut z = ZoomMove::starter(ZoomMode::InOut, 8.0);
        assert_eq!((z.p1, z.p2, z.p3, z.p4), (0.0, 2.0, 6.0, 8.0));
        z.shift(3.0, 4.0);
        assert_eq!((z.p1, z.p2, z.p3, z.p4), (0.0, 0.0, 3.0, 4.0));
    }
}
