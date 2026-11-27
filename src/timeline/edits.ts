// The maths behind timeline gestures (docs/spec/01-model.md §3.4–3.8, 3.14; Editroom's
// TimelineCanvas updateMove/updateTrim/updateDrop). Pure functions of the project and the pointer,
// so they are unit tested and the canvas only turns their results into pictures and one edit.

import { NEW_AUDIO_TRACK, NEW_VIDEO_TRACK, DEFAULT_CLIP_COLOR } from "../model";
import type { Clip, Id, Payload, Project, TrackKind } from "../model";
import {
  asset, clipEnd, isLocked, linked, playsSource, snapFrame, snapTargets, sourceLimit, timelineSpan, trimHead,
  trimLimits, trimTail, unlocked,
} from "../timing";
import type { Lane } from "./layout";

// ---- Snapping ----

export interface Snap { delta: number; target: number }

/** The closest candidate/target pair within `pixels` (at `pps`), or undefined. */
export function snap(candidates: number[], targets: number[], pps: number, pixels: number): Snap | undefined {
  const threshold = pixels / pps;
  let best: Snap | undefined;
  for (const c of candidates) {
    for (const t of targets) {
      const d = t - c;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, target: t };
    }
  }
  return best;
}

/** Pixel thresholds: clip move, trim and drops 8; playhead, markers, range edges and the cut tool 6. */
export const SNAP_CLIP = 8;
export const SNAP_POINT = 6;

// ---- Gain line ----

/** Where the gain line sits for a level, as a fraction of the clip height from its top. */
export const gainNorm = (db: number) => (db >= 0 ? 0.3 - (db / 12) * 0.2 : 0.3 + (-db / 60) * 0.62);

/** The level for a gain-line position, rounded to 0.1 dB; −59.5 and below is −60 ("−∞"). */
export function gainFromNorm(norm: number): number {
  const n = Math.min(Math.max(norm, 0.1), 0.92);
  const db = n <= 0.3 ? ((0.3 - n) / 0.2) * 12 : -((n - 0.3) / 0.62) * 60;
  const r = Math.round(db * 10) / 10;
  return r <= -59.5 ? -60 : r;
}

// ---- Fades ----

export function fadeValue(p: Project, c: Clip, t: number, fadeIn: boolean): number {
  return fadeIn
    ? Math.min(Math.max(0, snapFrame(p, t - c.start)), c.duration - c.fadeOut)
    : Math.min(Math.max(0, snapFrame(p, clipEnd(c) - t)), c.duration - c.fadeIn);
}

// ---- Tracks ----

export const trackKindOf = (c: Clip): TrackKind => (c.kind === "audio" ? "audio" : "video");
export const tracksOf = (p: Project, kind: TrackKind) => (kind === "video" ? p.videoTracks : p.audioTracks);
export const newTrackToken = (kind: TrackKind) => (kind === "video" ? NEW_VIDEO_TRACK : NEW_AUDIO_TRACK);
export const trackIndex = (p: Project, id: Id, kind: TrackKind) => {
  const i = tracksOf(p, kind).findIndex((t) => t.id === id);
  return i < 0 ? undefined : i;
};

// ---- Move ----

export interface MoveInput {
  project: Project;
  /** The dragged set: unlocked(linked(selection)) at drag start. */
  originals: Clip[];
  grabbed: Clip;
  /** Time under the pointer when the drag began, and now. */
  startTime: number;
  time: number;
  pps: number;
  playhead: number;
  snapping: boolean;
  lane: Lane;
  /** The track delta of the previous update (kept when the new one would hit a locked track). */
  previousDelta: number;
}

export interface MoveResult {
  clips: Clip[];
  trackDelta: number;
  snapLine?: number;
}

