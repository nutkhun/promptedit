// Caption layout, checked against cases taken from Editroom (SelfTest.swift "Captions", and the
// rules in Model/Captions.swift worked through by hand).

import { describe, expect, it } from "vitest";
import type { CaptionFix, Project } from "../model";
import { asset, clip, project } from "../timeline/fixtures.test-util";
import {
  captionBlocks, captionTargets, captionTextFixes, captionedClips, covered, defaultCaptionTargets, fixesOf, hasCaptions, mergeFixes,
  phrases, type CaptionWord, type Transcript,
} from "./layout";

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];
const words = (list: [string, number, number][]): Transcript => ({ words: list.map(([text, start, end]) => ({ start, end, text })), language: "en" });

/** SelfTest's sequence: 1280×720, a video at 5 s for 3 s from 1 s into the file, its sound linked below. */
function selfTestProject(): Project {
  return project([
    clip("cv", "V1", 5, 3, { assetID: "a", sourceStart: 1, linkID: "L" }),
    clip("ca", "A1", 5, 3, { kind: "audio", assetID: "a", sourceStart: 1, linkID: "L", captioned: true }),
  ], { width: 1280, height: 720, captions: { hidden: false, style: defaultStyle } });
}
const defaultStyle = {
  size: 64, y: 0.78, highlight: true, textColor: { r: 1, g: 1, b: 1, a: 1 }, highlightColor: { r: 1, g: 0.84, b: 0.25, a: 1 },
  outline: true, outlineColor: { r: 0, g: 0, b: 0, a: 1 },
};
const said = words([
  ["hello", 0.2, 0.5], ["so", 1.1, 1.3], ["here's", 1.35, 1.6], ["the", 1.62, 1.7], ["thing.", 1.72, 2.0],
  ["we", 2.8, 2.95], ["made", 3.0, 3.3], ["it", 3.35, 3.5], ["again", 4.5, 4.8],
]);
const heard = () => said;

/** Applies a caption's new text as the `setCaptionFixes` edit would. */
function setText(p: Project, block: ReturnType<typeof captionBlocks>[number], text: string): Project {
  const fixes = mergeFixes(fixesOf(p, block.assetID), captionTextFixes(block, text));
  const flat = (p.captionFixes ?? []).slice();
  const i = flat.indexOf(block.assetID);
  if (i >= 0) flat[i + 1] = fixes; else flat.push(block.assetID, fixes);
  return { ...p, captionFixes: flat };
}

