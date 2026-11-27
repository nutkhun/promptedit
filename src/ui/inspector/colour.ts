// Colour conversions for the colour well. Model colours are sRGB components 0…1 (RGBA); the
// picker works in HSV. Opacity is never offered (docs/spec/04-ui.md §1.5): alpha passes through.

import type { RGBA } from "../../model";

export interface HSV { h: number; s: number; v: number }

const byte = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);

export const cssColor = (c: RGBA) => `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})`;

export function toHex(c: RGBA): string {
  return "#" + [c.r, c.g, c.b].map((x) => byte(x).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** "#RGB", "RRGGBB" or "#RRGGBB"; undefined when it isn't a colour. */
export function fromHex(text: string, alpha = 1): RGBA | undefined {
  let h = text.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((x) => x + x).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return undefined;
  const n = parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: alpha };
}

export function toHSV(c: RGBA): HSV {
  const r = c.r, g = c.g, b = c.b;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function fromHSV({ h, s, v }: HSV, alpha = 1): RGBA {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5), g: f(3), b: f(1), a: alpha };
}

export const sameColour = (a: RGBA, b: RGBA) =>
  byte(a.r) === byte(b.r) && byte(a.g) === byte(b.g) && byte(a.b) === byte(b.b);
