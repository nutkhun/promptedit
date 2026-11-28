import { describe, expect, it } from "vitest";
import {
  appleLogToLinear, convertToRec709, hlgToLinear, linearToAppleLog, pqToLinear, REC2020_TO_709, rec709OETF,
  SOURCE_CUBE_SIZE, sourceColorOf, sourceCube, WIDE_GAMUT_TO_709, yuvCoefficients,
} from "./source-color";

/** Encoders for test values (BT.2100 HLG / PQ with reference white at 75 % / 203 nits). */
const hlgOETF = (light: number) => {
  const x = Math.max(0, light) * 0.2647;
  return x <= 1 / 12 ? Math.sqrt(3 * x) : 0.17883277 * Math.log(12 * x - 0.28466892) + 0.55991073;
};
const pqOETF = (light: number) => {
  const y = (Math.max(0, light) * 203) / 10000;
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const p = Math.pow(y, m1);
  return Math.pow((c1 + c2 * p) / (1 + c3 * p), m2);
};

/** The fitted HDR model on a grey of linear light `y` (§3.7), encoded. */
const hdrGrey = (y: number) => {
  let v = 0.317 * Math.pow(y, 0.88) + 0.0143 * Math.min(1, y / 0.02);
  if (v > 0.85) v = 0.85 + 0.15 * (1 - Math.exp(-(v - 0.85) / 0.15));
  return rec709OETF(v);
};

describe("primary matrices (spec §3.7, 6 dp)", () => {
  it("Rec.2020 → 709", () => {
    const want = [[1.660491, -0.587641, -0.07285], [-0.12455, 1.1329, -0.008349], [-0.018151, -0.100579, 1.11873]];
    REC2020_TO_709.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(want[i][j], 5)));
  });
  it("Apple Wide Gamut → 709", () => {
    const want = [[1.70728, -0.51902, -0.18826], [-0.125011, 1.314662, -0.189652], [-0.043624, -0.191214, 1.234839]];
    WIDE_GAMUT_TO_709.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(want[i][j], 5)));
  });
  it("keeps white white", () => {
    for (const m of [REC2020_TO_709, WIDE_GAMUT_TO_709]) for (const row of m) expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 9);
  });
});

describe("curves", () => {
  it("HLG: 75 % is reference white, 50 % is the curve's knee", () => {
    expect(hlgToLinear(0.75)).toBeCloseTo(1.001, 3);
    expect(hlgToLinear(0.5)).toBeCloseTo(1 / 12 / 0.2647, 9);
    expect(hlgToLinear(0)).toBe(0);
    for (const l of [0.01, 0.18, 0.5, 1, 3]) expect(hlgToLinear(hlgOETF(l))).toBeCloseTo(l, 6);
  });
  it("PQ: 203 nits is white, 10 000 nits is code 1", () => {
    expect(pqToLinear(pqOETF(1))).toBeCloseTo(1, 6);
    expect(pqToLinear(1)).toBeCloseTo(10000 / 203, 6);
    expect(pqToLinear(0)).toBeCloseTo(0, 9);
    expect(pqOETF(1)).toBeCloseTo(0.5806, 3);
  });
  it("Apple Log: Apple's published curve, 18 % grey near code 0.488", () => {
    expect(linearToAppleLog(0.18)).toBeCloseTo(0.48827, 4);
    for (const l of [0, 0.005, 0.01, 0.18, 0.9, 4]) expect(appleLogToLinear(linearToAppleLog(l))).toBeCloseTo(l, 6);
    expect(appleLogToLinear(0)).toBeCloseTo(-0.05641088, 9);
  });
  it("Rec.709 OETF", () => {
    expect(rec709OETF(0.01)).toBeCloseTo(0.045, 9);
    expect(rec709OETF(0.18)).toBeCloseTo(0.409, 3);
    expect(rec709OETF(1)).toBeCloseTo(1, 9);
    expect(rec709OETF(2)).toBe(1);
  });
});

