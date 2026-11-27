// Layer evaluation (docs/spec/02-engine.md §1, §4, §6.3, §7): which clips draw at a time, in what
// order, with what opacity, wipe, transform and source frame.

import { describe, expect, test } from "vitest";
import type { Clip, MediaAsset, Project, Track } from "../model";
import { DEFAULT_CLIP_COLOR } from "../model";
import { layersAt, layerOpacity, pickFrame, videoPick } from "./layers";
import { transitionPlan } from "../timing";

const track = (id: string, kind: "video" | "audio", extra: Partial<Track> = {}): Track =>
  ({ id, kind, hidden: false, muted: false, gainDB: 0, solo: false, locked: false, duckDB: -12, ...extra });
const asset = (id: string, duration: number): MediaAsset =>
  ({ id, path: `/m/${id}.mp4`, name: id, kind: "video", duration, width: 1920, height: 1080, fps: 30, hasAudio: true });
let n = 0;
const clip = (c: Partial<Clip>): Clip => ({
  id: `c${++n}`, trackID: "V1", kind: "video", start: 0, duration: 1, sourceStart: 0, speed: 1, fadeIn: 0, fadeOut: 0,
  gainDB: 0, color: DEFAULT_CLIP_COLOR,
  text: { string: "Text", fontName: "", bold: true, size: 110, color: { r: 1, g: 1, b: 1, a: 1 }, x: 0.5, y: 0.5 }, ...c,
});
const project = (clips: Clip[], extra: Partial<Project> = {}): Project => ({
  width: 1920, height: 1080, fps: 30, settingsLocked: false,
  videoTracks: [track("V1", "video"), track("V2", "video")], audioTracks: [track("A1", "audio")],
  clips, assets: [asset("a", 10), asset("b", 6)], ...extra,
});

