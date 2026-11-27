// Clip timing for the renderer and timeline: the same maths as crates/core/src/timing.rs and
// project.rs (both ported from Editroom's SpeedRamp.swift / Project.swift). Keep them in step;
// src/timing.test.ts checks this file against values computed by the Rust core.

import type { Clip, FadeCurve, Project, SpeedRamp, TransitionKind, ZoomMove, ClipTransform, Track } from "./model";

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const smoothstep = (k: number) => k * k * (3 - 2 * k);

export function applyCurve(curve: FadeCurve | undefined, x: number): number {
  x = clamp(x, 0, 1);
  switch (curve ?? "linear") {
    case "linear": return x;
    case "easeIn": return x * x * x;
    case "easeOut": return 1 - Math.pow(1 - x, 3);
    case "smooth": return x * x * (3 - 2 * x);
  }
}

// ---- Speed ramps ----

function blend(a: number, b: number, u: number) {
  const e = u * u * (3 - 2 * u);
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * e);
}

export function rampSpeed(r: SpeedRamp, s: number, mid: number): number {
  if (s < r.inTo) {
    if (s <= r.inFrom) return r.startSpeed;
    return blend(r.startSpeed, mid, (s - r.inFrom) / (r.inTo - r.inFrom));
  }
  if (s > r.outFrom) {
    if (s >= r.outTo) return r.endSpeed;
    return blend(mid, r.endSpeed, (s - r.outFrom) / (r.outTo - r.outFrom));
  }
  return mid;
}

const marks = (r: SpeedRamp) => [r.inFrom, r.inTo, r.outFrom, r.outTo];

function piece(r: SpeedRamp, a: number, b: number, mid: number): number {
  if (b <= a) return 0;
  const va = rampSpeed(r, a, mid), vb = rampSpeed(r, b, mid), vm = rampSpeed(r, (a + b) / 2, mid);
  if (Math.abs(va - vb) < 1e-12 && Math.abs(va - vm) < 1e-12) return (b - a) / va;
  const n = 24, h = (b - a) / n;
  let sum = 1 / va + 1 / vb;
  for (let i = 1; i < n; i++) sum += (i % 2 === 0 ? 2 : 4) / rampSpeed(r, a + i * h, mid);
  return (sum * h) / 3;
}

/** Timeline seconds to play footage s0..s1. */
export function rampSpan(r: SpeedRamp, s0: number, s1: number, mid: number): number {
  if (s1 < s0) return -rampSpan(r, s1, s0, mid);
  let total = 0, a = s0;
  for (const m of [...marks(r), s1]) {
    if (m <= a) continue;
    const b = Math.min(m, s1);
    total += piece(r, a, b, mid);
    a = b;
    if (a >= s1) break;
  }
  return total;
}

function solve(r: SpeedRamp, a: number, b: number, time: number, mid: number) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (Math.abs(rampSpan(r, a, a + (b - a) * m, mid)) < time) lo = m; else hi = m;
  }
  return a + (b - a) * ((lo + hi) / 2);
}

/** Footage reached after playing dt timeline seconds from s0. */
export function rampSource(r: SpeedRamp, s0: number, dt: number, mid: number): number {
  if (Math.abs(dt) < 1e-12) return s0;
  const forward = dt > 0;
  let left = Math.abs(dt), a = s0;
  const stops = forward
    ? marks(r).filter((m) => m > s0).sort((x, y) => x - y)
    : marks(r).filter((m) => m < s0).sort((x, y) => y - x);
  for (const m of stops) {
    const t = Math.abs(rampSpan(r, a, m, mid));
    if (t >= left) return solve(r, a, m, left, mid);
    left -= t;
    a = m;
  }
  const v = rampSpeed(r, forward ? a + 1e-9 : a - 1e-9, mid);
  return a + (forward ? 1 : -1) * left * v;
}

// ---- Clips ----

export const clipEnd = (c: Clip) => c.start + c.duration;
export const isFreeze = (c: Clip) => c.freeze === true;
export const usesSource = (c: Clip) => c.kind === "video" || c.kind === "audio";
export const playsSource = (c: Clip) => usesSource(c) && !isFreeze(c);
export const isTransformable = (c: Clip) => c.kind === "video" || c.kind === "image" || c.kind === "solid";

/** Footage at timeline time t (any time, also outside the clip). */
export function sourceTime(c: Clip, t: number): number {
  if (c.ramp && playsSource(c)) return rampSource(c.ramp, c.sourceStart, t - c.start, c.speed);
  return c.sourceStart + (t - c.start) * c.speed;
}

