import { describe, expect, it } from "vitest";
import {
  MAX_PPS, centeredScrollY, clampView, extent, fitRows, gripDrag, gripMirror, maxScrollX, maxScrollY, minScrollY,
  rowAnchor, rowWindow, rowsAbove, rowsVisible, zoomAround, zoomFit,
} from "./viewMath";
import type { ViewState } from "./viewMath";
import { clip, project, track } from "./fixtures.test-util";

const base: ViewState = { pps: 80, scrollX: 0, scrollY: 0, rowHeight: 62, viewWidth: 1500, viewHeight: 360 };
const p = project([clip("c1", "V1", 0, 12), clip("c2", "A1", 0, 12, { kind: "audio" })]);

/** SelfTest "VIEW LIMITS": inside the bars and stable under re-clamping. */
function good(q: typeof p, v: ViewState) {
  const span = v.viewWidth / v.pps;
  const again = clampView(q, v);
  expect(again).toEqual(v);
  expect(span).toBeLessThanOrEqual(extent(q) + 0.001);
  expect(v.scrollX).toBeGreaterThanOrEqual(0);
  expect(v.scrollX / v.pps + span).toBeLessThanOrEqual(extent(q) + 0.001);
  expect(v.scrollY).toBeGreaterThanOrEqual(minScrollY(q, v) - 0.001);
  expect(v.scrollY).toBeLessThanOrEqual(maxScrollY(q, v) + 0.001);
  expect(rowWindow(q, v)).toBeGreaterThan(0);
  expect(rowWindow(q, v)).toBeLessThanOrEqual(1);
  expect(v.rowHeight).toBeGreaterThanOrEqual(30);
  expect(v.rowHeight).toBeLessThanOrEqual(110);
}

describe("gripDrag (Editroom SelfTest cases, bar 400, min 20, max 400)", () => {
  const cases: [number, number, number, number, number, number][] = [
    [2, 100, 200, 30, 70, 230], [0, 100, 200, -30, 70, 230], [2, 0, 200, 30, 0, 230], [0, 150, 400, -30, 120, 400],
    [0, 0, 200, -30, 0, 200], [2, 150, 400, 30, 150, 400], [0, 0, 200, 30, 30, 170], [2, 100, 200, 500, 0, 400],
    [2, 100, 200, -500, 140, 160],
  ];
  for (const [part, a, b, move, wa, wb] of cases) {
    it(`part ${part} (${a},${b}) ${move > 0 ? "+" : ""}${move} → (${wa},${wb})`, () => {
      const e = gripDrag(part, a, b, move, 400, 20, 400);
      expect(e.start).toBeCloseTo(wa, 2);
      expect(e.end).toBeCloseTo(wb, 2);
    });
  }
  it("mirror 0 moves only the dragged end; mirror ⅓ keeps a playhead at 25%", () => {
    const held = gripDrag(2, 0, 200, -60, 400, 20, 400, 0);
    expect(held.start).toBe(0);
    expect(held.end).toBeCloseTo(140, 2);
    const q = gripDrag(2, 100, 200, -30, 400, 20, 400, 1 / 3);
    expect(q.start).toBeCloseTo(110, 2);
    expect(q.end).toBeCloseTo(170, 2);
    expect((125 - q.start) / (q.end - q.start)).toBeCloseTo(0.25, 3);
  });
  it("chooses the mirror from where the playhead sits", () => {
    expect(gripMirror(2, 0.25)).toBeCloseTo(1 / 3);
    expect(gripMirror(0, 0.75)).toBeCloseTo(1 / 3);
    expect(gripMirror(2, 0.75)).toBe(1);
    expect(gripMirror(0, -0.2)).toBe(1);
  });
});

