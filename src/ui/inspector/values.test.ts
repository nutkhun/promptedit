import { describe, expect, it } from "vitest";
import {
  committedValue, fpsLabel, frameDimension, fromNormal, lengthLabel, nudgedValue, parseNumber, percentTenths,
  seconds, signed2, steppedDimension, tenths, toNormal, wheelPoint, WHEEL_REACH, whole,
} from "./values";

describe("parseNumber", () => {
  it("reads the number out of formatted text", () => {
    expect(parseNumber("100%")).toBe(100);
    expect(parseNumber("0.50s")).toBe(0.5);
    expect(parseNumber("−18.8 dB")).toBe(-18.8);
    expect(parseNumber("+3.0 dB")).toBe(3);
    expect(parseNumber("1,5")).toBe(1.5);
    expect(parseNumber("  42 ")).toBe(42);
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber("-.5")).toBe(-0.5);
    expect(parseNumber("5.")).toBe(5);
  });
  it("rejects text that isn't a number", () => {
    expect(parseNumber("")).toBeUndefined();
    expect(parseNumber("abc")).toBeUndefined();
    expect(parseNumber("-")).toBeUndefined();
    expect(parseNumber(".")).toBeUndefined();
    expect(parseNumber("1.2.3")).toBeUndefined();
    expect(parseNumber("−∞ dB")).toBeUndefined();
    expect(parseNumber("5-3")).toBeUndefined();
  });
});

describe("committedValue", () => {
  it("clamps to the range", () => {
    expect(committedValue("9000%", "100%", [10, 5000])).toBe(5000);
    expect(committedValue("1%", "100%", [10, 5000])).toBe(10);
    expect(committedValue("-80 dB", "0.0 dB", [-60, 12])).toBe(-60);
  });
  it("leaves things alone when nothing changed or nothing readable was typed", () => {
    expect(committedValue("100%", "100%", [10, 5000])).toBeUndefined();
    expect(committedValue("fast", "100%", [10, 5000])).toBeUndefined();
  });
});

describe("nudgedValue", () => {
  const base = { up: true, big: false, range: [-100, 100] as const };
  it("steps to the next whole step by what the field shows", () => {
    expect(nudgedValue({ ...base, text: "0.47", value: 0.47, shown: "0.47" })).toBe(0.5);
    expect(nudgedValue({ ...base, text: "0.47", value: 0.47, shown: "0.47", up: false })).toBe(0.4);
    expect(nudgedValue({ ...base, text: "12", value: 12, shown: "12" })).toBe(13);
    expect(nudgedValue({ ...base, text: "12", value: 12, shown: "12", up: false })).toBe(11);
  });
  it("doesn't stall on float noise", () => {
    expect(nudgedValue({ ...base, text: "0.3", value: 0.3, shown: "0.30s" })).toBe(0.4);
    expect(nudgedValue({ ...base, text: "0.3", value: 0.3, shown: "0.30s", up: false })).toBe(0.2);
  });
  it("uses Shift ×10, an explicit step, and the range", () => {
    expect(nudgedValue({ ...base, text: "12", value: 12, shown: "12", big: true })).toBe(20);
    expect(nudgedValue({ ...base, text: "95.3%", value: 95.3, shown: "95.3%", step: 1 })).toBe(96);
    expect(nudgedValue({ ...base, text: "99", value: 99, shown: "99", big: true })).toBe(100);
  });
  it("starts from the value when the text can't be read", () => {
    expect(nudgedValue({ ...base, text: "x", value: 5, shown: "5" })).toBe(6);
  });
});

describe("slider mapping", () => {
  it("is linear by default", () => {
    expect(toNormal(0, [-50, 50])).toBe(0.5);
    expect(fromNormal(0.25, [-2, 2])).toBe(-1);
    expect(toNormal(80, [-50, 50])).toBe(1);
    expect(fromNormal(-1, [0, 10])).toBe(0);
  });
  it("spreads each octave evenly when logarithmic", () => {
    // Speed: 10%…5000%. 100% sits log(10)/log(500) of the way along.
    expect(toNormal(100, [10, 5000], true)).toBeCloseTo(Math.log(10) / Math.log(500), 12);
    expect(fromNormal(0, [10, 5000], true)).toBeCloseTo(10, 9);
    expect(fromNormal(1, [10, 5000], true)).toBeCloseTo(5000, 9);
    // Doubling is the same distance anywhere on the scale.
    const d1 = toNormal(20, [5, 1000], true) - toNormal(10, [5, 1000], true);
    const d2 = toNormal(400, [5, 1000], true) - toNormal(200, [5, 1000], true);
    expect(d1).toBeCloseTo(d2, 12);
  });
  it("round-trips", () => {
    for (const v of [12, 110, 333, 600]) expect(fromNormal(toNormal(v, [12, 600], true), [12, 600], true)).toBeCloseTo(v, 9);
    for (const v of [-60, -6.5, 0, 12]) expect(fromNormal(toNormal(v, [-60, 12]), [-60, 12])).toBeCloseTo(v, 9);
  });
});

describe("formats", () => {
  it("writes values as Editroom does", () => {
    expect(whole(-0.4)).toBe("0");
    expect(whole(12.6)).toBe("13");
    expect(tenths(12)).toBe("12");
    expect(tenths(12.04)).toBe("12");
    expect(tenths(-3.25)).toBe("-3.2");
    expect(percentTenths(95.34)).toBe("95.3%");
    expect(seconds(0.5)).toBe("0.50s");
    expect(signed2(0)).toBe("+0.00");
    expect(signed2(-0.001)).toBe("+0.00");
    expect(signed2(0.6)).toBe("+0.60");
    expect(signed2(-1.5)).toBe("-1.50");
    expect(fpsLabel(30)).toBe("30 fps");
    expect(fpsLabel(29.97)).toBe("29.97 fps");
    expect(fpsLabel(23.976)).toBe("23.98 fps");
    expect(lengthLabel(5.53)).toBe("5.5s");
    expect(lengthLabel(15.4)).toBe("15s");
    expect(lengthLabel(75)).toBe("1:15");
  });
});

describe("frame size", () => {
  it("keeps sizes even and in 16…8192", () => {
    expect(frameDimension("1001")).toBe(1000);
    expect(frameDimension("1920 px")).toBe(1920);
    expect(frameDimension("3")).toBe(16);
    expect(frameDimension("99999")).toBe(8192);
    expect(frameDimension("")).toBeUndefined();
  });
  it("steps by 2 (20 with Shift)", () => {
    expect(steppedDimension("1080", 1080, true, false)).toBe(1082);
    expect(steppedDimension("1081", 1080, false, false)).toBe(1078);
    expect(steppedDimension("720", 720, true, true)).toBe(740);
    expect(steppedDimension("", 16, false, false)).toBe(16);
  });
});

describe("wheelPoint", () => {
  it("has a dead zone around neutral", () => {
    expect(wheelPoint(1, 1)).toEqual({ x: 0, y: 0 });
  });
  it("stays inside the unit disc, in 0.01 steps", () => {
    expect(wheelPoint(WHEEL_REACH * 3, 0)).toEqual({ x: 1, y: 0 });
    const p = wheelPoint(WHEEL_REACH, WHEEL_REACH);
    expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1.01);
    expect(wheelPoint(WHEEL_REACH / 2, -WHEEL_REACH / 4)).toEqual({ x: 0.5, y: -0.25 });
  });
});