export function computeMove(m: MoveInput): MoveResult {
  const { project, originals, grabbed } = m;
  const ids = new Set(originals.map((c) => c.id));
  const minStart = Math.min(...originals.map((c) => c.start));
  let dt = Math.max(m.time - m.startTime, -minStart);
  let snapLine: number | undefined;
  const candidates = originals.flatMap((c) => [c.start + dt, clipEnd(c) + dt]);
  const s = m.snapping ? snap(candidates, [...snapTargets(project, ids), m.playhead], m.pps, SNAP_CLIP) : undefined;
  if (s && minStart + dt + s.delta >= -1e-9) {
    dt += s.delta;
    snapLine = s.target;
  } else {
    dt = Math.max(snapFrame(project, grabbed.start + dt) - grabbed.start, -minStart);
  }

  // Vertical: the grabbed clip's kind decides.
  const kind = trackKindOf(grabbed);
  const tracks = tracksOf(project, kind);
  let delta = m.previousDelta;
  const gi = trackIndex(project, grabbed.trackID, kind);
  if (gi !== undefined) {
    const lane = m.lane;
    if (lane.kind === "track" && lane.track.kind === kind) delta = lane.index - gi;
    else if (lane.kind === "newVideo" && kind === "video") delta = tracks.length - gi;
    else if (lane.kind === "newAudio" && kind === "audio") delta = tracks.length - gi;
  }
  const indices = originals.filter((c) => trackKindOf(c) === kind)
    .map((c) => trackIndex(project, c.trackID, kind)).filter((i): i is number => i !== undefined);
  if (indices.length) delta = Math.max(-Math.min(...indices), Math.min(delta, tracks.length - Math.max(...indices)));
  // Never onto a locked track.
  if (indices.some((i) => tracks[i + delta]?.locked)) delta = m.previousDelta;

  // Linked partners on the other kind follow only from the matching index (V1↔A1), into free space.
  // Space taken by the partners of clips the dragged ones overwrite counts as free (one Premiere drag).
  const otherKind: TrackKind = kind === "video" ? "audio" : "video";
  const otherTracks = tracksOf(project, otherKind);
  const movedLinks = new Set(originals.filter((c) => trackKindOf(c) === kind && c.linkID).map((c) => c.linkID!));
  const overwritten = new Set<Id>();
  for (const c of originals) {
    if (trackKindOf(c) !== kind) continue;
    const i = trackIndex(project, c.trackID, kind);
    if (i === undefined) continue;
    const target = tracks[i + delta];
    if (!target) continue;
    const start = Math.max(0, c.start + dt), end = start + c.duration;
    for (const o of project.clips) {
      if (o.trackID === target.id && !ids.has(o.id) && o.start < end - 1e-6 && clipEnd(o) > start + 1e-6 && o.linkID) overwritten.add(o.linkID);
    }
  }
  const taken = (track: Id, start: number, end: number) =>
    project.clips.some((o) => o.trackID === track && !ids.has(o.id) && o.start < end - 1e-6 && clipEnd(o) > start + 1e-6
      && !(o.linkID && overwritten.has(o.linkID)));
  const draggedTrack = new Map<Id, number>();
  for (const c of originals) {
    if (trackKindOf(c) !== kind || !c.linkID) continue;
    const i = trackIndex(project, c.trackID, kind);
    if (i !== undefined) draggedTrack.set(c.linkID, i);
  }

  const clips = originals.map((o) => {
    const c: Clip = { ...o, start: Math.max(0, o.start + dt) };
    if (trackKindOf(c) === kind) {
      const i = trackIndex(project, c.trackID, kind);
      if (i !== undefined) {
        const ni = i + delta;
        c.trackID = ni >= tracks.length ? newTrackToken(kind) : tracks[Math.max(0, ni)].id;
      }
    } else if (c.linkID && movedLinks.has(c.linkID)) {
      const i = trackIndex(project, c.trackID, otherKind);
      if (i !== undefined && draggedTrack.get(c.linkID) === i) {
        const ni = Math.max(0, i + delta);
        if (ni >= otherTracks.length) c.trackID = newTrackToken(otherKind);
        else if (ni !== i && !otherTracks[ni].locked && !taken(otherTracks[ni].id, c.start, clipEnd(c))) c.trackID = otherTracks[ni].id;
      }
    }
    return c;
  });
  return { clips, trackDelta: delta, snapLine };
}

/**
 * Copies for an ⌥-drag: fresh ids and fresh link ids, consistent across the set so copied
 * video+audio pairs stay linked to each other (and not to the originals). Tracks are kept, tokens too.
 */
export function freshCopies(clips: Clip[], newId: () => Id = () => crypto.randomUUID().toUpperCase()): Clip[] {
  const links = new Map<Id, Id>();
  return clips.map((c) => {
    const n: Clip = { ...c, id: newId() };
    if (c.linkID) {
      if (!links.has(c.linkID)) links.set(c.linkID, newId());
      n.linkID = links.get(c.linkID);
    }
    return n;
  });
}