/** What a renderer shows: a freeze shows `sourceStart` throughout. */
export function clockSource(c: Clip, t: number): number {
  if (isFreeze(c)) return c.sourceStart;
  return sourceTime(c, t);
}

export function sourceLength(c: Clip): number {
  if (!(c.ramp && playsSource(c))) return c.duration * c.speed;
  return sourceTime(c, clipEnd(c)) - c.sourceStart;
}

export function timelineSpan(c: Clip, s0: number, s1: number): number {
  if (c.ramp && playsSource(c)) return rampSpan(c.ramp, s0, s1, c.speed);
  return (s1 - s0) / c.speed;
}

export function fadeGain(c: Clip, t: number): number {
  let g = 1;
  if (c.fadeIn > 0) g = Math.min(g, applyCurve(c.fadeInCurve, (t - c.start) / c.fadeIn));
  if (c.fadeOut > 0) g = Math.min(g, applyCurve(c.fadeOutCurve, (clipEnd(c) - t) / c.fadeOut));
  return clamp(g, 0, 1);
}

// ---- Zoom and transform ----

export function zoomAmount(z: ZoomMove, u: number): number {
  const ramp = (a: number, b: number) => {
    if (b - a <= 1e-6) return u >= a ? 1 : 0;
    const k = clamp((u - a) / (b - a), 0, 1);
    return z.smooth ? smoothstep(k) : k;
  };
  switch (z.mode) {
    case "in": return ramp(z.p1, z.p2);
    case "out": return 1 - ramp(z.p3, z.p4);
    case "inOut": return u < z.p3 ? ramp(z.p1, z.p2) : 1 - ramp(z.p3, z.p4);
  }
}

export function zoomedOffset(t: ClipTransform): [number, number] {
  if (!(t.scale > 1.001)) return [t.x, t.y];
  const m = (t.scale - 1) / 2;
  return [clamp(t.x, -m, m), clamp(t.y, -m, m)];
}

/** The framing at u seconds into the clip (zoom applied). */
export function transformAt(t: ClipTransform | undefined, u: number): { scale: number; x: number; y: number } {
  if (!t) return { scale: 1, x: 0, y: 0 };
  const [ox, oy] = zoomedOffset(t);
  if (!t.zoom) return { scale: t.scale, x: ox, y: oy };
  const k = zoomAmount(t.zoom, u);
  return { scale: 1 + (t.scale - 1) * k, x: ox * k, y: oy * k };
}

// ---- Project queries ----

export const projectDuration = (p: Project) => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
export const snapFrame = (p: Project, t: number) => Math.round(t * p.fps) / p.fps;
export const asset = (p: Project, id?: string) => (id ? p.assets.find((a) => a.id === id) : undefined);
export const allTracks = (p: Project): Track[] => [...p.videoTracks, ...p.audioTracks];
export const trackOf = (p: Project, id: string) => allTracks(p).find((t) => t.id === id);
export const isLocked = (p: Project, track: string) => trackOf(p, track)?.locked ?? false;

export function isAudible(p: Project, t: Track): boolean {
  if (t.muted) return false;
  return !p.audioTracks.some((x) => x.solo) || t.solo;
}

export function linked(p: Project, ids: Iterable<string>): Set<string> {
  const set = new Set(ids);
  const links = new Set(p.clips.filter((c) => set.has(c.id) && c.linkID).map((c) => c.linkID!));
  if (links.size === 0) return set;
  for (const c of p.clips) if (c.linkID && links.has(c.linkID)) set.add(c.id);
  return set;
}

export function unlocked(p: Project, ids: Set<string>): Set<string> {
  const locked = new Set(allTracks(p).filter((t) => t.locked).map((t) => t.id));
  if (locked.size === 0) return ids;
  return new Set(p.clips.filter((c) => ids.has(c.id) && !locked.has(c.trackID)).map((c) => c.id));
}

export function clipName(p: Project, c: Clip): string {
  if (c.kind === "text") {
    const s = c.text.string.replace(/\n/g, " ");
    return s || "Text";
  }
  if (c.kind === "solid") return "Solid";
  return asset(p, c.assetID)?.name ?? "Missing";
}

export function sourceLimit(p: Project, c: Clip): number | undefined {
  if (!playsSource(c)) return undefined;
  return asset(p, c.assetID)?.duration;
}

export function editPoints(p: Project): number[] {
  const s = new Set<number>([0]);
  for (const c of p.clips) { s.add(c.start); s.add(clipEnd(c)); }
  for (const m of p.markers ?? []) s.add(m.time);
  return [...s].sort((a, b) => a - b);
}

