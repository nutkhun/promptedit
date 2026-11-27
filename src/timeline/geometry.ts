// Screen geometry of the timeline canvas: time ↔ x, clip rectangles and hit zones
// (docs/spec/04-ui.md §3.1, §3.6).

import type { Clip, Id, Project } from "../model";
import { clipEnd, isLocked } from "../timing";
import type { ViewState } from "./viewMath";
import { RULER, band, laneAt } from "./layout";
import type { Lane, Layout } from "./layout";
import { gainNorm } from "./edits";

export interface Rect { x: number; y: number; w: number; h: number }
export type Zone = "body" | "left" | "right" | "fadeIn" | "fadeOut" | "gain";

export const contains = (r: Rect, px: number, py: number) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export class Geometry {
  constructor(readonly project: Project, readonly layout: Layout, readonly view: ViewState) {}

  get pps() { return this.view.pps; }
  x(t: number) { return t * this.view.pps - this.view.scrollX; }
  time(x: number) { return (x + this.view.scrollX) / this.view.pps; }
  /** Content y (layout coordinates) of a canvas y. */
  contentY(y: number) { return y - RULER + this.view.scrollY; }
  lane(y: number): Lane { return laneAt(this.layout, this.contentY(y)); }

  /** A clip's full band (the drawn body is inset 2 top/bottom). */
  rect(c: Clip): Rect | undefined {
    const b = band(this.layout, c.trackID);
    if (!b) return undefined;
    return { x: this.x(c.start), y: RULER + b.y - this.view.scrollY, w: Math.max(c.duration * this.view.pps, 1), h: b.height };
  }

  /** The drawn body: inset 2 top/bottom and up to 0.5 at the sides. */
  body(full: Rect): Rect {
    const dx = Math.min(0.5, full.w / 4);
    return { x: full.x + dx, y: full.y + 2, w: full.w - 2 * dx, h: full.h - 4 };
  }

  /** Fade dot x: the clip edge ± fade length, kept 6 px inside the clip. */
  fadeHandleX(c: Clip, r: Rect, fadeIn: boolean) {
    const raw = fadeIn ? r.x + c.fadeIn * this.view.pps : r.x + r.w - c.fadeOut * this.view.pps;
    return Math.min(Math.max(raw, r.x + 6), r.x + r.w - 6);
  }

  captionRect(start: number, end: number): Rect | undefined {
    if (this.layout.captionY === undefined) return undefined;
    return { x: this.x(start), y: RULER + this.layout.captionY - this.view.scrollY, w: Math.max((end - start) * this.view.pps, 2), h: 30 };
  }

  inCaptionRow(y: number) {
    if (this.layout.captionY === undefined || y < RULER) return false;
    const cy = this.contentY(y);
    return cy >= this.layout.captionY && cy < this.layout.captionY + 30;
  }

  /** The clip and zone under a point; clips on locked tracks are never hit. Fade dots, edges, gain line, body. */
  hit(px: number, py: number): { clip: Clip; zone: Zone; rect: Rect } | undefined {
    if (py < RULER) return undefined;
    const p = this.project;
    for (const c of p.clips) {
      if (isLocked(p, c.trackID)) continue;
      const r = this.rect(c);
      if (!r || !contains(r, px, py)) continue;
      if (r.w > 36 && (c.fadeIn > 0 || c.fadeOut > 0) && py < r.y + 17) {
        const hi = this.fadeHandleX(c, r, true), ho = this.fadeHandleX(c, r, false);
        const di = c.fadeIn > 0 ? Math.abs(px - hi) : Infinity, dout = c.fadeOut > 0 ? Math.abs(px - ho) : Infinity;
        if (Math.min(di, dout) <= 7) {
          let takeIn = di <= dout;
          // Overlapping dots: the longer fade (drawn on top) takes the click; equal: the side clicked.
          if (Math.abs(hi - ho) < 8 && c.fadeIn > 0 && c.fadeOut > 0) takeIn = c.fadeIn !== c.fadeOut ? c.fadeIn > c.fadeOut : px < hi;
          return { clip: c, zone: takeIn ? "fadeIn" : "fadeOut", rect: r };
        }
      }
      const edge = Math.min(7, Math.max(2, r.w / 4));
      if (px - r.x <= edge) return { clip: c, zone: "left", rect: r };
      if (r.x + r.w - px <= edge) return { clip: c, zone: "right", rect: r };
      if (c.kind === "audio" && Math.abs(py - (r.y + gainNorm(c.gainDB) * r.h)) <= 3.5) return { clip: c, zone: "gain", rect: r };
      return { clip: c, zone: "body", rect: r };
    }
    return undefined;
  }

  /** Clips on unlocked tracks whose rectangles touch a canvas rectangle. */
  clipsIn(box: Rect): Id[] {
    const out: Id[] = [];
    for (const c of this.project.clips) {
      if (isLocked(this.project, c.trackID)) continue;
      const r = this.rect(c);
      if (r && intersects(r, box)) out.push(c.id);
    }
    return out;
  }

  clipVisible(c: Clip, width: number) {
    const a = this.x(c.start), b = this.x(clipEnd(c));
    return b > -4 && a < width + 4;
  }
}
