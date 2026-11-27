// Inspector preferences kept between launches (docs/spec/04-ui.md §5): the shape new speed ramps
// and zoom moves start in. Same key names as Editroom's UserDefaults.

import type { ZoomMode } from "../../model";

export type RampMode = "in" | "inOut";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* private mode */ }
}

/** The ramp shape last picked on the graph (In until another is picked). */
export function speedRampMode(): RampMode {
  const v = read("speedRampMode");
  if (v === "in" || v === "inOut") return v;
  // Before there were named shapes: 2-point was In, 4-point In/Out.
  const legacy = read("speedRampTwoPoint");
  return legacy === "false" ? "inOut" : "in";
}
export const setSpeedRampMode = (m: RampMode) => write("speedRampMode", m);

export function zoomMoveMode(): ZoomMode {
  const v = read("zoomMoveMode");
  return v === "in" || v === "inOut" || v === "out" ? v : "in";
}
export const setZoomMoveMode = (m: ZoomMode) => write("zoomMoveMode", m);