export function snapTargets(p: Project, excluding: Set<string>): number[] {
  const out = [0, ...(p.markers ?? []).map((m) => m.time)];
  if (p.inPoint !== undefined) out.push(p.inPoint);
  if (p.outPoint !== undefined) out.push(p.outPoint);
  for (const c of p.clips) if (!excluding.has(c.id)) out.push(c.start, clipEnd(c));
  return out;
}

export function playRange(p: Project): [number, number] | undefined {
  if (p.inPoint === undefined && p.outPoint === undefined) return undefined;
  const a = p.inPoint ?? 0, b = p.outPoint ?? projectDuration(p);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return hi - lo >= 1 / p.fps ? [lo, hi] : undefined;
}

/** Allowed delta range for dragging a clip edge. */
export function trimLimits(p: Project, c: Clip, left: boolean, excluding: Set<string>): [number, number] {
  const others = p.clips.filter((o) => o.trackID === c.trackID && !excluding.has(o.id) && o.id !== c.id);
  const minDur = Math.max(1 / 60, 1 / p.fps);
  if (left) {
    const prevEnd = others.filter((o) => clipEnd(o) <= c.start + 1e-6).reduce((m, o) => Math.max(m, clipEnd(o)), 0);
    let lo = prevEnd - c.start;
    if (playsSource(c)) lo = Math.max(lo, -timelineSpan(c, 0, c.sourceStart));
    const hi = c.duration - minDur;
    return [Math.min(lo, hi), hi];
  }
  const nextStart = others.filter((o) => o.start >= clipEnd(c) - 1e-6).reduce((m, o) => Math.min(m, o.start), Infinity);
  let hi = nextStart - clipEnd(c);
  const limit = sourceLimit(p, c);
  if (limit !== undefined) hi = Math.min(hi, timelineSpan(c, c.sourceStart, limit) - c.duration);
  const lo = minDur - c.duration;
  return [lo, Math.max(lo, hi)];
}

// ---- Trims (Clip.trimHead/trimTail) ----

export function trimHead(c: Clip, t: number): Clip {
  const d = t - c.start;
  const n: Clip = { ...c, start: t, duration: c.duration - d };
  if (playsSource(c)) n.sourceStart = Math.max(0, sourceTime(c, t));
  clampFades(n);
  if (n.transform?.zoom) {
    const z = { ...n.transform.zoom, p1: n.transform.zoom.p1 - d, p2: n.transform.zoom.p2 - d, p3: n.transform.zoom.p3 - d, p4: n.transform.zoom.p4 - d };
    n.transform = { ...n.transform, zoom: fitZoom(z, n.duration) };
  }
  return n;
}

export function trimTail(c: Clip, t: number): Clip {
  const n: Clip = { ...c, duration: t - c.start };
  clampFades(n);
  if (n.transform?.zoom) n.transform = { ...n.transform, zoom: fitZoom(n.transform.zoom, n.duration) };
  return n;
}

function clampFades(c: Clip) {
  c.fadeIn = Math.min(Math.max(0, c.fadeIn), c.duration);
  c.fadeOut = Math.min(Math.max(0, c.fadeOut), c.duration - c.fadeIn);
}

function fitZoom(z: ZoomMove, length: number): ZoomMove {
  const f = (v: number) => clamp(v, 0, length);
  const p1 = f(z.p1), p2 = Math.max(p1, f(z.p2)), p3 = Math.max(p2, f(z.p3)), p4 = Math.max(p3, f(z.p4));
  return { ...z, p1, p2, p3, p4 };
}

// ---- Transitions ----

export interface TransitionEdge { start: number; end: number; kind: TransitionKind }
export interface TransitionPlan { leadIn: number; tailOut: number; reveal?: TransitionEdge; conceal?: TransitionEdge }
export const edgeProgress = (e: TransitionEdge, t: number) => clamp((t - e.start) / Math.max(1e-6, e.end - e.start), 0, 1);

export function previousTouching(p: Project, c: Clip): Clip | undefined {
  const tol = 0.5 / p.fps;
  return p.clips.find((o) => o.id !== c.id && o.trackID === c.trackID && o.kind !== "audio" && Math.abs(clipEnd(o) - c.start) <= tol);
}

export function nextTouching(p: Project, c: Clip): Clip | undefined {
  const tol = 0.5 / p.fps;
  return p.clips.find((o) => o.id !== c.id && o.trackID === c.trackID && o.kind !== "audio" && Math.abs(o.start - clipEnd(c)) <= tol);
}

