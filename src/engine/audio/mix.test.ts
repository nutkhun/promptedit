// The audio mix maths (docs/spec/02-engine.md §10): ducking spans and gain, and per-sample clip
// rendering with gain and fade curves, which playback, scrubbing and export all share.

import { describe, expect, test } from "vitest";
import type { Clip, MediaAsset } from "../../model";
import { DEFAULT_CLIP_COLOR } from "../../model";
import { clipSound, clipVariant, duckGain, renderClip } from "./mix";
import { RATE } from "./pcm";

const clip = (c: Partial<Clip>): Clip => ({
  id: "c", trackID: "A1", kind: "audio", assetID: "a", start: 0, duration: 1, sourceStart: 0, speed: 1, fadeIn: 0, fadeOut: 0,
  gainDB: 0, color: DEFAULT_CLIP_COLOR,
  text: { string: "", fontName: "", bold: true, size: 110, color: { r: 1, g: 1, b: 1, a: 1 }, x: 0.5, y: 0.5 }, ...c,
});
const asset: MediaAsset = { id: "a", path: "/m/a.wav", name: "a", kind: "audio", duration: 10, width: 0, height: 0, fps: 0, hasAudio: true };
const info = { path: "/cache/a.f32", frames: 10 * RATE, rate: RATE, channels: 2, duration: 10 };
/** A fake PCM: every frame's left value is its own frame number / RATE (i.e. its file time), right = 1. */
const ramp = (start: number, count: number) => {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { out[i * 2] = (start + i) / RATE; out[i * 2 + 1] = start + i >= 0 && start + i < info.frames ? 1 : 0; }
  return out;
};

describe("ducking", () => {
  test("attack 0.15 s before, release 0.5 s after, linear in amplitude", () => {
    const spans = [{ start: 2, end: 3 }];
    const low = 0.25;
    expect(duckGain(1, spans, low)).toBe(1);
    expect(duckGain(2.5, spans, low)).toBe(low);
    expect(duckGain(2 - 0.075, spans, low)).toBeCloseTo(low + (1 - low) * 0.5, 9);
    expect(duckGain(3.25, spans, low)).toBeCloseTo(low + (1 - low) * 0.5, 9);
    expect(duckGain(3.6, spans, low)).toBe(1);
  });
});

describe("renderClip", () => {
  test("constant speed: frames map 1:1, gain and fade curves per sample", () => {
    const c = clip({ start: 1, duration: 2, sourceStart: 4, gainDB: -6.0206, fadeIn: 1, fadeInCurve: "easeIn" });
    const s = clipSound(c, asset, info, 10);
    const out = renderClip(s, 1.5, 100, undefined, ramp)!;
    // At t = 1.5: file time 4.5; fade (0.5)³ = 0.125; gain ≈ 0.5.
    expect(out[0]).toBeCloseTo(4.5 * 0.125 * 0.5, 4);
    expect(out[1]).toBeCloseTo(0.125 * 0.5, 4);
  });
  test("silence outside the clip", () => {
    const s = clipSound(clip({ start: 1, duration: 1 }), asset, info, 10);
    const out = renderClip(s, 0.5, RATE, undefined, ramp)!;
    expect(out[0]).toBe(0);
    expect(out[(RATE / 2 + 10) * 2 + 1]).toBe(1);
  });
  test("reversed clips read the reversed file lined up with the asset length", () => {
    // Asset 10 s, its sound 10.2 s: reversed-file time = s + 0.2.
    const c = clip({ start: 0, duration: 2, sourceStart: 3, reversed: true });
    const s = clipSound(c, asset, info, 10.2);
    expect(s.frameAt(1) / RATE).toBeCloseTo(4.2, 9);
  });
  test("speed uses a stretched file (pitch kept): timeline maps 1:1 into it", () => {
    const c = clip({ start: 2, duration: 2, sourceStart: 4, speed: 2 });
    expect(clipVariant(c, asset)).toEqual({ path: "/m/a.wav", reversed: false, speed: 2 });
    const s = clipSound(c, asset, { ...info, duration: 5, frames: 5 * RATE }, 10);
    expect(s.frameAt(3) / RATE).toBeCloseTo((4 + 2) / 2, 9);
  });
  test("speeds outside 1/32…32 are silent; freezes and non-audio clips have no sound", () => {
    expect(clipVariant(clip({ speed: 40 }), asset)).toBeUndefined();
    expect(clipVariant(clip({ kind: "video" }), asset)).toBeUndefined();
  });
});