// ---- Trim ----

export interface TrimInput {
  project: Project;
  /** unlocked(linked(selection ∪ grabbed group)) at drag start. */
  originals: Clip[];
  grabbed: Clip;
  left: boolean;
  startTime: number;
  time: number;
  pps: number;
  playhead: number;
  snapping: boolean;
  sticky: boolean;
}

export interface TrimResult {
  /** The trimmed clips, plus (sticky) the clips carried along. */
  clips: Clip[];
  delta: number;
  snapLine?: number;
}

const MIN_CLIP = 1 / 60;
const minDuration = (p: Project) => Math.max(MIN_CLIP, 1 / p.fps);

/** The pointer's edge delta, snapped to targets (8 px) or else to frames. */
function edgeDelta(t: TrimInput, ids: Set<Id>): { d: number; target?: number } {
  const edge = t.left ? t.grabbed.start : clipEnd(t.grabbed);
  const d = t.time - t.startTime;
  const s = t.snapping ? snap([edge + d], [...snapTargets(t.project, ids), t.playhead], t.pps, SNAP_CLIP) : undefined;
  if (s) return { d: d + s.delta, target: s.target };
  return { d: snapFrame(t.project, edge + d) - edge };
}

/** A left edge is attached when at t≈0 or butted against another clip on its track. */
export function attachedOnLeft(clips: Clip[], p: Project): boolean {
  const ids = new Set(clips.map((c) => c.id));
  const tol = 0.5 / p.fps;
  return clips.some((c) => c.start <= tol || p.clips.some((o) => !ids.has(o.id) && o.trackID === c.trackID && Math.abs(clipEnd(o) - c.start) <= tol));
}

export function computeTrim(t: TrimInput): TrimResult {
  if (t.sticky && (!t.left || attachedOnLeft(t.originals, t.project))) return computeStickyTrim(t);
  const { project, originals, left } = t;
  const ids = new Set(originals.map((c) => c.id));
  const { d: raw, target } = edgeDelta(t, ids);
  let lo = -Infinity, hi = Infinity;
  for (const c of originals) {
    const [a, b] = trimLimits(project, c, left, ids);
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
  }
  const d = Math.min(Math.max(raw, lo), Math.max(lo, hi));
  const clips = originals.map((c) => (left ? trimHead(c, c.start + d) : trimTail(c, clipEnd(c) + d)));
  return { clips, delta: d, snapLine: d === raw ? target : undefined };
}

/**
 * Sticky trim: only the clip's own media and minimum length limit it; a left trim keeps the start
 * (content comes off the front); everything touching the end follows. If something carried would
 * collide, go as far as fits.
 */
function computeStickyTrim(t: TrimInput): TrimResult {
  const { project, originals, left } = t;
  const ids = new Set(originals.map((c) => c.id));
  const { d: raw, target } = edgeDelta(t, ids);
  const minDur = minDuration(project);
  let lo = -Infinity, hi = Infinity;
  for (const c of originals) {
    if (left) {
      if (playsSource(c)) lo = Math.max(lo, -timelineSpan(c, 0, c.sourceStart));
      hi = Math.min(hi, c.duration - minDur);
    } else {
      lo = Math.max(lo, minDur - c.duration);
      const limit = sourceLimit(project, c);
      if (limit !== undefined) hi = Math.min(hi, timelineSpan(c, c.sourceStart, limit) - c.duration);
    }
  }
  const clamped = Math.min(Math.max(raw, lo), Math.max(lo, hi));
  let snapLine = clamped === raw ? target : undefined;
  const result = (d: number) => {
    const edited = new Map<Id, Clip>();
    for (const c of originals) {
      if (left) edited.set(c.id, { ...trimHead(c, c.start + d), start: c.start });
      else edited.set(c.id, trimTail(c, clipEnd(c) + d));
    }
    for (const [id, c] of carried(project, edited)) if (!edited.has(id)) edited.set(id, c);
    return edited;
  };
  let out = result(clamped);
  let d = clamped;
  if (!fits(project, out)) {
    snapLine = undefined;
    let ok = 0, bad = clamped;
    for (let i = 0; i < 24; i++) {
      const mid = (ok + bad) / 2;
      if (fits(project, result(mid))) ok = mid; else bad = mid;
    }
    d = ok;
    out = result(ok);
  }
  return { clips: [...out.values()], delta: d, snapLine };
}

