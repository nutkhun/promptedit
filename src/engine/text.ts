// Text clips drawn to a bitmap the compositor places like a still (Editroom TextRenderer,
// docs/spec/02-engine.md §9.2): size relative to a 1080-tall canvas, centred lines wrapped at
// 94 % of the width, a quarter-point pad around, centre at (x, y) as fractions across/down.

import type { TextStyle } from "../model";

export interface TextImage {
  canvas: OffscreenCanvas;
  /** Placement in canvas pixels (y down). */
  x: number;
  y: number;
  width: number;
  height: number;
}

const SYSTEM = 'system-ui, -apple-system, "SF Pro Display", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

export function fontFor(style: TextStyle, pt: number): string {
  const family = style.fontName ? `"${style.fontName.replace(/"/g, "")}", ${SYSTEM}` : SYSTEM;
  return `${style.bold ? 700 : 400} ${pt}px ${family}`;
}

/** Greedy word wrapping (AppKit's default by-word wrapping; over-long words break by character). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r\n|\r|\n|\u2028/)) {
    let line = "";
    const place = (word: string) => {
      let rest = word;
      while (rest.length > 1 && measure(line + rest) > maxWidth) {
        let k = rest.length - 1;
        while (k > 1 && measure(line + rest.slice(0, k)) > maxWidth) k--;
        out.push(line + rest.slice(0, k));
        line = "";
        rest = rest.slice(k);
      }
      line += rest;
    };
    for (const tok of para.match(/\S+|\s+/g) ?? []) {
      // Spaces hang at the end of a line (they don't count toward its width).
      if (/^\s/.test(tok)) { line += tok; continue; }
      if (line.trim() === "") place(tok);
      else if (measure(line + tok) <= maxWidth) line += tok;
      else { out.push(line.trimEnd()); line = ""; place(tok); }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const cache = new Map<string, TextImage | null>();

/** The text clip's bitmap and placement for a canvas of W×H; null for empty text. Cached (cleared at > 64). */
export function textImage(style: TextStyle, W: number, H: number): TextImage | null {
  if (style.string === "") return null;
  const key = JSON.stringify([style, Math.round(W), Math.round(H)]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pt = (style.size * H) / 1080;
  const scratch = new OffscreenCanvas(1, 1).getContext("2d")!;
  scratch.font = fontFor(style, pt);
  const measure = (s: string) => scratch.measureText(s).width;
  const lines = wrapLines(style.string, W * 0.94, measure);
  const m = scratch.measureText("Hg");
  const ascent = m.fontBoundingBoxAscent ?? pt * 0.95;
  const descent = m.fontBoundingBoxDescent ?? pt * 0.25;
  const lineHeight = ascent + descent;
  const widths = lines.map(measure);
  const tw = Math.ceil(Math.max(0, ...widths)), th = Math.ceil(lines.length * lineHeight);
  const pad = Math.ceil(pt * 0.25);
  const w = tw + pad * 2, h = th + pad * 2;
  let result: TextImage | null = null;
  if (w > 0 && h > 0 && w < 16384 && h < 16384) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.font = fontFor(style, pt);
    const c = style.color;
    ctx.fillStyle = `rgba(${c.r * 255}, ${c.g * 255}, ${c.b * 255}, ${c.a})`;
    ctx.textBaseline = "alphabetic";
    lines.forEach((line, i) => {
      ctx.fillText(line, pad + (tw - widths[i]) / 2, pad + i * lineHeight + ascent);
    });
    // Core Image placement (y up): x0 = round(x*W - w/2), y0 = round((1-y)*H - h/2); here y runs down.
    const x0 = Math.round(style.x * W - w / 2);
    const y0 = Math.round((1 - style.y) * H - h / 2);
    result = { canvas, x: x0, y: H - y0 - h, width: w, height: h };
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, result);
  return result;
}
