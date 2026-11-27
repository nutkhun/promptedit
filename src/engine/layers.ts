// What the picture is made of at one moment: the project evaluated at a frame time into an
// ordered list of layers, bottom first (Editroom CompositionBuilder.build + TimelineCompositor.compose,
// docs/spec/02-engine.md §1, §4, §6, §7). Pure: no decoding or drawing here.

import type { Clip, ColorGrade, Id, Project, RGBA, TextStyle } from "../model";
import { clamp, clipEnd, clockSource, edgeProgress, isFreeze, applyCurve, transitionPlan, transformAt } from "../timing";
import type { TransitionEdge, TransitionPlan } from "../timing";

/** Where a video layer's picture comes from in its file. */
export interface VideoPick {
  asset: Id;
  /** File time. */
  time: number;
  /**
   * Which frame: "at" = the one showing at `time` (last pts ≤ time); "before" = the one just
   * before `time` (last pts < time), used for reversed clips so the frame that *ends* at `time` shows.
   */
  rule: "at" | "before";
}

export type LayerSource =
  | { kind: "video"; pick: VideoPick }
  | { kind: "image"; asset: Id }
  | { kind: "solid"; color: RGBA }
  | { kind: "text"; style: TextStyle };

export interface Layer {
  clipID: Id;
  /** Index into project.videoTracks (0 = V1). */
  track: number;
  source: LayerSource;
  /** 0…1, fades and dissolve/dip transitions applied (§4.2). */
  opacity: number;
  /** For a wipe in progress: the eased fraction of the picture showing, from the left (§4.3). */
  wipe?: number;
  /** Scale about the frame centre, then offset (fractions of the frame, y down). Absent: identity. */
  transform?: { scale: number; x: number; y: number };
  grade?: ColorGrade;
}

/** Sampling epsilon: layers are evaluated just after the frame time, media clocks at the frame time (§0). */
export const EPS = 1e-4;

/** `RenderLayer.opacity` (§4.2): the clip's own fades hold their end value during transition extensions. */
export function layerOpacity(c: Clip, plan: TransitionPlan, t: number): number {
  let o = 1;
  const ft = Math.min(Math.max(t, c.start), clipEnd(c));
  if (c.fadeIn > 0) o = Math.min(o, applyCurve(c.fadeInCurve, (ft - c.start) / c.fadeIn));
  if (c.fadeOut > 0) o = Math.min(o, applyCurve(c.fadeOutCurve, (clipEnd(c) - ft) / c.fadeOut));
  if (plan.reveal && plan.reveal.kind !== "wipe") o *= edgeProgress(plan.reveal, t);
  if (plan.conceal) o *= 1 - edgeProgress(plan.conceal, t);
  return clamp(o, 0, 1);
}

export function wipeAt(reveal: TransitionEdge | undefined, t: number): number | undefined {
  if (!reveal || reveal.kind !== "wipe" || !(t < reveal.end)) return undefined;
  const p = edgeProgress(reveal, t);
  return p * p * (3 - 2 * p);
}

const isIdentity = (c: Clip) => {
  const tf = c.transform;
  return !tf || (tf.scale === 1 && tf.x === 0 && tf.y === 0 && !tf.zoom);
};

/** The file frame a video clip shows at layer time `t` (media clock at `t - EPS`), or undefined when off the media. */
export function videoPick(p: Project, c: Clip, t: number): VideoPick | undefined {
  const a = p.assets.find((x) => x.id === c.assetID);
  if (!a) return undefined;
  const length = a.duration;
  if (isFreeze(c)) {
    // One 1/60 s slice at sourceStart, clamped into the media (§6.3).
    const at = Math.min(Math.max(0, c.sourceStart), Math.max(0, length - 1 / 60));
    return { asset: a.id, time: at, rule: "at" };
  }
  const s = clockSource(c, t - EPS);
  if (c.reversed === true) {
    const ft = length - s;
    if (ft <= 0 || ft > length + 1e-6) return undefined;
    return { asset: a.id, time: ft - 1e-6, rule: "before" };
  }
  if (s < -1e-6 || s >= length) return undefined;
  return { asset: a.id, time: Math.max(0, s), rule: "at" };
}

/** Every layer visible at frame time `frameTime`, bottom first. */
export function layersAt(p: Project, frameTime: number): Layer[] {
  const t = frameTime + EPS;
  const out: Layer[] = [];
  p.videoTracks.forEach((track, ti) => {
    if (track.hidden) return;
    const clips = p.clips.filter((c) => c.trackID === track.id && c.kind !== "audio").sort((a, b) => a.start - b.start);
    for (const c of clips) {
      const plan = transitionPlan(p, c);
      if (!(t >= c.start - plan.leadIn && t < clipEnd(c) + plan.tailOut)) continue;
      const opacity = layerOpacity(c, plan, t);
      if (opacity <= 0.001) continue;
      let source: LayerSource | undefined;
      switch (c.kind) {
        case "video": {
          const pick = videoPick(p, c, t);
          if (pick) source = { kind: "video", pick };
          break;
        }
        case "image":
          if (c.assetID) source = { kind: "image", asset: c.assetID };
          break;
        case "solid":
          source = { kind: "solid", color: c.color };
          break;
        case "text":
          if (c.text.string !== "") source = { kind: "text", style: c.text };
          break;
      }
      if (!source) continue;
      const layer: Layer = { clipID: c.id, track: ti, source, opacity, grade: c.grade };
      const w = wipeAt(plan.reveal, t);
      if (w !== undefined) layer.wipe = w;
      if (!isIdentity(c)) layer.transform = transformAt(c.transform, t - c.start);
      out.push(layer);
    }
  });
  return out;
}

/** Picks the frame for `pick` from presentation times sorted ascending; -1 when none qualifies. */
export function pickFrame(pts: ArrayLike<number>, pick: Pick<VideoPick, "time" | "rule">): number {
  // Binary search for the last frame with pts ≤ time ("at") or pts < time ("before").
  const tol = pick.rule === "at" ? 1e-5 : 0;
  let lo = 0, hi = pts.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ok = pick.rule === "at" ? pts[mid] <= pick.time + tol : pts[mid] < pick.time;
    if (ok) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // Before the first frame: the first frame (the reverse reader's fallback at chunk 0; and a file
  // whose first frame starts a hair late still shows it at 0).
  if (best < 0 && pts.length > 0) return 0;
  return best;
}