describe("convertToRec709 (Editroom SourceColor.convert)", () => {
  it("HLG greys follow the fitted curve", () => {
    for (const l of [0.02, 0.18, 0.5, 1, 2]) {
      const v = hlgOETF(l);
      const [r, g, b] = convertToRec709("hlg", v, v, v);
      const want = hdrGrey(hlgToLinear(v));
      expect(r).toBeCloseTo(want, 9);
      expect(g).toBeCloseTo(want, 9);
      expect(b).toBeCloseTo(want, 9);
    }
    // Reference white lands at 0.317 linear (+ lift): about 0.57 encoded, 145/255.
    expect(convertToRec709("hlg", 0.75, 0.75, 0.75)[1] * 255).toBeCloseTo(145.3, 0);
    expect(convertToRec709("hlg", 0, 0, 0)).toEqual([0, 0, 0]);
  });
  it("PQ greys follow the same curve", () => {
    for (const l of [0.05, 1, 4]) {
      const v = pqOETF(l);
      expect(convertToRec709("pq", v, v, v)[0]).toBeCloseTo(hdrGrey(pqToLinear(v)), 9);
    }
  });
  it("HDR saturation is eased 12 % toward grey", () => {
    // A dim red (no knee): after the matrix and the tone scale, each channel sits 88 % of its way from grey.
    const lin = [0.3, 0.1, 0.1];
    const c = REC2020_TO_709.map((row) => Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
    const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const scale = (0.317 * Math.pow(y, 0.88) + 0.0143) / y;
    const want = c.map((v) => rec709OETF(y * scale + (v * scale - y * scale) * 0.88));
    const got = convertToRec709("hlg", hlgOETF(0.3), hlgOETF(0.1), hlgOETF(0.1));
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
  });
  it("Apple Log: no tone curve, knee at 0.9, hue kept", () => {
    const grey = linearToAppleLog(0.18);
    expect(convertToRec709("appleLog", grey, grey, grey)[0]).toBeCloseTo(rec709OETF(0.18), 9);
    // Brighter than white eases toward 1 instead of clipping.
    const bright = linearToAppleLog(2);
    const out = convertToRec709("appleLog", bright, bright, bright)[0];
    expect(out).toBeLessThan(1);
    expect(out).toBeGreaterThan(rec709OETF(0.95));
    // Log 2 differs only by its primaries: grey is grey in both.
    expect(convertToRec709("appleLog2", grey, grey, grey)[2]).toBeCloseTo(rec709OETF(0.18), 9);
    const sat = convertToRec709("appleLog", linearToAppleLog(0.4), grey, grey);
    const sat2 = convertToRec709("appleLog2", linearToAppleLog(0.4), grey, grey);
    expect(sat[0]).not.toBeCloseTo(sat2[0], 3);
  });
});

describe("cube", () => {
  it("is 64³ RGBA, red fastest, matching convert at lattice points", () => {
    const cube = sourceCube("hlg")!;
    const n = SOURCE_CUBE_SIZE;
    expect(cube.length).toBe(n * n * n * 4);
    for (const [r, g, b] of [[0, 0, 0], [63, 0, 0], [10, 40, 63], [48, 48, 48]]) {
      const i = ((b * n + g) * n + r) * 4;
      const want = convertToRec709("hlg", r / 63, g / 63, b / 63);
      expect(cube[i]).toBeCloseTo(want[0], 6);
      expect(cube[i + 1]).toBeCloseTo(want[1], 6);
      expect(cube[i + 2]).toBeCloseTo(want[2], 6);
      expect(cube[i + 3]).toBe(1);
    }
    expect(sourceCube("hlg")).toBe(cube);
    expect(sourceCube("standard")).toBeUndefined();
  });
});

describe("detection", () => {
  it("Apple Log from the backend, HDR from the transfer", () => {
    expect(sourceColorOf(undefined)).toBe("standard");
    expect(sourceColorOf({ colorTransfer: "arib-std-b67" })).toBe("hlg");
    expect(sourceColorOf({ colorTransfer: "smpte2084" })).toBe("pq");
    expect(sourceColorOf({ colorTransfer: "bt709" })).toBe("standard");
    expect(sourceColorOf({ colorTransfer: "bt709", sourceColor: "appleLog" })).toBe("appleLog");
    expect(sourceColorOf({ colorTransfer: "arib-std-b67", sourceColor: "standard" })).toBe("hlg");
  });
  it("matrix coefficients", () => {
    expect(yuvCoefficients("bt2020nc", "hlg")).toEqual([0.2627, 0.0593]);
    expect(yuvCoefficients("bt709", "hlg")).toEqual([0.2126, 0.0722]);
    expect(yuvCoefficients(undefined, "appleLog")).toEqual([0.2627, 0.0593]);
    expect(yuvCoefficients("smpte170m", "pq")).toEqual([0.299, 0.114]);
  });
});
