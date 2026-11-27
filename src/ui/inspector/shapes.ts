// The shapes behind the speed-ramp and zoom graphs (Editroom's SpeedRampGraph / ZoomGraph and
// ZoomMove.starter; docs/spec/01-model.md §2.10, §3.2–3.3). Pure functions, unit tested.

import type { Clip, ZoomMode, ZoomMove } from "../../model";
import { clamp, playsSource, rampSpeed, sourceLength, timelineSpan } from "../../timing";
import type { RampMode } from "./prefs";

// ---- Speed ramp ----

/**
 * A ramp as the graph draws it: the middle speed, where the eases begin and end as fractions of
 * the clip's footage (in-ramp p1…p2, out-ramp p3…p4), and the speeds before and after.
 */
export interface RampShape {
  mid: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  start: number;
  end: number;
}

export const hasIn = (s: RampShape) => s.p2 - s.p1 > 0.001;
export const hasOut = (s: RampShape) => s.p4 - s.p3 > 0.001;
/** Eases in and holds: the In shape. Anything else is In/Out. */
export const rampMode = (s: RampShape): RampMode => (hasIn(s) && !hasOut(s) ? "in" : "inOut");

export const isRamped = (c: Clip) => c.ramp !== undefined && c.ramp !== null && playsSource(c);

/** Speeds the graph covers (log axis). */
export const RAMP_LO = 0.1, RAMP_HI = 10;

/** Starter points for a new ramp in each mode. */
export const RAMP_STARTER: Record<RampMode, [number, number, number, number]> = {
  in: [0.3, 0.6, 1, 1],
  inOut: [0.3, 0.4, 0.6, 0.7],
};

/** A new ramp's middle speed: the clip's speed, or a dip to 50% if it plays at 100%. */
export const starterMid = (speed: number) => (Math.abs(speed - 1) < 0.001 ? 0.5 : speed);

/** The clip's ramp as the graph shows it. */
export function rampShapeOf(c: Clip): RampShape {
  const s0 = c.sourceStart, L = Math.max(1e-6, sourceLength(c)), s1 = s0 + L;
  const f = (s: number) => clamp((s - s0) / L, 0, 1);
  const out: RampShape = { mid: c.speed, p1: 0, p2: 0, p3: 1, p4: 1, start: c.speed, end: c.speed };
  const r = c.ramp;
  if (r && isRamped(c)) {
    if (r.inTo > r.inFrom && r.inTo > s0 + 1e-6) {
      out.p1 = f(r.inFrom);
      out.p2 = f(r.inTo);
      out.start = rampSpeed(r, s0 + out.p1 * L, c.speed);
    }
    if (r.outTo > r.outFrom && r.outFrom < s1 - 1e-6) {
      out.p3 = Math.max(out.p2, f(r.outFrom));
      out.p4 = Math.max(out.p3, f(r.outTo));
      out.end = rampSpeed(r, s0 + out.p4 * L, c.speed);
    }
  }
  return out;
}

/** Timeline time of a point f of the way across a clip's footage. */
export function rampTime(f: number, c: Clip): number {
  const s0 = c.sourceStart;
  return c.start + timelineSpan(c, s0, s0 + sourceLength(c) * clamp(f, 0, 1));
}

/** Speed at x (0…1 across the footage) on the drawn curve: smoothstep in log speed. */
export function rampCurveAt(s: RampShape, x: number): number {
  const ease = (u: number) => u * u * (3 - 2 * u);
  const blend = (a: number, b: number, u: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * ease(clamp(u, 0, 1)));
  if (hasIn(s) && x < s.p2) return x <= s.p1 ? s.start : blend(s.start, s.mid, (x - s.p1) / (s.p2 - s.p1));
  if (hasOut(s) && x > s.p3) return x >= s.p4 ? s.end : blend(s.mid, s.end, (x - s.p3) / (s.p4 - s.p3));
  return s.mid;
}

export type RampPart = "inStart" | "inEnd" | "outStart" | "outEnd" | "line";

/**
 * A dot (or the flat middle) dragged to fraction f across the footage at speed v. `mode` is the
 * shape the graph was in when the drag began (pulling a dot away mid-drag doesn't switch it).
 */
