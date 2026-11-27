import { describe, expect, it } from "vitest";
import type { Clip } from "../../model";
import { DEFAULT_CLIP_COLOR } from "../../model";
import {
  dragRamp, dragZoom, hasIn, hasOut, rampCurveAt, rampMode, rampShapeOf, switchRampMode, zoomedTime, zoomGraphTop,
  zoomStarter, type RampShape,
} from "./shapes";

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: "c", trackID: "t", kind: "video", assetID: "a", start: 0, duration: 10, sourceStart: 0, speed: 1,
  fadeIn: 0, fadeOut: 0, gainDB: 0, color: DEFAULT_CLIP_COLOR,
  text: { string: "", fontName: "", bold: false, size: 110, color: DEFAULT_CLIP_COLOR, x: 0.5, y: 0.5 },
  ...over,
});

describe("ramp shape", () => {
  it("reads a clip's ramp back as fractions of its footage", () => {
    // SpeedRamp.drawn(0, 10, (0.3, 0.6, 1, 1), start 1, mid 0.5): in over 3…6 s of footage.
    const c = clip({ speed: 0.5, ramp: { inFrom: 3, inTo: 6, outFrom: 10, outTo: 10, startSpeed: 1, endSpeed: 0.5 } });
    // Its length in footage is the 10 s it plays (duration follows; footage stays).
    c.duration = 14;
    const s = rampShapeOf(c);
    expect(hasIn(s)).toBe(true);
    expect(hasOut(s)).toBe(false);
    expect(rampMode(s)).toBe("in");
    expect(s.start).toBeCloseTo(1, 6);
    expect(s.mid).toBe(0.5);
  });
  it("is flat with no ramp", () => {
    const s = rampShapeOf(clip({ speed: 2 }));
    expect(s).toEqual({ mid: 2, p1: 0, p2: 0, p3: 1, p4: 1, start: 2, end: 2 });
    expect(rampCurveAt(s, 0.5)).toBe(2);
  });
  it("eases in log speed", () => {
    const s: RampShape = { mid: 4, p1: 0, p2: 1, p3: 1, p4: 1, start: 1, end: 4 };
    // Halfway through a smoothstep in log space: the geometric mean.
    expect(rampCurveAt(s, 0.5)).toBeCloseTo(2, 9);
  });
});

describe("ramp drags", () => {
  const flat: RampShape = { mid: 1, p1: 0, p2: 0, p3: 1, p4: 1, start: 1, end: 1 };
  it("pulling the inner dot in starts an ease from 100%", () => {
    const d = dragRamp("inEnd", { ...flat, mid: 2, start: 2, end: 2 }, 0.4, 2, "inOut");
    expect(d.p1).toBe(0);
    expect(d.p2).toBe(0.4);
    expect(d.start).toBe(1);
  });
  it("in In mode the inner dot also sets the speed it eases to", () => {
    const s: RampShape = { mid: 0.5, p1: 0.3, p2: 0.6, p3: 1, p4: 1, start: 1, end: 0.5 };
    expect(dragRamp("inEnd", s, 0.5, 3, "in").mid).toBe(3);
    expect(dragRamp("inEnd", s, 0.5, 3, "inOut").mid).toBe(0.5);
  });
  it("squeezing a ramp to nothing removes it", () => {
    const s: RampShape = { mid: 0.5, p1: 0.3, p2: 0.6, p3: 1, p4: 1, start: 1, end: 0.5 };
    const d = dragRamp("inEnd", s, 0.3, 0.5, "inOut");
    expect(hasIn(d)).toBe(false);
    expect(d.start).toBe(d.mid);
  });
  it("outer dots stay off their inner dots", () => {
    const s: RampShape = { mid: 0.5, p1: 0.3, p2: 0.6, p3: 0.7, p4: 0.9, start: 1, end: 1 };
    expect(dragRamp("inStart", s, 0.8, 2, "inOut").p1).toBeCloseTo(0.59, 9);
    expect(dragRamp("outEnd", s, 0.1, 2, "inOut").p4).toBeCloseTo(0.71, 9);
  });
  it("switching to In/Out eases back to the starting speed", () => {
    const s: RampShape = { mid: 0.5, p1: 0.3, p2: 0.6, p3: 1, p4: 1, start: 1, end: 0.5 };
    const d = switchRampMode("inOut", s);
    expect(rampMode(d)).toBe("inOut");
    expect(d.end).toBe(1);
    expect(d.p3).toBeCloseTo(0.6 + 0.4 * 0.4, 9);
    expect(d.p4).toBeCloseTo(0.6 + 0.4 * 0.7, 9);
    expect(switchRampMode("in", d)).toEqual({ ...d, p3: 1, p4: 1, end: d.mid });
  });
});

describe("zoom", () => {
  it("starts each mode as Editroom's ZoomMove.starter", () => {
    expect(zoomStarter("in", 10)).toEqual({ mode: "in", p1: 0, p2: 2, p3: 10, p4: 10, smooth: true });
    expect(zoomStarter("out", 10)).toEqual({ mode: "out", p1: 0, p2: 0, p3: 8, p4: 10, smooth: true });
    expect(zoomStarter("inOut", 1)).toEqual({ mode: "inOut", p1: 0, p2: 0.5, p3: 0.5, p4: 1, smooth: true });
    expect(zoomStarter("in", 3).p2).toBe(0.75);
  });
  it("knows where it's fully in", () => {
    expect(zoomedTime(zoomStarter("in", 10), 10)).toBe(2);
    expect(zoomedTime(zoomStarter("out", 10), 10)).toBeCloseTo(7.999, 9);
  });
  it("steps the graph's top up", () => {
    expect(zoomGraphTop(2)).toBe(3);
    expect(zoomGraphTop(2.95)).toBe(5);
    expect(zoomGraphTop(4)).toBe(5);
    expect(zoomGraphTop(4.9)).toBe(10);
  });
  it("keeps a frame between dots", () => {
    const z = zoomStarter("inOut", 10);
    expect(dragZoom("p2", z, 9.5, 10, 30).p2).toBe(z.p3);
    expect(dragZoom("p1", z, 5, 10, 30).p1).toBeCloseTo(2 - 1 / 30, 9);
    expect(dragZoom("p4", z, 0, 10, 30).p4).toBeCloseTo(8 + 1 / 30, 9);
  });
});
