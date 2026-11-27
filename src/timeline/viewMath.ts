// Zoom, scroll and row-height limits of the timeline (Editroom's EditorModel "Zoom" section,
// docs/spec/04-ui.md §3.1–3.2 and §1.6). Every view change goes through `clampView`, so the
// canvas, the scroll bars and the wheel all agree on one set of limits and re-clamping is stable.

import type { Project } from "../model";
import { projectDuration } from "../timing";
import { DIVIDER, FIXED_HEIGHT, GAP, ROW_MAX, ROW_MIN, RULER, ZONE, captionSpace } from "./layout";

export const MIN_PPS = 0.05;
export const MAX_PPS = 2400;
/** Scroll bar thickness and grip size. */
export const BAR = 15;
export const HANDLE = 11;

export interface ViewState {
  /** Points per second. */
  pps: number;
  scrollX: number;
  /** How far the top of the tracks is above the top of the view (negative when they sit lower). */
  scrollY: number;
  rowHeight: number;
  /** The canvas size (ruler included, scroll bars excluded). */
  viewWidth: number;
  viewHeight: number;
}

/** Seconds of timeline that can be scrolled to: the content plus working room after it. */
export const extent = (p: Project) => Math.max(30, projectDuration(p) * 1.3 + 10);
/** Fully zoomed out shows exactly `extent`. */
export const minPPS = (p: Project, v: ViewState) => Math.max(MIN_PPS, v.viewWidth / extent(p));
export const maxScrollX = (p: Project, v: ViewState) => Math.max(0, extent(p) * v.pps - v.viewWidth);

export const rowsVisible = (v: ViewState) => Math.max(40, v.viewHeight - RULER);

/** Distance from the top of the tracks to the middle of the video/audio divider: the vertical "home". */
export const rowsAbove = (p: Project, row: number) =>
  captionSpace(p) + ZONE + p.videoTracks.length * (row + GAP) + DIVIDER / 2;

export const rowsContent = (p: Project, row: number) =>
  FIXED_HEIGHT + captionSpace(p) + (p.videoTracks.length + p.audioTracks.length) * (row + GAP);

/**
 * The vertical bar is a window onto a taller "world" whose middle is the video/audio divider, so a
 * centred thumb always puts that divider mid-view. It reaches both ends of the tracks and grows with
 * the row height so the thumb's length shows the row zoom.
 */
export function rowsWorld(p: Project, v: ViewState, row = v.rowHeight): number {
  const vis = rowsVisible(v);
  const above = rowsAbove(p, row);
  return Math.max(vis, (vis * row) / ROW_MIN, 2 * above, 2 * (rowsContent(p, row) - above));
}

/** Fraction of the vertical bar the thumb covers (at a given row height). */
export const rowWindow = (p: Project, v: ViewState, row = v.rowHeight) => rowsVisible(v) / rowsWorld(p, v, row);
export const minScrollY = (p: Project, v: ViewState) => rowsAbove(p, v.rowHeight) - rowsWorld(p, v) / 2;
export const maxScrollY = (p: Project, v: ViewState) => rowsAbove(p, v.rowHeight) + rowsWorld(p, v) / 2 - rowsVisible(v);
export const centeredScrollY = (p: Project, v: ViewState) => rowsAbove(p, v.rowHeight) - rowsVisible(v) / 2;

/**
 * A content y split into fixed-height space above it (zones, gaps, divider) and how many rows' worth
 * lie above it, so the same point is found again at another row height: `fixed + rows × rowHeight`.
 * (Editroom ignores the caption row here; kept identical.)
 */
export function rowAnchor(p: Project, row: number, y: number): { fixed: number; rows: number } {
  const segments: [number, boolean][] = [[ZONE, false]];
  for (let i = 0; i < p.videoTracks.length; i++) segments.push([row, true], [GAP, false]);
  segments.push([DIVIDER, false]);
  for (let i = 0; i < p.audioTracks.length; i++) segments.push([row, true], [GAP, false]);
  segments.push([ZONE, false]);
  let fixed = Math.min(0, y), rows = 0, pos = 0;
  for (const [length, isRow] of segments) {
    const take = Math.min(Math.max(y - pos, 0), length);
    if (isRow) rows += take / row; else fixed += take;
    pos += length;
  }
  fixed += Math.max(0, y - pos);
  return { fixed, rows };
}

