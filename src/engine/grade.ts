// Colour grading, ported from Editroom's Model/ColorGrade.swift (docs/spec/02-engine.md §3).
// A clip's whole grade (look blended by intensity, then the user's adjustments) is baked into one
// 32³ cube that the compositor samples per pixel, identically for the viewer and export.
// All maths runs on Rec.709 gamma-encoded values in 0…1; nothing here is colour managed.

import type { ColorGrade, WheelPoint } from "../model";

export type RGB = [number, number, number];

export const CUBE_SIZE = 32;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const each = (c: RGB, f: (x: number) => number): RGB => [f(c[0]), f(c[1]), f(c[2])];
/** Swift's `truncatingRemainder` (C fmod): the sign follows the dividend, like JS `%`. */
const fmod = (a: number, b: number) => a % b;

/** RGB offset a colour wheel position adds before tonal weighting (§3.2). */
export function wheelOffset(p: WheelPoint): RGB {
  const m = Math.min(1, Math.sqrt(p.x * p.x + p.y * p.y)) * 0.22;
  if (!(m > 0)) return [0, 0, 0];
  const a = Math.atan2(p.y, p.x);
  const third = (2 * Math.PI) / 3;
  return [Math.cos(a) * m, Math.cos(a - third) * m, Math.cos(a + third) * m];
}

/** The primitive steps every simple look and every user grade is made of (`GradeRecipe`). */
export interface GradeRecipe {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  shadows?: RGB;
  midtones?: RGB;
  highlights?: RGB;
  lift?: RGB;
  fade?: number;
  /** A look with its own maths (LookMath), used instead of the steps above. */
  custom?: (c: RGB) => RGB;
}

const ZERO: RGB = [0, 0, 0];

/** `GradeRecipe.apply` (§3.3): no clamping between steps; the bake clamps at the end. */
export function applyRecipe(recipe: GradeRecipe, rgb: RGB): RGB {
  if (recipe.custom) return recipe.custom(rgb);
  let [r, g, b] = rgb;
  const gain = Math.pow(2, recipe.exposure ?? 0);
  r *= gain; g *= gain; b *= gain;
  const t = ((recipe.temperature ?? 0) / 50) * 0.12, ti = ((recipe.tint ?? 0) / 50) * 0.1;
  r += t; b -= t; g -= ti;
  const l = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const sh = 1 - l, mid = 4 * l * (1 - l);
  const S = recipe.shadows ?? ZERO, M = recipe.midtones ?? ZERO, H = recipe.highlights ?? ZERO, L = recipe.lift ?? ZERO;
  r += S[0] * sh + M[0] * mid + H[0] * l + L[0];
  g += S[1] * sh + M[1] * mid + H[1] * l + L[1];
  b += S[2] * sh + M[2] * mid + H[2] * l + L[2];
  const k = 1 + ((recipe.contrast ?? 0) / 50) * 0.6;
  r = (r - 0.5) * k + 0.5; g = (g - 0.5) * k + 0.5; b = (b - 0.5) * k + 0.5;
  const fade = recipe.fade ?? 0;
  if (fade !== 0) {
    r = r * (1 - fade) + fade; g = g * (1 - fade) + fade; b = b * (1 - fade) + fade;
  }
  const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = 1 + (recipe.saturation ?? 0) / 100;
  return [l2 + (r - l2) * s, l2 + (g - l2) * s, l2 + (b - l2) * s];
}

// ---- LookMath (looks that need more than the recipe steps) ----

/** Positive adds an S-curve; negative flattens. */
function contrast(c: RGB, k: number): RGB {
  return each(c, (x0) => {
    const x = clamp01(x0), s = x * x * (3 - 2 * x);
    return clamp01(x + k * (s - x) * 2);
  });
}
const fadeTo = (c: RGB, f: number): RGB => each(c, (x) => f + (1 - f) * x);
function saturate(c: RGB, s: number): RGB {
  const l = luma(c);
  return each(c, (x) => clamp01(l + s * (x - l)));
}
const add = (c: RGB, t: RGB, w = 1): RGB => [clamp01(c[0] + t[0] * w), clamp01(c[1] + t[1] * w), clamp01(c[2] + t[2] * w)];
/** Tints that land mostly in the shadows and mostly in the highlights. */
function split(c: RGB, shadows: RGB, highlights: RGB): RGB {
  const l = clamp01(luma(c));
  return add(add(c, shadows, (1 - l) * (1 - l)), highlights, l * l);
}