describe("CaptionLayout (Editroom SelfTest)", () => {
  it("captioning the video means its sound", () => {
    const p = selfTestProject();
    expect([...captionTargets(p, ["cv"])]).toEqual(["ca"]);
    expect(hasCaptions(p, ["cv"])).toBe(true);
  });

  it("lays the words heard in the clip out in phrases where they're said", () => {
    const blocks = captionBlocks(selfTestProject(), heard);
    expect(blocks.map((b) => b.text)).toEqual(["so here's the thing.", "we made it"]);
    expect(blocks[0].start).toBeCloseTo(5.1, 9);
    expect(blocks[1].start).toBeCloseTo(6.8, 9);
    for (const b of blocks) expect(b.end).toBeLessThanOrEqual(8 + 1e-9);
    // Held 0.25 s after the last word ("thing." ends at 6.0); the second until 7.75.
    expect(blocks[0].end).toBeCloseTo(6.25, 9);
    expect(blocks[1].end).toBeCloseTo(7.75, 9);
    expect(blocks[0].id).toBe("ca@1100");
    expect(blocks[1].id).toBe("ca@2800");
    expect(blocks[0].clipID).toBe("ca");
    expect(blocks[0].assetID).toBe("a");
  });

  it("follows the clip when it moves and plays faster", () => {
    const p = selfTestProject();
    p.clips = p.clips.map((c) => ({ ...c, start: c.start + 2, speed: 2, duration: 1.5 }));
    const moved = captionBlocks(p, heard);
    expect(moved.length).toBe(2);
    expect(moved[0].start).toBeCloseTo(7.05, 9);
    expect(moved[1].start).toBeCloseTo(7.9, 9);
  });

  it("takes fixes one for one, and a deleted caption leaves its words out", () => {
    let p = selfTestProject();
    const blocks = captionBlocks(p, heard);
    p = setText(p, blocks[1], "we made it!");
    p = setText(p, blocks[0], "");
    expect(captionBlocks(p, heard).map((b) => b.text)).toEqual(["we made it!"]);
    expect(fixesOf(p, "a").map((f) => [f.start, f.text])).toEqual([
      [1.1, ""], [1.35, ""], [1.62, ""], [1.72, ""], [2.8, "we"], [3.0, "made"], [3.35, "it!"],
    ]);
  });

  it("typing fewer words: the first takes them all; more words share the caption's time", () => {
    let p = selfTestProject();
    const blocks = captionBlocks(p, heard);
    p = setText(p, blocks[1], "we did");
    expect(last(captionBlocks(p, heard))?.text).toBe("we did");
    expect(fixesOf(p, "a")).toEqual([
      { start: 2.8, text: "we did" }, { start: 3.0, text: "", merged: true }, { start: 3.35, text: "", merged: true },
    ]);

    p = setText(p, blocks[1], "and then we finally made it work");
    const longer = captionBlocks(p, heard).filter((b) => b.start >= blocks[1].start - 1e-9);
    expect(longer.map((b) => b.text).join(" ")).toBe("and then we finally made it work");
    expect(longer[0].start).toBeCloseTo(blocks[1].start, 6);
    expect(last(longer)!.end).toBeCloseTo(blocks[1].end, 6);
    expect(longer.flatMap((b) => b.words).length).toBe(7);
    // 32 characters would make two phrases, but a retyped word's new words are one edit: never cut.
    expect(longer.map((b) => b.text)).toEqual(["and then we finally made it work"]);
    // Every new word stands for all three words said.
    expect(covered(longer[0])).toEqual([2.8, 3.0, 3.35]);
    // The joined words' time (6.8 … 7.5) is shared by length + 1.
    const all = longer.flatMap((b) => b.words);
    expect(all[0].start).toBeCloseTo(6.8, 9);
    expect(last(all)!.end).toBeCloseTo(7.5, 9);
    expect(all[0].end - all[0].start).toBeCloseTo((0.7 * 4) / 33, 9);

    // The same words again: every word comes back.
    p = setText(p, blocks[1], "we made it");
    expect(last(captionBlocks(p, heard))?.text).toBe("we made it");
    expect(fixesOf(p, "a").every((f) => !f.merged)).toBe(true);
  });
});