/** The one clamp: row height first (integer 30…110), then zoom, then both scrolls. */
export function clampView(p: Project, v: ViewState, ask: Partial<ViewState> = {}): ViewState {
  const out: ViewState = { ...v };
  if (ask.viewWidth !== undefined) out.viewWidth = ask.viewWidth;
  if (ask.viewHeight !== undefined) out.viewHeight = ask.viewHeight;
  if (ask.rowHeight !== undefined) out.rowHeight = Math.min(ROW_MAX, Math.max(ROW_MIN, Math.round(ask.rowHeight)));
  out.pps = Math.min(MAX_PPS, Math.max(minPPS(p, out), ask.pps ?? out.pps));
  out.scrollX = Math.min(Math.max(0, ask.scrollX ?? out.scrollX), maxScrollX(p, out));
  out.scrollY = Math.min(Math.max(minScrollY(p, out), ask.scrollY ?? out.scrollY), maxScrollY(p, out));
  return out;
}

export const sameView = (a: ViewState, b: ViewState) =>
  a.pps === b.pps && a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.rowHeight === b.rowHeight
  && a.viewWidth === b.viewWidth && a.viewHeight === b.viewHeight;

/** Zooms around the playhead: it keeps its screen x, or comes to the centre if it was off screen. */
export function zoomAround(p: Project, v: ViewState, playhead: number, newPPS: number): ViewState {
  const pps = Math.min(MAX_PPS, Math.max(minPPS(p, v), newPPS));
  if (Math.abs(pps - v.pps) <= 1e-9) return v;
  const px = playhead * v.pps - v.scrollX;
  const anchor = px >= 0 && px <= v.viewWidth ? px : v.viewWidth / 2;
  return clampView(p, v, { pps, scrollX: playhead * pps - anchor });
}

export const zoomFit = (p: Project, v: ViewState): ViewState =>
  clampView(p, v, { pps: (v.viewWidth - 80) / Math.max(projectDuration(p), 1), scrollX: 0 });

/**
 * How a timeline opens: rows as tall as fit with every track and both add-track zones in view (no
 * taller than 62), centred; when they can't all fit, the tracks start at the top. The headers run on
 * beside the horizontal bar, so that bar's thickness counts as room.
 */
export function fitRows(p: Project, v: ViewState): ViewState {
  const visible = rowsVisible(v) + BAR;
  const tracks = Math.max(1, p.videoTracks.length + p.audioTracks.length);
  const room = visible - FIXED_HEIGHT - captionSpace(p) - 6;
  const sized = clampView(p, v, { rowHeight: Math.min(62, room / tracks - GAP) });
  const content = rowsContent(p, sized.rowHeight);
  return clampView(p, sized, { scrollY: content <= visible ? (content - visible) / 2 : 0 });
}

/** Wheel / trackpad zoom factor for a vertical delta in Editroom's sign (positive = scrolled up). */
export const wheelZoomFactor = (dy: number) => Math.exp(dy * 0.012);

// ---- Scroll bars with grips ----

/**
 * Where a thumb's edges end up when one grip is dragged: the dragged edge follows the mouse, the
 * other mirrors it by `mirror` (1 keeps the middle fixed, 0 keeps the other edge fixed). An edge at
 * the end of the bar stays there; length stays within [minLength, maxLength] (binary search).
 * `part` 0 = start grip, 2 = end grip; `move` is the mouse travel since the drag began.
 */
export function gripDrag(
  part: number, a0: number, b0: number, move: number, bar: number,
  minLength: number, maxLength: number, mirror = 1,
): { start: number; end: number } {
  let grow = part === 2 ? move : -move;
  grow = Math.min(grow, part === 2 ? bar - b0 : a0);
  const edges = (g: number) =>
    part === 2 ? { start: Math.max(0, a0 - g * mirror), end: b0 + g } : { start: a0 - g, end: Math.min(bar, b0 + g * mirror) };
  const fits = (g: number) => {
    const e = edges(g);
    return e.end - e.start >= minLength - 0.0001 && e.end - e.start <= maxLength + 0.0001;
  };
  if (!fits(grow)) {
    // Length only grows with `grow`, so close in on the limit from the starting size.
    let ok = 0, bad = grow;
    for (let i = 0; i < 40; i++) {
      const mid = (ok + bad) / 2;
      if (fits(mid)) ok = mid; else bad = mid;
    }
    grow = ok;
  }
  return edges(grow);
}

/** Which part of a thumb a bar position is on: 0 start grip, 1 body, 2 end grip, undefined = off it. */
export function barPart(pos: number, thumb: number, length: number): 0 | 1 | 2 | undefined {
  if (pos < thumb - 2 || pos > thumb + length + 2) return undefined;
  const grip = Math.min(HANDLE + 3, length / 3);
  if (pos < thumb + grip) return 0;
  if (pos > thumb + length - grip) return 2;
  return 1;
}

/** How far the far edge moves per point of a dragged grip so the playhead holds its screen place. */
export function gripMirror(part: number, playheadFraction: number): number {
  const t = playheadFraction;
  if (part === 2 && t >= 0 && t <= 0.5) return t / (1 - t);
  if (part === 0 && t >= 0.5 && t <= 1) return (1 - t) / t;
  return 1;
}
