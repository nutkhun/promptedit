// Ruler tick spacing and labels (docs/spec/04-ui.md §3.3).

import { shortTime, simpleTime } from "../timing";
import type { TimeStyle } from "../timing";

export interface RulerStep {
  /** Seconds between major ticks. */
  major: number;
  /** Minor ticks per major (1 = none). */
  subdivisions: number;
}

/** The first step whose major tick spacing is ≥ 86 px (skipping 0.5…1 s steps). */
export function rulerStep(pps: number, fps: number): RulerStep {
  const f = 1 / fps;
  const steps: [number, number][] = [
    [f, 1], [2 * f, 2], [5 * f, 5], [10 * f, 5], [1, 4], [2, 4], [5, 5], [10, 5], [15, 3], [30, 6],
    [60, 6], [120, 4], [300, 5], [600, 5], [900, 3], [1800, 6], [3600, 6], [7200, 4], [18000, 5], [36000, 5],
  ];
  for (const [major, subdivisions] of steps) {
    if (major * pps >= 86 && (major >= 1 || major < 0.5)) return { major, subdivisions };
  }
  const [major, subdivisions] = steps[steps.length - 1];
  return { major, subdivisions };
}

/** "m:ss" / "h:mm:ss"; below a second per step: "m:ss:ff" (timecode) or "m:ss.cc" (simple). */
export function rulerLabel(t: number, step: RulerStep, fps: number, style: TimeStyle): string {
  if (step.major >= 1) return shortTime(t);
  if (style === "simple") return simpleTime(t);
  const frames = Math.round(t * fps) % Math.max(1, Math.round(fps));
  return `${shortTime(Math.floor(t + 1e-6))}:${String(frames).padStart(2, "0")}`;
}
