// Source colour: HDR (HLG, PQ) and Apple Log pictures to Rec.709 (docs/spec/02-engine.md §3.7,
// Editroom/Engine/SourceColor.swift). Each kind gets one 64³ cube that turns the file's encoded
// R′G′B′ straight into encoded Rec.709: undo the file's curve, move its primaries into Rec.709,
// compress HDR into SDR with Editroom's fitted model of macOS's conversion, ease highlights above
// white down instead of clipping, and encode with the Rec.709 curve.
//
// The maths runs in f64 here and is baked once per kind; the compositor samples the cube after the
// fit (step 4 of §1.2), at output resolution, before the grade cube.

import type { Probe, SourceColorKind } from "../../model";

export type { SourceColorKind };

/** Lattice size of the conversion cube (Editroom: `SourceColor.dimension`). */
export const SOURCE_CUBE_SIZE = 64;

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];
type XY = [number, number];

const D65: XY = [0.3127, 0.329];
const REC709: [XY, XY, XY] = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]];
const REC2020: [XY, XY, XY] = [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]];
/** Apple Wide Gamut, from Apple's Apple Log 2 white paper (blue's y really is negative). */
const APPLE_WIDE_GAMUT: [XY, XY, XY] = [[0.725, 0.301], [0.221, 0.814], [0.068, -0.076]];

function inverse(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const r = (i: number, j: number) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return [[r(0, 0), r(0, 1), r(0, 2)], [r(1, 0), r(1, 1), r(1, 2)], [r(2, 0), r(2, 1), r(2, 2)]];
}

/** Linear RGB in primaries `p` (white D65) to CIE XYZ. */
function toXYZ(p: [XY, XY, XY]): Mat3 {
  const cols = p.map(([x, y]) => [x / y, 1, (1 - x - y) / y]);
  const m: Mat3 = [0, 1, 2].map((r) => [cols[0][r], cols[1][r], cols[2][r]]) as Mat3;
  const w: Vec3 = [D65[0] / D65[1], 1, (1 - D65[0] - D65[1]) / D65[1]];
  const inv = inverse(m);
  const s = [0, 1, 2].map((r) => inv[r][0] * w[0] + inv[r][1] * w[1] + inv[r][2] * w[2]);
  return m.map((row) => row.map((v, c) => v * s[c])) as Mat3;
}

/** Linear RGB in one set of primaries to another; both D65, so no white adaptation. */
function primariesMatrix(from: [XY, XY, XY], to: [XY, XY, XY]): Mat3 {
  return multiply(inverse(toXYZ(to)), toXYZ(from));
}

export const REC2020_TO_709: Mat3 = primariesMatrix(REC2020, REC709);
export const WIDE_GAMUT_TO_709: Mat3 = primariesMatrix(APPLE_WIDE_GAMUT, REC709);

// The fitted HDR→SDR model (Editroom: hdrGain, hdrPower, hdrLift, hdrKnee, hdrSaturation; knee).
const HDR_GAIN = 0.317;
const HDR_POWER = 0.88;
const HDR_LIFT = 0.0143;
const HDR_KNEE = 0.85;
const HDR_SATURATION = 0.88;
const KNEE = 0.9;

/** Inverse HLG; HLG puts diffuse white at 75 % (scene light 0.2647, BT.2408). No OOTF. */
export function hlgToLinear(v: number): number {
  const a = 0.17883277, b = 0.28466892, c = 0.55991073;
  const e = v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
  return e / 0.2647;
}

/** PQ to light with 203 nits as white (BT.2408). */
export function pqToLinear(v: number): number {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const p = Math.pow(Math.max(0, v), 1 / m2);
  const y = Math.pow(Math.max(0, p - c1) / (c2 - c3 * p), 1 / m1);
  return (y * 10000) / 203;
}

const LOG = { R0: -0.05641088, Rt: 0.01, c: 47.28711236, b: 0.00964052, g: 0.08550479, be: 0.69336945 };
const LOG_PT = LOG.c * (LOG.Rt - LOG.R0) * (LOG.Rt - LOG.R0);

/** Apple Log (and Log 2, same curve) to scene light, 18 % grey = 0.18 (Apple's published curve). */
export function appleLogToLinear(v: number): number {
  if (v >= LOG_PT) return Math.pow(2, (v - LOG.be) / LOG.g) - LOG.b;
  if (v > 0) return Math.sqrt(v / LOG.c) + LOG.R0;
  return LOG.R0;
}