function toHSV(c: RGB): [number, number, number] {
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === c[0]) h = 60 * fmod((c[1] - c[2]) / d, 6);
    else if (mx === c[1]) h = 60 * ((c[2] - c[0]) / d + 2);
    else h = 60 * ((c[0] - c[1]) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx > 0 ? d / mx : 0, mx];
}

function fromHSV(h: number, s: number, v: number): RGB {
  const c = v * s, x = c * (1 - Math.abs(fmod(h / 60, 2) - 1)), m = v - c;
  if (h < 60) return [c + m, x + m, m];
  if (h < 120) return [x + m, c + m, m];
  if (h < 180) return [m, c + m, x + m];
  if (h < 240) return [m, x + m, c + m];
  if (h < 300) return [x + m, m, c + m];
  return [c + m, m, x + m];
}

/** Shifts hue and scales saturation (and value) near `center`, fading out over `width` degrees. */
function hueBand(c: RGB, center: number, width: number, shift: number, sat: number, value = 1): RGB {
  let [h, s, v] = toHSV(c);
  let d = Math.abs(h - center);
  if (d > 180) d = 360 - d;
  if (!(d < width)) return c;
  const w = (0.5 + 0.5 * Math.cos((d / width) * Math.PI)) * Math.min(1, s * 2.5);
  h = fmod(h + shift * w + 360, 360);
  s = clamp01(s * (1 + (sat - 1) * w));
  v = clamp01(v * (1 + (value - 1) * w));
  return fromHSV(h, s, v);
}

const FILM_PRINT = [
  0.1260, 0.0872, 0.1130, 0.9273, 4.3723, 1.1754, -6.7912, 0.8993, -3.0058, 1.0943,
  -0.2338, -0.1982, -0.2908, -0.1016, -0.0275, -0.0710, 0.1846, 0.8248, 1.0324, 1.0304,
];

export const LookMath = {
  filmPrint(c0: RGB): RGB {
    const p = FILM_PRINT;
    let c = add(each(c0, clamp01), [p[0], p[1], p[2]]);
    c = each(c, (x) => Math.pow(clamp01(x), p[3]));
    c = hueBand(c, 28, 22, p[4], p[5]);
    c = hueBand(c, 110, 60, p[6], p[7]);
    c = hueBand(c, 210, 45, p[8], p[9]);
    c = split(c, [p[10], p[11], p[12]], [p[13], p[14], p[15]]);
    c = contrast(c, p[16]);
    c = saturate(c, p[17]);
    c = hueBand(c, 356, 20, 0, p[18], p[19]);
    return fadeTo(c, 0.035);
  },
  goldenHour(c0: RGB): RGB {
    let c = split(c0, [-0.012, 0, 0.03], [0.085, 0.04, -0.06]);
    c = contrast(c, 0.08);
    return saturate(c, 1.08);
  },
  bleachBypass(c0: RGB): RGB {
    let c = saturate(each(c0, clamp01), 0.42);
    c = contrast(c, 0.42);
    return add(c, [-0.01, 0, 0.008]);
  },
  pastel(c0: RGB): RGB {
    let c = each(c0, (x) => Math.pow(clamp01(x), 0.8));
    c = contrast(c, -0.36);
    c = fadeTo(c, 0.14);
    c = split(c, [0.03, 0, 0.05], [0.01, 0, 0.012]);
    return saturate(c, 0.8);
  },
};