describe("layers", () => {
  const A = () => clip({ id: "A", assetID: "a", start: 0, duration: 8 });
  const B = (kind: "dissolve" | "wipe" | "dipToBlack") =>
    clip({ id: "B", assetID: "b", start: 8, duration: 5, sourceStart: 1, transitionIn: { kind, duration: 1 } });

  test("one clip: its frame at the media clock", () => {
    const [l, ...rest] = layersAt(project([A()]), 3);
    expect(rest).toHaveLength(0);
    expect(l.clipID).toBe("A");
    expect(l.opacity).toBe(1);
    expect(l.source).toEqual({ kind: "video", pick: { asset: "a", time: 3, rule: "at" } });
  });

  test("dissolve: incoming drawn above, ramping over the lead-in; outgoing stays at 100 %", () => {
    const ls = layersAt(project([B("dissolve"), A()]), 7.5);
    expect(ls.map((l) => l.clipID)).toEqual(["A", "B"]);
    expect(ls[0].opacity).toBe(1);
    expect(ls[1].opacity).toBeCloseTo(0.5, 3);
    // B is shown from its head room: source 1 − 0.5.
    expect(ls[1].source.kind === "video" && ls[1].source.pick.time).toBeCloseTo(0.5, 9);
    expect(ls[1].wipe).toBeUndefined();
  });

  test("wipe: full opacity, eased left-to-right reveal", () => {
    const ls = layersAt(project([A(), B("wipe")]), 7.5);
    expect(ls[1].opacity).toBe(1);
    expect(ls[1].wipe).toBeCloseTo(0.5, 3);
    const quarter = layersAt(project([A(), B("wipe")]), 7.25)[1].wipe!;
    expect(quarter).toBeCloseTo(0.25 * 0.25 * (3 - 0.5), 3);
    expect(layersAt(project([A(), B("wipe")]), 8.2)[0].wipe).toBeUndefined();
  });

  test("dip to black: outgoing fades out to the cut, incoming fades in after it", () => {
    const p = project([A(), B("dipToBlack")]);
    const before = layersAt(p, 7.75);
    expect(before.map((l) => l.clipID)).toEqual(["A"]);
    expect(before[0].opacity).toBeCloseTo(0.5, 3);
    const after = layersAt(p, 8.25);
    expect(after.map((l) => l.clipID)).toEqual(["B"]);
    expect(after[0].opacity).toBeCloseTo(0.5, 3);
  });

  test("an incoming clip's own fade-in keeps it invisible during the lead-in", () => {
    const b = { ...B("dissolve"), fadeIn: 0.5 };
    const p = project([A(), b]);
    expect(layerOpacity(b, transitionPlan(p, b), 7.5)).toBe(0);
    expect(layersAt(p, 7.5).map((l) => l.clipID)).toEqual(["A"]);
  });

  test("fade curves", () => {
    const c = clip({ assetID: "a", duration: 4, fadeIn: 1, fadeInCurve: "easeIn", fadeOut: 2, fadeOutCurve: "smooth" });
    const p = project([c]);
    expect(layersAt(p, 0.5 - 1e-4)[0].opacity).toBeCloseTo(0.125, 6);
    expect(layersAt(p, 3 - 1e-4)[0].opacity).toBeCloseTo(0.5, 6);
  });

  test("tracks bottom to top, hidden tracks skipped, later clips above earlier ones", () => {
    const v2 = clip({ id: "top", trackID: "V2", kind: "solid", start: 0, duration: 5 });
    const v1 = clip({ id: "bottom", assetID: "a", start: 0, duration: 5 });
    expect(layersAt(project([v2, v1]), 1).map((l) => l.clipID)).toEqual(["bottom", "top"]);
    const hidden = project([v2, v1], { videoTracks: [track("V1", "video"), track("V2", "video", { hidden: true })] });
    expect(layersAt(hidden, 1).map((l) => l.clipID)).toEqual(["bottom"]);
  });

  test("audio clips, empty text and media past its end draw nothing", () => {
    const p = project([
      clip({ kind: "audio", assetID: "a", duration: 5 }),
      clip({ kind: "text", duration: 5, text: { ...clip({}).text, string: "" } }),
      clip({ assetID: "b", start: 0, duration: 9 }),
    ]);
    expect(layersAt(p, 2).map((l) => l.source.kind)).toEqual(["video"]);
    expect(layersAt(p, 7)).toHaveLength(0); // b is 6 s long
  });

  test("speed, freeze and reverse pick the right file time", () => {
    const p = project([]);
    const fast = clip({ assetID: "a", start: 1, duration: 4, sourceStart: 2, speed: 2 });
    expect(videoPick(p, fast, 2 + 1e-4)).toEqual({ asset: "a", time: 4, rule: "at" });
    const freeze = clip({ assetID: "a", start: 0, duration: 2, sourceStart: 4.2, freeze: true });
    expect(videoPick(p, freeze, 1.5)).toEqual({ asset: "a", time: 4.2, rule: "at" });
    // Reversed: source s is file time L − s; the frame that ends there.
    const rev = clip({ assetID: "a", start: 0, duration: 5, sourceStart: 2, reversed: true });
    const pick = videoPick(p, rev, 1 + 1e-4)!;
    expect(pick.rule).toBe("before");
    expect(pick.time).toBeCloseTo(7, 5);
  });

  test("transforms: zoom moves evaluate at clip-local time", () => {
    const c = clip({ assetID: "a", start: 2, duration: 4, transform: { scale: 2, x: 0.8, y: 0, zoom: { mode: "in", p1: 0, p2: 2, p3: 4, p4: 4, smooth: false } } });
    const l = layersAt(project([c]), 3 - 1e-4)[0];
    // Half way through the zoom-in: scale 1.5; the offset is clamped to ±(scale−1)/2 = 0.5, then × 0.5.
    expect(l.transform!.scale).toBeCloseTo(1.5, 6);
    expect(l.transform!.x).toBeCloseTo(0.25, 6);
  });
});

describe("pickFrame", () => {
  const pts = [0, 1 / 30, 2 / 30, 3 / 30];
  test("at: the frame showing at the time", () => {
    expect(pickFrame(pts, { time: 2 / 30, rule: "at" })).toBe(2);
    expect(pickFrame(pts, { time: 2 / 30 - 1e-3, rule: "at" })).toBe(1);
    expect(pickFrame(pts, { time: 5, rule: "at" })).toBe(3);
  });
  test("before: the frame that ends at the time", () => {
    expect(pickFrame(pts, { time: 2 / 30, rule: "before" })).toBe(1);
    expect(pickFrame(pts, { time: 0, rule: "before" })).toBe(0);
  });
});
