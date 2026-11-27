// Captions on the picture (Editroom CaptionRenderer, docs/spec/02-engine.md §9.3): each caption split
// by word when the word being said lights up, drawn in heavy type centred across the output frame at
// the style's height, with a dark round-joined outline. Drawn in the *output* frame (after any crop to
// another shape), so captions stay whole and in place on a vertical export of a wide sequence.

import type { CaptionStyle, RGBA } from "../model";
import type { CaptionBlock } from "./layout";

/** One caption as it's drawn: its words, which one is lit (the one being said), and when. */
export interface CaptionLayer {
  start: number;
  end: number;
  words: string[];
  lit?: number;
  style: CaptionStyle;
}

/** Each caption, split by word when the word being said lights up. */
export function captionLayers(blocks: CaptionBlock[], style: CaptionStyle): CaptionLayer[] {
  const out: CaptionLayer[] = [];
  for (const b of blocks) {
    const words = b.words.map((w) => w.text);
    if (!style.highlight || words.length <= 1) {
      out.push({ start: b.start, end: b.end, words, lit: style.highlight ? 0 : undefined, style });
      continue;
    }
    b.words.forEach((w, i) => {
      const start = i === 0 ? b.start : w.start;
      const end = i + 1 < b.words.length ? b.words[i + 1].start : b.end;
      if (end > start) out.push({ start, end, words, lit: i, style });
    });
  }
  return out;
}

/** The layer showing at time t (layers are evaluated just after the frame time, like clips). */
export const layerAt = (layers: CaptionLayer[], t: number) => layers.find((l) => t >= l.start && t < l.end);

export interface CaptionImage {
  canvas: OffscreenCanvas;
  /** Placement in the output frame (pixels, y down). */
  x: number;
  y: number;
  width: number;
  height: number;
}

// The system's heaviest UI face (SF Pro Heavy on macOS, Segoe UI Black/Bold on Windows).
const FONT_FAMILY = 'system-ui, -apple-system, "SF Pro Display", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
export const captionFont = (pt: number) => `800 ${pt}px ${FONT_FAMILY}`;
const css = (c: RGBA) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;

/** Word-wrapped lines (AppKit by-word wrapping): each line is a range of words. */
export function wrapWords(widths: number[], space: number, maxWidth: number): [number, number][] {
  const lines: [number, number][] = [];
  let from = 0, w = 0;
  widths.forEach((ww, i) => {
    if (i === from) { w = ww; return; }
    if (w + space + ww <= maxWidth) { w += space + ww; return; }
    lines.push([from, i]);
    from = i;
    w = ww;
  });
  if (widths.length) lines.push([from, widths.length]);
  return lines;
}

interface Drawn { canvas: OffscreenCanvas; width: number; height: number }
const cache = new Map<string, Drawn | null>();

/** The caption drawn for an output frame of W×H (cached by words, lit word, look and size; cleared past 400). */
function draw(words: string[], lit: number | undefined, style: CaptionStyle, W: number, H: number): Drawn | null {
  const key = JSON.stringify([words, lit ?? -1, { ...style, y: 0 }, Math.round(W), Math.round(H)]);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pt = captionPointSize(style.size, W, H);
  const scratch = new OffscreenCanvas(1, 1).getContext("2d")!;
  scratch.font = captionFont(pt);
  const widths = words.map((w) => scratch.measureText(w).width);
  // A little wider than a plain space: the outline eats into the gap.
  const space = scratch.measureText(" ").width + pt * 0.06;
  const lines = wrapWords(widths, space, W * 0.86);
  const m = scratch.measureText("Hg");
  const ascent = m.fontBoundingBoxAscent ?? pt * 0.95;
  const descent = m.fontBoundingBoxDescent ?? pt * 0.25;
  const lineHeight = ascent + descent;
  const lineWidth = ([a, b]: [number, number]) => widths.slice(a, b).reduce((x, y) => x + y, 0) + space * (b - a - 1);
  const tw = Math.ceil(Math.max(0, ...lines.map(lineWidth))), th = Math.ceil(lines.length * lineHeight);
  const pad = Math.ceil(pt * 0.3);
  const w = tw + pad * 2, h = th + pad * 2;
  let result: Drawn | null = null;
  if (words.length && w > 0 && h > 0 && w < 16384 && h < 16384) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.font = captionFont(pt);
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    // AppKit strokeWidth +22: a stroke 22 % of the point size, centred on the glyph outline.
    ctx.lineWidth = pt * 0.22;
    ctx.strokeStyle = css(style.outlineColor);
    const place = (pass: (word: string, x: number, y: number, i: number) => void) => {
      lines.forEach((line, li) => {
        let x = pad + (tw - lineWidth(line)) / 2;
        const y = pad + li * lineHeight + ascent;
        for (let i = line[0]; i < line[1]; i++) {
          pass(words[i], x, y, i);
          x += widths[i] + space;
        }
      });
    };
    if (style.outline) place((word, x, y) => ctx.strokeText(word, x, y));
    place((word, x, y, i) => {
      ctx.fillStyle = css(i === lit ? style.highlightColor : style.textColor);
      ctx.fillText(word, x, y);
    });
    result = { canvas, width: w, height: h };
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, result);
  return result;
}

/** The caption's point size on an output frame of W×H: `size` is relative to a 1080 px shorter side. */
export const captionPointSize = (size: number, W: number, H: number) => (size * Math.min(W, H)) / 1080;

/**
 * Where a w×h caption bitmap goes on a W×H output frame (top-left, y down): centred across, its middle
 * at `y` down the frame, kept inside. Core Image places it y up as
 * `y0 = round(clamp((1 − y)·H − h/2, 0, H − h))`; flipped here.
 */
export function captionPlacement(W: number, H: number, w: number, h: number, y: number): { x: number; y: number } {
  const cy = (1 - y) * H;
  const y0 = Math.round(Math.min(Math.max(cy - h / 2, 0), H - h));
  return { x: Math.round((W - w) / 2), y: H - y0 - h };
}

/** The caption placed on an output frame of W×H: centred, its middle at the style's height, kept inside. */
export function captionImage(layer: CaptionLayer, W: number, H: number): CaptionImage | undefined {
  if (!layer.words.length || W <= 0 || H <= 0) return undefined;
  const d = draw(layer.words, layer.lit, layer.style, W, H);
  if (!d) return undefined;
  const at = captionPlacement(W, H, d.width, d.height, layer.style.y);
  return { canvas: d.canvas, x: at.x, y: at.y, width: d.width, height: d.height };
}
