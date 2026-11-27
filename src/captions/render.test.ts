// The caption renderer's timing, wrapping and placement (Editroom CaptionRenderer; docs/spec/02-engine.md
// §9.3). Drawing itself needs a canvas and is checked in the browser.

import { describe, expect, it } from "vitest";
import type { CaptionStyle } from "../model";
import type { CaptionBlock } from "./layout";
import { captionLayers, captionPlacement, captionPointSize, layerAt, wrapWords } from "./render";

const style: CaptionStyle = {
  size: 64, y: 0.78, highlight: true, textColor: { r: 1, g: 1, b: 1, a: 1 }, highlightColor: { r: 1, g: 0.84, b: 0.25, a: 1 },
  outline: true, outlineColor: { r: 0, g: 0, b: 0, a: 1 },
};

const block = (start: number, end: number, words: [string, number, number][]): CaptionBlock => ({
  id: `c@${start}`, clipID: "c", assetID: "a", start, end, text: words.map((w) => w[0]).join(" "),
  words: words.map(([text, s, e]) => ({ text, start: s, end: e, source: s, covers: [s] })),
});

describe("caption layers", () => {
  const b = block(5.1, 6.25, [["so", 5.1, 5.3], ["here's", 5.35, 5.6], ["the", 5.62, 5.7], ["thing.", 5.72, 6.0]]);

  it("one layer per word when the word being said lights up: from its start to the next word's", () => {
    const layers = captionLayers([b], style);
    expect(layers.map((l) => [l.start, l.end, l.lit])).toEqual([
      [5.1, 5.35, 0], [5.35, 5.62, 1], [5.62, 5.72, 2], [5.72, 6.25, 3],
    ]);
    expect(layers.every((l) => l.words.join(" ") === "so here's the thing.")).toBe(true);
    // SelfTest draws at 7.05 s of a caption starting 6.8: the frame shows the word being said.
    expect(layerAt(layers, 5.4)?.lit).toBe(1);
    expect(layerAt(layers, 6.25)).toBeUndefined();
  });

  it("the first word lights from the caption's start; words with no time of their own are skipped", () => {
    const late = block(2, 3, [["a", 2.2, 2.4], ["b", 2.5, 2.6], ["c", 2.5, 2.7]]);
    expect(captionLayers([late], style).map((l) => [l.start, l.end, l.lit])).toEqual([[2, 2.5, 0], [2.5, 3, 2]]);
  });

  it("without highlight, or with one word: one layer (lit 0 only with highlight)", () => {
    expect(captionLayers([b], { ...style, highlight: false }).map((l) => [l.start, l.end, l.lit])).toEqual([[5.1, 6.25, undefined]]);
    const single = block(1, 2, [["hi", 1, 1.3]]);
    expect(captionLayers([single], style).map((l) => [l.start, l.end, l.lit])).toEqual([[1, 2, 0]]);
  });
});

describe("caption drawing maths", () => {
  it("point size is relative to a 1080 px shorter side", () => {
    expect(captionPointSize(64, 1920, 1080)).toBeCloseTo(64);
    expect(captionPointSize(64, 1080, 1920)).toBeCloseTo(64);
    expect(captionPointSize(64, 1280, 720)).toBeCloseTo(64 * 720 / 1080);
  });

  it("wraps by word within the width", () => {
    expect(wrapWords([50, 50, 50], 10, 200)).toEqual([[0, 3]]);
    expect(wrapWords([50, 50, 50], 10, 110)).toEqual([[0, 2], [2, 3]]);
    // A word wider than the line keeps a line to itself.
    expect(wrapWords([300, 50], 10, 100)).toEqual([[0, 1], [1, 2]]);
    expect(wrapWords([], 10, 100)).toEqual([]);
  });

  it("placed centred, its middle at y down the frame, kept inside", () => {
    // 1280×720, a 400×100 bitmap at 0.78: middle at 561.6 px down → top 512 (Core Image y0 = 108).
    expect(captionPlacement(1280, 720, 400, 100, 0.78)).toEqual({ x: 440, y: 512 });
    // Low enough to fall off: held at the bottom edge; high: at the top.
    expect(captionPlacement(1280, 720, 400, 100, 0.99)).toEqual({ x: 440, y: 620 });
    expect(captionPlacement(1280, 720, 400, 100, 0.01)).toEqual({ x: 440, y: 0 });
  });
});