/** The Looks offered in the menu, in order (§3.4). */
export const BUILT_IN_LOOKS: [string, GradeRecipe][] = [
  ["Warm film", { contrast: 8, saturation: -8, temperature: 18, lift: [0.02, 0, -0.02], fade: 0.03 }],
  ["Golden hour", { custom: LookMath.goldenHour }],
  ["Film print", { custom: LookMath.filmPrint }],
  ["Teal and orange", { contrast: 12, saturation: 10, shadows: [-0.05, 0.01, 0.05], highlights: [0.06, 0.01, -0.05] }],
  ["Pastel", { custom: LookMath.pastel }],
  ["Bleach bypass", { custom: LookMath.bleachBypass }],
  ["Mono", { contrast: 14, saturation: -100 }],
  ["Cool night", { exposure: -0.25, contrast: 6, saturation: -15, temperature: -22 }],
];
/** No longer offered, still read so old projects look the same. */
const RETIRED_LOOKS: [string, GradeRecipe][] = [["Faded", { contrast: -18, saturation: -20, fade: 0.07 }]];

export function builtInLook(name: string): GradeRecipe | undefined {
  return (BUILT_IN_LOOKS.find(([n]) => n === name) ?? RETIRED_LOOKS.find(([n]) => n === name))?.[1];
}

/** The look's label: a built-in name, or a .cube file's base name. */
export function lookLabel(look?: string): string {
  if (look == null) return "None";
  if (builtInLook(look)) return look;
  const base = look.split(/[\\/]/).pop() ?? look;
  return base.replace(/\.[^.]*$/, "");
}

// ---- .cube files (§3.6) ----

export interface CubeLUT { size: number; values: Float32Array }

/** Parses an Adobe/Resolve 3D .cube file exactly as Editroom does (space-separated only). */
export function parseCube(text: string): CubeLUT | undefined {
  let size = 0;
  const values: number[] = [];
  const num = (s: string) => (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(inf|nan)$/i.test(s) ? Number(s) : NaN);
  for (const raw of text.split(/\r\n|\r|\n/)) {
    // Swift trims `.whitespaces` (spaces and tabs) but splits on spaces only.
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(" ").filter((p) => p.length > 0);
    if (parts[0] === "LUT_3D_SIZE" && parts.length > 1) {
      size = /^[+-]?\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 0;
    } else if (parts.length === 3) {
      const r = num(parts[0]), g = num(parts[1]), b = num(parts[2]);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) values.push(r, g, b);
    }
  }
  if (!(size >= 2 && size <= 256 && values.length === size * size * size * 3)) return undefined;
  return { size, values: Float32Array.from(values) };
}

/** Trilinear lookup, input clamped to 0…1, red fastest. */
export function sampleCube(lut: CubeLUT, rgb: RGB): RGB {
  const n = lut.size - 1, size = lut.size, v = lut.values;
  const sp = (x: number): [number, number, number] => {
    const p = clamp01(x) * n;
    const i = Math.min(size - 2, Math.floor(p));
    return [i, i + 1, p - i];
  };
  const [r0, r1, fr] = sp(rgb[0]), [g0, g1, fg] = sp(rgb[1]), [b0, b1, fb] = sp(rgb[2]);
  const at = (r: number, g: number, b: number, c: number) => v[((b * size + g) * size + r) * 3 + c];
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - fr) + at(r1, g0, b0, c) * fr;
    const c10 = at(r0, g1, b0, c) * (1 - fr) + at(r1, g1, b0, c) * fr;
    const c01 = at(r0, g0, b1, c) * (1 - fr) + at(r1, g0, b1, c) * fr;
    const c11 = at(r0, g1, b1, c) * (1 - fr) + at(r1, g1, b1, c) * fr;
    out[c] = (c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb;
  }
  return out;
}

// ---- Baking (§3.5) ----

const NEUTRAL: ColorGrade = {
  lookIntensity: 1, exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
  shadows: { x: 0, y: 0 }, midtones: { x: 0, y: 0 }, highlights: { x: 0, y: 0 },
};

/** No look and every adjustment at zero (intensity doesn't count without a look). */
export function isNeutral(g: ColorGrade): boolean {
  const w = (a: WheelPoint, b: WheelPoint) => a.x === b.x && a.y === b.y;
  return g.look == null && g.exposure === NEUTRAL.exposure && g.contrast === 0 && g.saturation === 0 &&
    g.temperature === 0 && g.tint === 0 && w(g.shadows, NEUTRAL.shadows) && w(g.midtones, NEUTRAL.midtones) &&
    w(g.highlights, NEUTRAL.highlights);
}