describe("CaptionLayout rules", () => {
  const one = (list: [string, number, number][], extra: Partial<Parameters<typeof clip>[4]> = {}, length = 20) => {
    const p = project([clip("c", "A1", 0, length, { kind: "audio", assetID: "a", captioned: true, ...extra })], {
      assets: [asset("a", 60)], captions: { hidden: false, style: defaultStyle },
    });
    return captionBlocks(p, () => words(list));
  };

  it("needs a caption track and a captioned, forward-playing sound clip", () => {
    const list: [string, number, number][] = [["hi", 1, 1.2]];
    expect(one(list).length).toBe(1);
    expect(one(list, { reversed: true }).length).toBe(0);
    expect(one(list, { freeze: true }).length).toBe(0);
    expect(one(list, { kind: "video" }).length).toBe(0);
    expect(one(list, { captioned: false }).length).toBe(0);
    const p = project([clip("c", "A1", 0, 5, { kind: "audio", assetID: "a", captioned: true })]);
    expect(captionedClips(p)).toEqual([]);
  });

  it("a word belongs to the clip when its middle is inside, clamped to the clip's edges", () => {
    const blocks = one([["early", 0.8, 1.4], ["late", 2.7, 3.4]], { sourceStart: 1 }, 2);
    // "early" (middle 1.1) starts before the clip's footage: clamped to the clip start. "late" (middle
    // 3.05) is past the end of footage at 3.
    expect(blocks.map((b) => b.text)).toEqual(["early"]);
    expect(blocks[0].start).toBe(0);
    expect(blocks[0].words[0].end).toBeCloseTo(0.4, 9);
  });

  it("a pause of half a second, or the end of a sentence, starts a new caption", () => {
    expect(one([["one", 0, 0.2], ["two", 0.69, 0.8]]).map((b) => b.text)).toEqual(["one two"]);
    expect(one([["one", 0, 0.2], ["two", 0.71, 0.8]]).map((b) => b.text)).toEqual(["one", "two"]);
    // 0.7 - 0.2 is a hair under 0.5 in floating point, as in Swift: still one run.
    expect(one([["one", 0, 0.2], ["two", 0.7, 0.8]]).map((b) => b.text)).toEqual(["one two"]);
    expect(one([["Done!", 0, 0.2], ["next", 0.3, 0.5]]).map((b) => b.text)).toEqual(["Done!", "next"]);
    expect(one([["Really?", 0, 0.2], ["yes", 0.3, 0.5]]).map((b) => b.text)).toEqual(["Really?", "yes"]);
    expect(one([["Yes,", 0, 0.2], ["please", 0.3, 0.5]]).map((b) => b.text)).toEqual(["Yes, please"]);
  });

  it("a caption shows at least 0.6 s, held 0.25 s after its last word, never into the next or past the clip", () => {
    const [a, b] = one([["hi.", 1, 1.1], ["there", 1.5, 1.7]]);
    expect(a.end).toBeCloseTo(1.5, 9); // min(next 1.5, max(1.35, 1.6))
    expect(b.end).toBeCloseTo(2.1, 9); // max(1.95, 2.1)
    const [c] = one([["bye", 1.7, 1.9]], {}, 2);
    expect(c.end).toBe(2); // the clip ends
    // Never before the last word's end.
    const [d] = one([["long", 1, 1.9]], {}, 1.5);
    expect(d.end).toBe(1.5);
  });

  it("removed words drop out; a merged word lends its time to the word before", () => {
    const p = project([clip("c", "A1", 0, 10, { kind: "audio", assetID: "a", captioned: true })], {
      assets: [asset("a", 60)], captions: { hidden: false, style: defaultStyle },
      captionFixes: ["a", [{ start: 1, text: "Hi" }, { start: 1.3, text: "", merged: true }, { start: 1.6, text: "" }] as CaptionFix[]],
    });
    const blocks = captionBlocks(p, () => words([["hey", 1, 1.2], ["you", 1.3, 1.5], ["um", 1.6, 1.7], ["ok", 1.8, 1.9]]));
    expect(blocks.map((b) => b.text)).toEqual(["Hi ok"]);
    expect(blocks[0].words[0].end).toBeCloseTo(1.5, 9);
    expect(blocks[0].words[0].covers).toEqual([1, 1.3]);
    expect(covered(blocks[0])).toEqual([1, 1.3, 1.8]);
    // A merged word whose word before isn't there (left out) is dropped.
    const q = { ...p, captionFixes: ["a", [{ start: 1, text: "" }, { start: 1.3, text: "", merged: true }]] as Project["captionFixes"] };
    expect(captionBlocks(q, () => words([["hey", 1, 1.2], ["you", 1.3, 1.5], ["ok", 1.8, 1.9]])).map((b) => b.text)).toEqual(["ok"]);
  });

  it("fixes match the word's start within half a millisecond", () => {
    const fix = (start: number) => project([clip("c", "A1", 0, 10, { kind: "audio", assetID: "a", captioned: true })], {
      assets: [asset("a", 60)], captions: { hidden: false, style: defaultStyle }, captionFixes: ["a", [{ start, text: "X" }]],
    });
    const t = () => words([["w", 1, 1.2]]);
    expect(captionBlocks(fix(1.0004), t)[0].text).toBe("X");
    expect(captionBlocks(fix(1.0006), t)[0].text).toBe("w");
  });

  it("overlapping speech: each caption gives way to the next, but shows at least 0.05 s", () => {
    const p = project([
      clip("c1", "A1", 0, 10, { kind: "audio", assetID: "a", captioned: true }),
      clip("c2", "A2", 0, 10, { kind: "audio", assetID: "b", captioned: true }),
    ], { assets: [asset("a", 60), asset("b", 60)], captions: { hidden: false, style: defaultStyle } });
    const scripts: Record<string, Transcript> = {
      a: words([["first", 1, 1.5], ["speaker", 1.55, 2]]), b: words([["second", 1.2, 1.6]]), c: words([]),
    };
    const blocks = captionBlocks(p, (x) => scripts[x.id]);
    expect(blocks.map((b) => b.text)).toEqual(["first speaker", "second"]);
    expect(blocks[0].end).toBeCloseTo(1.2, 9);
    // "second" said 0.02 s before "first": it gives way, but stays up 0.05 s.
    const q = { ...p, clips: p.clips.map((c) => (c.id === "c2" ? { ...c, sourceStart: 0.22 } : c)) };
    const close = captionBlocks(q, (x) => scripts[x.id]);
    expect(close.map((b) => b.text)).toEqual(["second", "first speaker"]);
    expect(close[0].end).toBeCloseTo(1.03, 9);
  });

  it("files with no transcript, or nothing said, have no captions", () => {
    expect(one([])).toEqual([]);
    const p = project([clip("c", "A1", 0, 10, { kind: "audio", assetID: "a", captioned: true })], { captions: { hidden: false, style: defaultStyle } });
    expect(captionBlocks(p, () => undefined)).toEqual([]);
  });

  it("block ids truncate the first word's file time to whole milliseconds", () => {
    expect(one([["x", 1.23456, 1.3]])[0].id).toBe("c@1234");
  });
});

