// Theme colours for canvas drawing, read from the CSS tokens in theme.css. Re-read when the theme
// changes (data-theme attribute, or the OS appearance under "auto").

export interface Palette {
  bg: string;
  panel: string;
  lane: string;
  /** `bg` blended 40% toward `lane`: lanes of tracks that are off. */
  laneOff: string;
  video: string;
  audio: string;
  textClip: string;
  clipStroke: string;
  offline: string;
  hint: string;
  accent: string;
  text: string;
  textFaint: string;
  selection: string;
  /** ink(a) */
  ink: (a: number) => string;
  stroke: string;
  font: string;
  mono: string;
}

function parseHex(c: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** a blended toward b by fraction f (NSColor.blended). */
export function blend(a: string, b: string, f: number): string {
  const x = parseHex(a), y = parseHex(b);
  if (!x || !y) return a;
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

let cached: Palette | undefined;
const listeners = new Set<() => void>();

function read(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const inkRGB = v("--ink-rgb", "255,255,255");
  const strokeAlpha = parseFloat(v("--stroke-alpha", "0.085"));
  const bg = v("--bg", "#0A0A0A"), lane = v("--lane", "#0D0D0D");
  return {
    bg, panel: v("--panel", "#111111"), lane, laneOff: blend(bg, lane, 0.4),
    video: v("--video", "#1E1E1E"), audio: v("--audio", "#151515"), textClip: v("--text-clip", "#1B1B1B"),
    clipStroke: v("--clip-stroke", "#2C2C2C"), offline: v("--offline", "#5A1F1F"), hint: v("--hint", "#3E3E3C"),
    accent: v("--accent", "#FF4A1C"), text: v("--text", "#F2F2F0"), textFaint: v("--text-faint", "#5C5C59"),
    selection: v("--selection", "#FFFFFF"),
    ink: (a: number) => `rgba(${inkRGB},${a})`,
    stroke: `rgba(${inkRGB},${strokeAlpha})`,
    font: v("--font", "system-ui, sans-serif"),
    mono: v("--mono", "ui-monospace, monospace"),
  };
}

export function palette(): Palette {
  if (!cached) cached = read();
  return cached;
}

export function onPaletteChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function refresh() {
  cached = undefined;
  listeners.forEach((f) => f());
}

if (typeof window !== "undefined" && typeof MutationObserver !== "undefined") {
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", refresh);
}

/** Flat clip colours by type when filmstrips are off (Premiere style). */
export const FLAT: Record<string, string> = {
  video: "#3A5A80", image: "#3A5A80", audio: "#2F6A47", text: "#664675", solid: "#7A6428",
};