export function dragRamp(part: RampPart, from: RampShape, f: number, v: number, mode: RampMode): RampShape {
  const d = { ...from };
  switch (part) {
    case "inEnd": {
      const had = hasIn(d);
      d.p2 = Math.min(Math.max(f, d.p1), d.p3);
      if (!hasIn(d)) { d.p1 = d.p2; d.start = d.mid; } else if (!had) { d.p1 = 0; d.start = 1; }
      // In: the right dot is also the speed it eases to.
      if (mode === "in") d.mid = v;
      break;
    }
    case "outStart": {
      const had = hasOut(d);
      d.p3 = Math.max(Math.min(f, d.p4), d.p2);
      if (!hasOut(d)) { d.p4 = d.p3; d.end = d.mid; } else if (!had) { d.p4 = 1; d.end = 1; }
      break;
    }
    case "inStart":
      // Up to its inner dot, never onto it (pulling the inner dot back out removes a ramp).
      d.p1 = Math.min(f, d.p2 - 0.01);
      d.start = v;
      break;
    case "outEnd":
      d.p4 = Math.max(f, d.p3 + 0.01);
      d.end = v;
      break;
    case "line":
      d.mid = v;
      break;
  }
  // A ramp squeezed to nothing is gone.
  if (!hasIn(d)) { d.p1 = 0; d.p2 = 0; d.start = d.mid; }
  if (!hasOut(d)) { d.p3 = 1; d.p4 = 1; d.end = d.mid; }
  return d;
}

/** Switches shape, keeping as much of the ramp as fits the other one. */
export function switchRampMode(m: RampMode, s: RampShape): RampShape {
  // Just the ease in: the one ease there is, or the way out turned round to come in.
  const asIn = (x: RampShape): RampShape => {
    if (hasIn(x)) return { ...x, p3: 1, p4: 1, end: x.mid };
    return { mid: x.end, p1: x.p3, p2: x.p4, p3: 1, p4: 1, start: x.mid, end: x.end };
  };
  const d = asIn(s);
  if (m === "in") return d;
  // Ease back to the starting speed, in the room after the first ease (made if there's little).
  if (d.p2 > 0.6) {
    const k = 0.6 / d.p2;
    d.p1 *= k;
    d.p2 *= k;
  }
  const room = 1 - d.p2;
  d.p3 = d.p2 + room * 0.4;
  d.p4 = d.p2 + room * 0.7;
  d.end = d.start;
  return d;
}

/** A speed from the graph's log axis, with a little pull toward 100%. */
export function snapSpeed(v: number): number {
  return Math.abs(Math.log(v)) < 0.06 ? 1 : v;
}

// ---- Zoom move ----

/** A new zoom of a clip `length` seconds long. */
export function zoomStarter(mode: ZoomMode, length: number, smooth = true): ZoomMove {
  const L = length;
  const m = Math.min(Math.max(L * 0.25, 0.5), 2, L / 2);
  switch (mode) {
    case "in": return { mode, p1: 0, p2: m, p3: L, p4: L, smooth };
    case "out": return { mode, p1: 0, p2: 0, p3: L - m, p4: L, smooth };
    case "inOut": return { mode, p1: 0, p2: m, p3: L - m, p4: L, smooth };
  }
}

/** Where the zoom is fully in, in seconds from the clip's start. */
export function zoomedTime(z: ZoomMove, length: number): number {
  const hi = Math.max(0, length - 1e-3);
  return z.mode === "out" ? clamp(z.p3 - 1e-3, 0, hi) : clamp(z.p2, 0, hi);
}

/** The graph's top in fixed steps: 300%, then 500%, then 1000% (the most a scale can be). */
export function zoomGraphTop(scale: number): number {
  return [3, 5].find((s) => scale < s * 0.97) ?? 10;
}

/** Where the top line runs, between the dots at the zoomed-in scale. */
export function zoomLineSpan(z: ZoomMove, length: number): [number, number] {
  switch (z.mode) {
    case "in": return [z.p2, length];
    case "out": return [0, z.p3];
    case "inOut": return [z.p2, z.p3];
  }
}

export type ZoomPart = "p1" | "p2" | "p3" | "p4" | "line";

/** A zoom dot dragged to t seconds into the clip (already frame-snapped); keeps a frame between dots. */
export function dragZoom(part: Exclude<ZoomPart, "line">, from: ZoomMove, t: number, length: number, fps: number): ZoomMove {
  const z = { ...from };
  const gap = 1 / fps;
  switch (part) {
    case "p1": z.p1 = Math.min(t, z.p2 - gap); break;
    case "p2": z.p2 = Math.min(Math.max(t, z.p1 + gap), z.mode === "inOut" ? z.p3 : length); break;
    case "p3": z.p3 = Math.max(Math.min(t, z.p4 - gap), z.mode === "inOut" ? z.p2 : 0); break;
    case "p4": z.p4 = Math.max(t, z.p3 + gap); break;
  }
  z.p1 = Math.max(0, z.p1);
  z.p4 = Math.min(length, z.p4);
  return z;
}
