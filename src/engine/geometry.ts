// Sizes and timing shared by the viewer and export (docs/spec/02-engine.md §0, §2.2).

import type { Project } from "../model";

export interface Size { width: number; height: number }

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Viewer render size: the sequence scaled so the long side is at most 1920, even (§0). */
export function previewSize(p: Pick<Project, "width" | "height">): Size {
  const s = Math.min(1, 1920 / Math.max(p.width, p.height));
  return { width: even(p.width * s), height: even(p.height * s) };
}

/** One frame as a fraction num/den seconds: integer rates exactly, NTSC rates as 1001/(n·1000) (§0). */
export function frameDuration(fps: number): { num: number; den: number } {
  const r = Math.round(fps);
  if (Math.abs(fps - r) < 0.001) return { num: 1, den: r };
  return { num: 1001, den: Math.round(fps * 1.001) * 1000 };
}

export const frameSeconds = (fps: number) => {
  const f = frameDuration(fps);
  return f.num / f.den;
};

/**
 * Where the sequence is laid out for an output of a different shape (§2.2): the canvas covers the
 * output, and the output is the window at `offset` (top-left, y down) centred on `center` (0…1).
 */
export function reframeCanvas(seq: Size, out: Size, center = { x: 0.5, y: 0.5 }): { canvas: Size; offset: { x: number; y: number } } {
  const pa = seq.width / seq.height, oa = out.width / out.height;
  if (Math.abs(pa - oa) <= 0.001) return { canvas: { ...out }, offset: { x: 0, y: 0 } };
  const canvas = pa > oa
    ? { width: Math.round(out.height * pa), height: out.height }
    : { width: out.width, height: Math.round(out.width / pa) };
  const ox = Math.min(Math.max(0, center.x * canvas.width - out.width / 2), canvas.width - out.width);
  const top = Math.min(Math.max(0, center.y * canvas.height - out.height / 2), canvas.height - out.height);
  return { canvas, offset: { x: ox, y: top } };
}

/** The largest rectangle of `aspect` that fits in `box`, centred (for letterboxing in the viewer). */
export function fitRect(box: Size, aspect: number): { x: number; y: number; width: number; height: number } {
  let w = box.width, h = w / aspect;
  if (h > box.height) { h = box.height; w = h * aspect; }
  return { x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h };
}
