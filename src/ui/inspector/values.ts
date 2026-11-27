// Pure number handling behind the inspector's controls: reading typed values, arrow-key steps,
// slider mappings (linear and logarithmic) and the display formats (docs/spec/04-ui.md §1.5,
// Editroom's InspectorView.swift `ParamRow`). Kept free of React so it can be unit tested.

export type Range = readonly [number, number];

export const clampTo = (v: number, [lo, hi]: Range) => Math.min(hi, Math.max(lo, v));

/**
 * Reads the number out of whatever is in a value field: "100%", "0.50s", "−18.8 dB", "1,5".
 * A comma counts as a decimal point and U+2212 as a minus; every other non-numeric character is
 * dropped (like Editroom, which filters to `0123456789.-` and hands the rest to `Double()`).
 */
export function parseNumber(text: string): number | undefined {
  const cleaned = text.replace(/,/g, ".").replace(/−/g, "-").replace(/[^0-9.-]/g, "");
  // What Swift's Double() accepts after the filter: an optional leading minus, digits with at
  // most one point, at least one digit.
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return undefined;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * The value a field should apply when editing ends, or undefined to leave things as they are
 * (the text is unchanged from what the field shows, or isn't a number). Clamped to the range.
 */
export function committedValue(text: string, shown: string, range: Range): number | undefined {
  if (text === shown) return undefined;
  const v = parseNumber(text);
  return v === undefined ? undefined : clampTo(v, range);
}

/**
 * ↑/↓ in a value field: to the next whole step up or down from what's typed (or the value, if
 * nothing readable is typed), so 0.47 goes to 0.5 rather than 0.57. The step is the row's own,
 * else 1 when the field shows a whole number and 0.1 when it shows decimals; Shift makes it ×10.
 */
export function nudgedValue(opts: {
  text: string;
  value: number;
  shown: string;
  step?: number;
  up: boolean;
  big: boolean;
  range: Range;
}): number {
  const start = parseNumber(opts.text) ?? opts.value;
  const step = (opts.step ?? (opts.shown.includes(".") ? 0.1 : 1)) * (opts.big ? 10 : 1);
  // Round the quotient first so float noise (0.3 / 0.1 = 2.9999…) doesn't land on the same step.
  const q = Math.round((start / step) * 1e9) / 1e9;
  const n = opts.up ? Math.floor(q) + 1 : Math.ceil(q) - 1;
  return clampTo(Math.round(n * step * 1e6) / 1e6, opts.range);
}

/** Slider position (0…1) for a value; logarithmic rows spread each octave evenly. */
export function toNormal(value: number, [lo, hi]: Range, log = false): number {
  const v = Math.min(hi, Math.max(lo, value));
  if (hi <= lo) return 0;
  if (log) return (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return (v - lo) / (hi - lo);
}

/** The value at a slider position (0…1). */
export function fromNormal(n: number, [lo, hi]: Range, log = false): number {
  const k = Math.min(1, Math.max(0, n));
  if (log) return Math.exp(Math.log(lo) + k * (Math.log(hi) - Math.log(lo)));
  return lo + k * (hi - lo);
}

// ---- Display formats (as Editroom writes them) ----

/** A whole number ("12"). */
export const whole = (v: number) => String(Math.round(v) + 0);
/** A whole percentage ("100%"). */
export const percent = (v: number) => `${whole(v)}%`;
/** A number to a tenth ("12.5"), whole numbers without the ".0" ("12"). */
export function tenths(v: number): string {
  const t = Math.round(v * 10) / 10 + 0;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}
/** A percentage to a tenth ("95.3%", "100%"). */
export const percentTenths = (v: number) => `${tenths(v)}%`;
/** Seconds to two decimals ("0.50s"). */
export const seconds = (v: number) => `${(Math.round(v * 100) / 100 + 0).toFixed(2)}s`;
/** Signed, two decimals ("+0.00", "-0.50"), like `%+.2f`. */
export function signed2(v: number): string {
  const s = (Math.round(v * 100) / 100 + 0).toFixed(2);
  return v >= 0 || s === "0.00" || s === "-0.00" ? `+${s.replace("-", "")}` : s;
}

/** A frame rate's label: "30 fps", "29.97 fps". */
export function fpsLabel(fps: number): string {
  return (Math.abs(fps - Math.round(fps)) < 0.001 ? String(Math.round(fps)) : fps.toFixed(2)) + " fps";
}

/** A clip length under a graph: "4.5s" under 10 s, "12s" under a minute, then m:ss. */
export function lengthLabel(s: number): string {
  if (s < 60) return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  const secs = Math.round(Math.max(0, s));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, sec = secs % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ---- Sequence frame size ----

/** Typed width or height: digits only, made even (encoders need it) and kept to 16…8192. */
export function frameDimension(text: string): number | undefined {
  const digits = text.replace(/\D/g, "");
  if (!digits) return undefined;
  const n = parseInt(digits, 10);
  return Math.min(8192, Math.max(16, Math.trunc(n / 2) * 2));
}

/** ↑/↓ on a frame-size field: two pixels (twenty with Shift), staying even. */
export function steppedDimension(text: string, fallback: number, up: boolean, big: boolean): number {
  const digits = text.replace(/\D/g, "");
  const was = digits ? parseInt(digits, 10) : fallback;
  return Math.max(16, Math.min(8192, Math.trunc(was / 2) * 2 + (up ? 2 : -2) * (big ? 10 : 1)));
}

// ---- Colour wheels ----

/** Puck travel on a 78-point wheel: its radius less the ring and the puck. */
export const WHEEL_REACH = 78 / 2 - 8;

/**
 * Where a pointer at (dx, dy) points from a wheel's centre puts the puck: inside the unit disc,
 * in 0.01 steps, with a 0.06 dead zone around neutral so it's easy to get back to exactly 0.
 */
export function wheelPoint(dx: number, dy: number): { x: number; y: number } {
  let x = dx / WHEEL_REACH, y = dy / WHEEL_REACH;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  if (m < 0.06) { x = 0; y = 0; }
  return { x: Math.round(x * 100) / 100 + 0, y: Math.round(y * 100) / 100 + 0 };
}