const headRoom = (c: Clip) => (playsSource(c) ? timelineSpan(c, 0, c.sourceStart) : Infinity);
function tailRoom(p: Project, c: Clip) {
  const limit = sourceLimit(p, c);
  if (!playsSource(c) || limit === undefined) return Infinity;
  return Math.max(0, timelineSpan(c, c.sourceStart + sourceLength(c), limit));
}

export function transitionSpan(p: Project, a: Clip, b: Clip): { start: number; end: number; fromHead: boolean } | undefined {
  const t = b.transitionIn;
  if (!t || b.kind === "audio" || a.kind === "audio") return undefined;
  const cut = b.start, frame = 1 / p.fps;
  if (t.kind === "dipToBlack") {
    const d = Math.min(t.duration, 2 * a.duration, 2 * b.duration);
    return d >= frame ? { start: cut - d / 2, end: cut + d / 2, fromHead: false } : undefined;
  }
  const want = Math.min(t.duration, a.duration, b.duration);
  const head = headRoom(b), tail = tailRoom(p, a);
  if (head >= want) return { start: cut - want, end: cut, fromHead: true };
  if (tail >= want) return { start: cut, end: cut + want, fromHead: false };
  const d = Math.max(head, tail);
  if (d < frame) return undefined;
  return head >= tail ? { start: cut - d, end: cut, fromHead: true } : { start: cut, end: cut + d, fromHead: false };
}

export function transitionPlan(p: Project, c: Clip): TransitionPlan {
  const plan: TransitionPlan = { leadIn: 0, tailOut: 0 };
  if (c.kind === "audio") return plan;
  const a = previousTouching(p, c);
  if (a && c.transitionIn) {
    const span = transitionSpan(p, a, c);
    if (span) {
      const kind = c.transitionIn.kind;
      if (kind === "dipToBlack") plan.reveal = { start: c.start, end: span.end, kind };
      else {
        plan.reveal = { start: span.start, end: span.end, kind };
        if (span.fromHead) plan.leadIn = c.start - span.start;
      }
    }
  }
  const b = nextTouching(p, c);
  if (b && b.transitionIn) {
    const span = transitionSpan(p, c, b);
    if (span) {
      const kind = b.transitionIn.kind;
      if (kind === "dipToBlack") plan.conceal = { start: span.start, end: clipEnd(c), kind };
      else if (!span.fromHead) plan.tailOut = span.end - clipEnd(c);
    }
  }
  return plan;
}

// ---- Formatting (crates/core/src/timecode.rs) ----

export type TimeStyle = "timecode" | "simple";
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function timecode(t: number, fps: number, style: TimeStyle = "timecode"): string {
  if (style === "simple") return simpleTime(t);
  const f = Math.max(1, Math.round(fps));
  const total = Math.round(Math.max(0, t) * fps);
  const frames = total % f, secs = Math.floor(total / f);
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(frames)}`;
}

export function simpleTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const c = cs % 100, secs = Math.floor(cs / 100);
  const s = secs % 60, m = Math.floor(secs / 60) % 60, h = Math.floor(secs / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(c)}` : `${m}:${pad(s)}.${pad(c)}`;
}

export function shortTime(t: number): string {
  const secs = Math.round(Math.max(0, t));
  const s = secs % 60, m = Math.floor(secs / 60) % 60, h = Math.floor(secs / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function parseTimecode(s: string, fps: number, style: TimeStyle = "timecode"): number | undefined {
  const f = Math.max(1, Math.round(fps));
  const text = s.trim();
  if (style === "simple" && /^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) {
    return text.split(":").reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
  }
  let parts: number[] = [];
  if (/[:;.]/.test(text)) {
    const comps = text.split(/[:;.]/).filter((c) => c.length > 0);
    if (comps.length === 0 || comps.length > 4) return undefined;
    for (const c of comps) {
      if (!/^\d+$/.test(c)) return undefined;
      parts.push(parseInt(c, 10));
    }
  } else {
    if (!/^\d{1,8}$/.test(text)) return undefined;
    let digits = text;
    while (digits.length > 0) {
      parts.unshift(parseInt(digits.slice(-2), 10));
      digits = digits.slice(0, -2);
    }
  }
  const r = [...parts.reverse(), 0, 0, 0, 0];
  const frames = ((r[3] * 60 + r[2]) * 60 + r[1]) * f + r[0];
  return frames / fps;
}

export const dbToLinear = (db: number) => (db <= -59.5 ? 0 : Math.pow(10, db / 20));
export function formatDB(db: number): string {
  if (db <= -59.5) return "−∞ dB";
  const v = Math.round(db * 10) / 10;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} dB`;
}