describe("view limits", () => {
  it("clamps every request inside the bars, stably", () => {
    let v = clampView(p, base);
    good(p, v);
    v = clampView(p, v, { pps: 0.0001 });
    good(p, v);
    const out = v.pps;
    expect(clampView(p, v, { pps: 0.0001 }).pps).toBe(out);
    expect(out).toBeCloseTo(1500 / extent(p));
    v = clampView(p, v, { pps: 1e9, scrollX: 1e9 });
    good(p, v);
    expect(v.pps).toBe(MAX_PPS);
    expect(v.scrollX).toBeCloseTo(maxScrollX(p, v));
    v = clampView(p, v, { scrollX: -500, scrollY: -500 });
    good(p, v);
    v = clampView(p, v, { scrollY: 1e9, rowHeight: 9999 });
    good(p, v);
    expect(v.rowHeight).toBe(110);
    v = clampView(p, v, { rowHeight: 1 });
    good(p, v);
    // Smallest rows: everything fits, the thumb fills the bar and the tracks sit centred.
    expect(rowWindow(p, v)).toBe(1);
    expect(v.scrollY).toBeCloseTo(centeredScrollY(p, v));
  });

  it("rounds row height to whole points", () => {
    expect(clampView(p, base, { rowHeight: 44.6 }).rowHeight).toBe(45);
  });

  it("a centred thumb centres the video/audio divider, even with extra video tracks", () => {
    const q = { ...p, videoTracks: [...p.videoTracks, track("V3", "video"), track("V4", "video"), track("V5", "video")] };
    for (const row of [30, 62, 110]) {
      let v = clampView(q, base, { rowHeight: row });
      v = clampView(q, v, { scrollY: (minScrollY(q, v) + maxScrollY(q, v)) / 2 });
      expect(v.scrollY).toBeCloseTo(centeredScrollY(q, v));
      expect(rowsAbove(q, v.rowHeight) - v.scrollY).toBeCloseTo(rowsVisible(v) / 2);
      good(q, v);
    }
  });

  it("zoom keeps the playhead's screen x unless a limit is in the way", () => {
    let v = clampView(p, base);
    const playhead = 2;
    for (const f of [0.5, 3, 0.2, 7, 0.01, 40]) {
      const before = playhead * v.pps - v.scrollX;
      v = zoomAround(p, v, playhead, v.pps * f);
      const after = playhead * v.pps - v.scrollX;
      const pinned = Math.abs(before - after) < 0.5 || v.scrollX === 0 || Math.abs(v.scrollX - maxScrollX(p, v)) < 0.5
        || before < 0 || before > v.viewWidth;
      expect(pinned).toBe(true);
      good(p, v);
    }
  });

  it("brings an off-screen playhead to the centre when zooming", () => {
    const v = clampView(p, base, { pps: 200, scrollX: 0 });
    const z = zoomAround(p, v, 20, 300); // playhead at 4000 px: off screen
    expect(20 * z.pps - z.scrollX).toBeCloseTo(750);
  });

  it("zoom to fit shows the edit with 80 pt to spare", () => {
    const v = zoomFit(p, base);
    expect(v.pps).toBeCloseTo((1500 - 80) / 12);
    expect(v.scrollX).toBe(0);
  });

  it("fits rows so every track and both zones show, centred, at most 62", () => {
    const v = fitRows(p, base);
    // visible = 334 + 15; room = 349 − 61 − 6 = 282; 282/4 − 1 = 69.5 → capped at 62.
    expect(v.rowHeight).toBe(62);
    const small = fitRows(p, { ...base, viewHeight: 250 });
    // visible = 224 + 15 = 239; room = 172; 172/4 − 1 = 42.
    expect(small.rowHeight).toBe(42);
    const content = 61 + 4 * 43;
    expect(small.scrollY).toBeCloseTo((content - 239) / 2);
  });

  it("finds an anchor again at another row height", () => {
    const a = rowAnchor(p, 62, 26 + 62 + 1 + 31); // 31 pt into V1
    expect(a.fixed).toBeCloseTo(27);
    expect(a.rows).toBeCloseTo(1 + 31 / 62);
    expect(a.fixed + a.rows * 40).toBeCloseTo(26 + 40 + 1 + 20);
  });
});