export function gradeKey(g: ColorGrade): string {
  return JSON.stringify([g.look ?? null, g.lookIntensity, g.exposure, g.contrast, g.saturation, g.temperature, g.tint,
    g.shadows.x, g.shadows.y, g.midtones.x, g.midtones.y, g.highlights.x, g.highlights.y]);
}

/** The user grade as a recipe (wheel points become RGB offsets). */
export function userRecipe(g: ColorGrade): GradeRecipe {
  return {
    exposure: g.exposure, contrast: g.contrast, saturation: g.saturation, temperature: g.temperature, tint: g.tint,
    shadows: wheelOffset(g.shadows), midtones: wheelOffset(g.midtones), highlights: wheelOffset(g.highlights),
  };
}

/** Grade at one colour, exactly as one lattice point of the bake (before the final clamp). */
export function gradeColor(g: ColorGrade, c0: RGB, lookFile?: CubeLUT): RGB {
  let c = c0;
  const mix = clamp01(g.lookIntensity);
  const recipe = g.look != null ? builtInLook(g.look) : undefined;
  const file = recipe ? undefined : lookFile;
  if (mix > 0 && (recipe || file)) {
    const looked = recipe ? applyRecipe(recipe, c) : sampleCube(file!, c);
    c = [c[0] + (looked[0] - c[0]) * mix, c[1] + (looked[1] - c[1]) * mix, c[2] + (looked[2] - c[2]) * mix];
  }
  return applyRecipe(userRecipe(g), c);
}

/**
 * The 32³ RGBA float cube for a grade (red fastest, alpha 1), or undefined when it changes nothing.
 * `lookFile` is the parsed .cube when `look` is a file path (built-in names take priority).
 */
export function bakeCube(g: ColorGrade | undefined, lookFile?: CubeLUT): Float32Array | undefined {
  if (!g || isNeutral(g)) return undefined;
  const n = CUBE_SIZE;
  const data = new Float32Array(n * n * n * 4);
  let i = 0;
  for (let b = 0; b < n; b++) {
    for (let gg = 0; gg < n; gg++) {
      for (let r = 0; r < n; r++) {
        const c = gradeColor(g, [r / (n - 1), gg / (n - 1), b / (n - 1)], lookFile);
        data[i] = clamp01(c[0]);
        data[i + 1] = clamp01(c[1]);
        data[i + 2] = clamp01(c[2]);
        data[i + 3] = 1;
        i += 4;
      }
    }
  }
  return data;
}

/** Bakes with a cache by grade value (cleared at > 200, as Editroom). .cube files load through `loadCube`. */
export class GradeBaker {
  private cubes = new Map<string, Float32Array | undefined>();
  private files = new Map<string, Promise<CubeLUT | undefined>>();
  private loaded = new Map<string, CubeLUT | undefined>();

  constructor(private fetchText: (path: string) => Promise<string>) {}

  /** The cube now, if it can be made without waiting (a .cube file still loading returns undefined and loads). */
  cube(g: ColorGrade | undefined, onReady?: () => void): Float32Array | undefined {
    if (!g || isNeutral(g)) return undefined;
    const key = gradeKey(g);
    if (this.cubes.has(key)) return this.cubes.get(key);
    let file: CubeLUT | undefined;
    if (g.look != null && !builtInLook(g.look)) {
      if (!this.loaded.has(g.look)) {
        this.load(g.look).then(() => onReady?.());
        // Until the file is read, show the user grade alone.
        return bakeCube({ ...g, look: undefined }) ?? undefined;
      }
      file = this.loaded.get(g.look);
    }
    const data = bakeCube(g, file);
    if (this.cubes.size > 200) this.cubes.clear();
    this.cubes.set(key, data);
    return data;
  }

  /** Reads a .cube file once per session. */
  load(path: string): Promise<CubeLUT | undefined> {
    let p = this.files.get(path);
    if (!p) {
      p = this.fetchText(path).then(parseCube, () => undefined).then((lut) => {
        this.loaded.set(path, lut);
        return lut;
      });
      this.files.set(path, p);
    }
    return p;
  }
}