/** Apple Log's forward curve (scene light → code), for test pictures and checks. */
export function linearToAppleLog(r: number): number {
  if (r >= LOG.Rt) return LOG.g * Math.log2(r + LOG.b) + LOG.be;
  if (r >= LOG.R0) return LOG.c * (r - LOG.R0) * (r - LOG.R0);
  return 0;
}

/** The Rec.709 OETF, clamped (Editroom `SourceColor.rec709`). */
export function rec709OETF(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  return v < 0.018 ? 4.5 * v : 1.099 * Math.pow(v, 0.45) - 0.099;
}

function decoder(kind: SourceColorKind): (v: number) => number {
  switch (kind) {
    case "hlg": return hlgToLinear;
    case "pq": return pqToLinear;
    case "appleLog":
    case "appleLog2": return appleLogToLinear;
    default: return (v) => v;
  }
}

/** One encoded colour of `kind` to encoded Rec.709, with diffuse white (not peak) at 1. */
export function convertToRec709(kind: SourceColorKind, r: number, g: number, b: number): Vec3 {
  const decode = decoder(kind);
  const lin = [decode(r), decode(g), decode(b)];
  const m = kind === "appleLog2" ? WIDE_GAMUT_TO_709 : REC2020_TO_709;
  let c = m.map((row) => Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
  const hdr = kind === "hlg" || kind === "pq";
  if (hdr) {
    const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (y > 1e-6) {
      const target = HDR_GAIN * Math.pow(y, HDR_POWER) + HDR_LIFT * Math.min(1, y / 0.02);
      const scale = target / y;
      const grey = y * scale;
      // Darkened, colours read richer; eased 12 % toward grey as macOS's conversion is.
      c = c.map((v) => grey + (v * scale - grey) * HDR_SATURATION);
    }
  }
  // Brighter than white rolls off instead of clipping; one scale for all three keeps the hue.
  const k = hdr ? HDR_KNEE : KNEE;
  const peak = Math.max(c[0], c[1], c[2]);
  if (peak > k) {
    const eased = k + (1 - k) * (1 - Math.exp(-(peak - k) / (1 - k)));
    c = c.map((v) => (v * eased) / peak);
  }
  return [rec709OETF(c[0]), rec709OETF(c[1]), rec709OETF(c[2])];
}

const cubes = new Map<SourceColorKind, Float32Array>();

/**
 * The kind's 64³ RGBA cube (red fastest, alpha 1), or undefined for standard pictures, which are
 * drawn as they are. Built once per kind.
 */
export function sourceCube(kind: SourceColorKind): Float32Array | undefined {
  if (kind === "standard") return undefined;
  const hit = cubes.get(kind);
  if (hit) return hit;
  const n = SOURCE_CUBE_SIZE;
  const out = new Float32Array(n * n * n * 4);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const c = convertToRec709(kind, r / (n - 1), g / (n - 1), b / (n - 1));
        const i = ((b * n + g) * n + r) * 4;
        out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 1;
      }
    }
  }
  cubes.set(kind, out);
  return out;
}

/**
 * How a file's picture is encoded (Editroom `SourceColor.of`): Apple Log is found by the backend in
 * the file's sample description (`probe.sourceColor`); HLG and PQ by ffprobe's transfer.
 */
export function sourceColorOf(probe: Pick<Probe, "sourceColor" | "colorTransfer"> | undefined): SourceColorKind {
  if (!probe) return "standard";
  if (probe.sourceColor && probe.sourceColor !== "standard") return probe.sourceColor;
  if (probe.colorTransfer === "arib-std-b67") return "hlg";
  if (probe.colorTransfer === "smpte2084") return "pq";
  return "standard";
}

/** Y′CbCr → R′G′B′ coefficients (Kr, Kb) for the file's matrix. */
export function yuvCoefficients(matrix: string | undefined, kind: SourceColorKind): [number, number] {
  switch (matrix) {
    case "bt709": return [0.2126, 0.0722];
    case "bt2020nc": case "bt2020c": case "bt2020-ncl": return [0.2627, 0.0593];
    case "smpte170m": case "bt470bg": case "bt601": case "fcc": return [0.299, 0.114];
    case "smpte240m": return [0.212, 0.087];
    // Untagged: what the kind is recorded in (iPhone HDR and Log are BT.2020 NCL).
    default: return kind === "standard" ? [0.2126, 0.0722] : [0.2627, 0.0593];
  }
}
