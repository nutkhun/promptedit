import { describe, expect, it } from "vitest";
import { NEW_AUDIO_TRACK, NEW_VIDEO_TRACK } from "../model";
import { band, laneAt, makeLayout } from "./layout";
import { gainFromNorm, gainNorm } from "./edits";
import { rulerLabel, rulerStep } from "./ruler";
import { project } from "./fixtures.test-util";

describe("layout", () => {
  it("stacks zone, V_n…V1, divider, A1…A_n, zone", () => {
    const l = makeLayout(project(), 62);
    expect(l.videoZoneY).toBe(0);
    expect(l.rows.map((r) => [r.track.id, r.y])).toEqual([["V2", 26], ["V1", 89], ["A1", 161], ["A2", 224]]);
    expect(l.dividerY).toBe(152);
    expect(l.audioZoneY).toBe(287);
    expect(l.contentHeight).toBe(313);
    expect(l.captionY).toBeUndefined();
  });

  it("puts the caption row (30 + 1 gap) on top when there is a caption track", () => {
    const p = project([], { captions: { hidden: false, style: { size: 1, y: 0.8, highlight: true, textColor: { r: 1, g: 1, b: 1, a: 1 }, highlightColor: { r: 1, g: 1, b: 0, a: 1 }, outline: false, outlineColor: { r: 0, g: 0, b: 0, a: 1 } } } });
    const l = makeLayout(p, 40);
    expect(l.captionY).toBe(0);
    expect(l.videoZoneY).toBe(31);
    expect(l.rows[0].y).toBe(57);
  });

  it("finds lanes, including the gap under a row and the new-track zones", () => {
    const l = makeLayout(project(), 62);
    expect(laneAt(l, 10)).toEqual({ kind: "newVideo" });
    expect(laneAt(l, 30)).toMatchObject({ kind: "track", index: 1 });
    expect(laneAt(l, 88)).toMatchObject({ kind: "track", index: 1 }); // the 1 pt gap belongs to the row above
    expect(laneAt(l, 155)).toEqual({ kind: "none" }); // divider
    expect(laneAt(l, 300)).toEqual({ kind: "newAudio" });
  });

  it("gives new-track tokens a band inside their zone", () => {
    const l = makeLayout(project(), 62);
    expect(band(l, NEW_VIDEO_TRACK)).toEqual({ y: 2, height: 22 });
    expect(band(l, NEW_AUDIO_TRACK)).toEqual({ y: 289, height: 22 });
  });
});

describe("gain line", () => {
  it("maps 0 dB to 30%, +12 to 10%, −60 to 92%", () => {
    expect(gainNorm(0)).toBeCloseTo(0.3);
    expect(gainNorm(12)).toBeCloseTo(0.1);
    expect(gainNorm(-60)).toBeCloseTo(0.92);
    expect(gainNorm(-6)).toBeCloseTo(0.362);
  });
  it("maps back, clamped and rounded to 0.1 dB, −59.5 and below to −60", () => {
    expect(gainFromNorm(0.3)).toBe(0);
    expect(gainFromNorm(0.0)).toBe(12);
    expect(gainFromNorm(1)).toBe(-60);
    expect(gainFromNorm(0.9149)).toBe(-60);
    for (const db of [-48, -12.5, -3, 0, 2.5, 9.9]) expect(gainFromNorm(gainNorm(db))).toBeCloseTo(db, 5);
  });
});

describe("ruler", () => {
  it("picks the first step at least 86 px wide, skipping 0.5–1 s", () => {
    expect(rulerStep(80, 30)).toEqual({ major: 2, subdivisions: 4 });
    expect(rulerStep(86, 30)).toEqual({ major: 1, subdivisions: 4 });
    expect(rulerStep(2400, 30).major).toBeCloseTo(2 / 30); // 1 frame = 80 px, 2 frames = 160
    // 10 frames at 30 fps = 0.33 s; at 200 px/s that's 67 px, too narrow; the next allowed step is 1 s.
    expect(rulerStep(200, 30)).toEqual({ major: 1, subdivisions: 4 });
    expect(rulerStep(300, 30).major).toBeCloseTo(10 / 30);
    expect(rulerStep(0.001, 30)).toEqual({ major: 36000, subdivisions: 5 });
  });
  it("labels m:ss, frames below a second, hundredths in simple style", () => {
    expect(rulerLabel(75, { major: 5, subdivisions: 5 }, 30, "timecode")).toBe("1:15");
    expect(rulerLabel(3725, { major: 60, subdivisions: 6 }, 30, "timecode")).toBe("1:02:05");
    expect(rulerLabel(2 + 10 / 30, { major: 10 / 30, subdivisions: 5 }, 30, "timecode")).toBe("0:02:10");
    expect(rulerLabel(2.5, { major: 5 / 30, subdivisions: 5 }, 30, "simple")).toBe("0:02.50");
  });
});