describe("phrases", () => {
  const w = (text: string, start: number, end: number, source = start): CaptionWord => ({ text, start, end, source, covers: [source] });
  const run = (texts: string[], step = 0.2) => texts.map((t, i) => w(t, i * step, i * step + step * 0.9));

  it("keeps a short run whole", () => {
    expect(phrases(run(["a", "short", "one"])).length).toBe(1);
  });

  it("cuts by characters: as many even phrases as keep each within 26", () => {
    // 4 × "abcdefgh" + spaces = 35 characters → 2 phrases, cut after the second word (17 ≈ 17.5).
    const out = phrases(run(["abcdefgh", "abcdefgh", "abcdefgh", "abcdefgh"]));
    expect(out.map((g) => g.length)).toEqual([2, 2]);
  });

  it("cuts by time: no phrase longer than 2.6 s", () => {
    // Six words over 3.0 s → 2 phrases.
    const out = phrases(run(["a", "b", "c", "d", "e", "f"], 0.5));
    expect(out.length).toBe(2);
    expect(out.map((g) => g.length)).toEqual([3, 3]);
  });

  it("prefers a cut after a comma (6 characters nearer)", () => {
    // 29 characters: two phrases, target 14.5. Word ends 5, 11, 17, 23: plain, the cut after "ccccc"
    // (|17 - 14.5| = 2.5) beats "bbbbb" (3.5). With "bbbbb," (end 12, |12 - 14.5| - 6 < 0) the comma wins.
    const plain = phrases(run(["aaaaa", "bbbbb", "ccccc", "ddddd", "eeeee"]));
    expect(plain.map((g) => g.length)).toEqual([3, 2]);
    const comma = phrases(run(["aaaaa", "bbbbb,", "ccccc", "ddddd", "eeeee"]));
    expect(comma.map((g) => g.length)).toEqual([2, 3]);
  });

  it("never leaves a phrase without a word, and never cuts inside a retyped word's new words", () => {
    const many = Array.from({ length: 3 }, (_, i) => w("x".repeat(30), i * 0.3, i * 0.3 + 0.2));
    expect(phrases(many).map((g) => g.length)).toEqual([1, 1, 1]);
    // Four new words of one retyped word (same source): one phrase, however long.
    const retyped = ["abcdefghij", "abcdefghij", "abcdefghij", "abcdefghij"].map((t, i) => w(t, i * 0.1, i * 0.1 + 0.1, 5));
    expect(phrases(retyped).length).toBe(1);
  });

  it("counts characters as people see them (Thai vowel marks are part of a letter)", () => {
    // 13 Thai characters per word, as grapheme clusters; UTF-16 length is larger.
    const thai = "สวัสดีครับผม";
    const out = phrases(run([thai, thai]));
    expect(out.length).toBe(1);
  });
});