/** Sticky edges: clips touching (or run into by) an edited clip's end butt onto its new end, transitively. */
export function carried(p: Project, edited: Map<Id, Clip>): Map<Id, Clip> {
  const touch = 0.5 / p.fps;
  const out = new Map<Id, Clip>();
  const byId = new Map(p.clips.map((c) => [c.id, c]));
  const queue: { track: Id; oldEnd: number; newEnd: number }[] = [];
  for (const [id, e] of edited) {
    const o = byId.get(id);
    if (o) queue.push({ track: o.trackID, oldEnd: clipEnd(o), newEnd: clipEnd(e) });
  }
  while (queue.length) {
    const q = queue.shift()!;
    const shift = q.newEnd - q.oldEnd;
    if (Math.abs(shift) <= 1e-9 || isLocked(p, q.track)) continue;
    const after = p.clips.filter((c) => c.trackID === q.track && !edited.has(c.id) && c.start >= q.oldEnd - touch);
    if (!after.length) continue;
    const nearest = Math.min(...after.map((c) => c.start));
    for (const c of after) {
      if (c.start > nearest + 1e-9 || out.has(c.id)) continue;
      const touching = Math.abs(c.start - q.oldEnd) <= touch;
      const runInto = shift > 0 && c.start < q.newEnd - 1e-9;
      if (!touching && !runInto) continue;
      const s = q.newEnd - c.start;
      for (const id of linked(p, [c.id])) {
        if (edited.has(id) || out.has(id)) continue;
        const m = byId.get(id);
        if (!m) continue;
        const moved = { ...m, start: m.start + s };
        out.set(id, moved);
        queue.push({ track: m.trackID, oldEnd: clipEnd(m), newEnd: clipEnd(moved) });
      }
    }
  }
  return out;
}

/** True when the changes leave nothing before zero and no two clips on a track overlapping. */
export function fits(p: Project, changed: Map<Id, Clip>): boolean {
  for (const c of changed.values()) if (c.start < -1e-9) return false;
  const byTrack = new Map<Id, Clip[]>();
  for (const c of p.clips) {
    const n = changed.get(c.id) ?? c;
    const list = byTrack.get(n.trackID);
    if (list) list.push(n); else byTrack.set(n.trackID, [n]);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      if ((changed.has(a.id) || changed.has(b.id)) && clipEnd(a) > b.start + 1e-6) return false;
    }
  }
  return true;
}

// ---- Drops and clip creation (crates/core edit.rs make_clips / payload_duration) ----

export function payloadDuration(p: Project, payload: Payload): number {
  if (payload.type !== "asset") return 5;
  const a = asset(p, payload.id);
  if (!a || a.kind === "image") return 5;
  return Math.max(1 / p.fps, Math.floor(a.duration * p.fps + 1e-6) / p.fps);
}

let ghostCounter = 0;
const ghostId = () => `ghost-${++ghostCounter}`;

function baseClip(kind: Clip["kind"], trackID: Id, start: number, duration: number): Clip {
  return {
    id: ghostId(), trackID, kind, start, duration, sourceStart: 0, speed: 1, fadeIn: 0, fadeOut: 0, gainDB: 0,
    color: { ...DEFAULT_CLIP_COLOR },
    text: { string: "Text", fontName: "", bold: true, size: 110, color: { r: 1, g: 1, b: 1, a: 1 }, x: 0.5, y: 0.5 },
  };
}

/** The clips a payload makes at `start` (for drop ghosts; the backend makes the real ones). */
export function makeClips(p: Project, payload: Payload, start: number, videoTrack: Id, audioTrack: Id): Clip[] {
  const d = payloadDuration(p, payload);
  if (payload.type === "solid") return [baseClip("solid", videoTrack, start, d)];
  if (payload.type === "text") return [baseClip("text", videoTrack, start, d)];
  const a = asset(p, payload.id);
  if (!a) return [];
  if (a.kind === "image") return [{ ...baseClip("image", videoTrack, start, d), assetID: a.id }];
  if (a.kind === "audio") return [{ ...baseClip("audio", audioTrack, start, d), assetID: a.id }];
  const v: Clip = { ...baseClip("video", videoTrack, start, d), assetID: a.id };
  if (!a.hasAudio) return [v];
  const link = ghostId();
  return [{ ...v, linkID: link }, { ...baseClip("audio", audioTrack, start, d), assetID: a.id, linkID: link }];
}

export interface DropInput {
  project: Project;
  payloads: Payload[];
  lane: Lane;
  /** Time under the pointer, or undefined when over the track headers (lands at 0). */
  time: number | undefined;
  pps: number;
  playhead: number;
  snapping: boolean;
  /** Total length when the payloads aren't known yet (files being dragged in): 5 s. */
  fallbackDuration?: number;
}

export interface DropPlan {
  videoTrack: Id;
  audioTrack: Id;
  start: number;
  /** The lane is an audio row or the "+ Audio" zone (a file ghost shows as audio there). */
  overAudio: boolean;
  ghosts: Clip[];
  snapLine?: number;
}

/** Where a Media drop lands: tracks from the lane under the pointer, start snapped (8 px) or frame-snapped. */
export function planDrop(d: DropInput): DropPlan | undefined {
  const p = d.project;
  const v = p.videoTracks, a = p.audioTracks;
  if (!v.length || !a.length) return undefined;
  let videoTrack = v[0].id, audioTrack = a[0].id, overAudio = false;
  const lane = d.lane;
  if (lane.kind === "track" && lane.track.kind === "video") {
    videoTrack = lane.track.id;
    audioTrack = a[Math.min(lane.index, a.length - 1)].id;
  } else if (lane.kind === "track") {
    audioTrack = lane.track.id;
    videoTrack = v[Math.min(lane.index, v.length - 1)].id;
    overAudio = true;
  } else if (lane.kind === "newVideo") {
    videoTrack = NEW_VIDEO_TRACK;
    audioTrack = a[Math.min(v.length, a.length - 1)].id;
  } else if (lane.kind === "newAudio") {
    audioTrack = NEW_AUDIO_TRACK;
    videoTrack = v[Math.min(a.length, v.length - 1)].id;
    overAudio = true;
  }
  // Nothing lands on a locked track: the first open one of the kind, or a new track.
  const open = (id: Id, kind: TrackKind) =>
    isLocked(p, id) ? (tracksOf(p, kind).find((t) => !t.locked)?.id ?? newTrackToken(kind)) : id;
  videoTrack = open(videoTrack, "video");
  audioTrack = open(audioTrack, "audio");

  const duration = d.payloads.length
    ? d.payloads.reduce((sum, pl) => sum + payloadDuration(p, pl), 0)
    : (d.fallbackDuration ?? 5);
  let start = d.time === undefined ? 0 : Math.max(0, d.time);
  let snapLine: number | undefined;
  const s = d.snapping ? snap([start, start + duration], [...snapTargets(p, new Set()), d.playhead], d.pps, SNAP_CLIP) : undefined;
  if (s && start + s.delta >= -1e-9) {
    start = Math.max(0, start + s.delta);
    snapLine = s.target;
  } else {
    start = snapFrame(p, start);
  }
  const ghosts: Clip[] = [];
  let t = start;
  for (const pl of d.payloads) {
    ghosts.push(...makeClips(p, pl, t, videoTrack, audioTrack));
    t = snapFrame(p, t + payloadDuration(p, pl));
  }
  if (!d.payloads.length) {
    ghosts.push({ ...baseClip(overAudio ? "audio" : "video", overAudio ? audioTrack : videoTrack, start, duration) });
  }
  return { videoTrack, audioTrack, start, overAudio, ghosts, snapLine };
}

// ---- Cut tool ----

/** The blade time over a clip (snapped 6 px to targets + playhead, else to frames), if it may split. */
export function cutTime(p: Project, c: Clip, time: number, pps: number, playhead: number, snapping: boolean): number | undefined {
  let t = time;
  const s = snapping ? snap([t], [...snapTargets(p, new Set([c.id])), playhead], pps, SNAP_POINT) : undefined;
  t = s ? t + s.delta : snapFrame(p, t);
  const min = 0.5 / p.fps;
  return t > c.start + min && t < clipEnd(c) - min ? t : undefined;
}

// ---- Selection helpers ----

/** The unlocked linked group of a clip. */
export const groupOf = (p: Project, id: Id) => unlocked(p, linked(p, [id]));