describe("captionTextFixes", () => {
  const block = { words: [
    { start: 0, end: 1, text: "a", source: 1, covers: [1] },
    { start: 1, end: 2, text: "b", source: 2, covers: [2, 3] },
  ] };
  it("covers every word said, in order", () => {
    expect(covered(block)).toEqual([1, 2, 3]);
  });
  it("empty: every word left out; same count: one for one; otherwise the first takes it all", () => {
    expect(captionTextFixes(block, "  ")).toEqual([{ start: 1, text: "" }, { start: 2, text: "" }, { start: 3, text: "" }]);
    expect(captionTextFixes(block, "x y\nz")).toEqual([{ start: 1, text: "x" }, { start: 2, text: "y" }, { start: 3, text: "z" }]);
    expect(captionTextFixes(block, "x  y")).toEqual([{ start: 1, text: "x y" }, { start: 2, text: "", merged: true }, { start: 3, text: "", merged: true }]);
  });
  it("merging replaces fixes for the same word and sorts by start", () => {
    expect(mergeFixes([{ start: 3, text: "q" }, { start: 1.0002, text: "old" }], [{ start: 1, text: "new" }]))
      .toEqual([{ start: 1, text: "new" }, { start: 3, text: "q" }]);
  });
});

describe("caption targets", () => {
  it("with nothing picked: video files' sound and voices something ducks under, never music or frozen sound", () => {
    const p = project([
      clip("v", "V1", 0, 5, { assetID: "a", linkID: "L" }),
      clip("va", "A1", 0, 5, { kind: "audio", assetID: "a", linkID: "L" }),
      clip("vo", "A2", 0, 5, { kind: "audio", assetID: "voice" }),
      clip("music", "A3", 0, 5, { kind: "audio", assetID: "song" }),
      clip("frozen", "A1", 6, 2, { kind: "audio", assetID: "a", freeze: true }),
    ], {
      assets: [asset("a", 20), asset("voice", 20, { kind: "audio" }), asset("song", 20, { kind: "audio" })],
      audioTracks: [
        { id: "A1", kind: "audio", hidden: false, muted: false, gainDB: 0, solo: false, locked: false, duckDB: -12 },
        { id: "A2", kind: "audio", hidden: false, muted: false, gainDB: 0, solo: false, locked: false, duckDB: -12 },
        { id: "A3", kind: "audio", hidden: false, muted: false, gainDB: 0, solo: false, locked: false, duckDB: -12, duckUnder: "A2" },
      ],
    });
    expect([...defaultCaptionTargets(p)].sort()).toEqual(["va", "vo"]);
    // Picked: only sound clips that play their file, in the linked group.
    expect([...captionTargets(p, ["v"])]).toEqual(["va"]);
    expect([...captionTargets(p, ["music"])]).toEqual(["music"]);
    expect([...captionTargets(p, ["frozen"])]).toEqual([]);
    expect(hasCaptions(p, ["v"])).toBe(false);
  });
});
