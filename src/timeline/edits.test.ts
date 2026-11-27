import { describe, expect, it } from "vitest";
import { NEW_AUDIO_TRACK, NEW_VIDEO_TRACK } from "../model";
import { attachedOnLeft, carried, computeMove, computeTrim, cutTime, fadeValue, fits, freshCopies, planDrop, snap } from "./edits";
import type { MoveInput, TrimInput } from "./edits";
import { clip, project, track } from "./fixtures.test-util";

const pps = 100; // 8 px snap = 0.08 s

describe("snap", () => {
  it("takes the closest pair within the pixel threshold", () => {
    expect(snap([1.0, 2.0], [1.05, 2.03], pps, 8)).toEqual({ delta: expect.closeTo(0.03), target: 2.03 });
    expect(snap([1.0], [1.2], pps, 8)).toBeUndefined();
  });
});

describe("move", () => {
  const a = clip("a", "V1", 0, 4, { linkID: "L" });
  const aa = clip("aa", "A1", 0, 4, { kind: "audio", linkID: "L" });
  const b = clip("b", "V1", 6, 2);
  const p = project([a, aa, b]);
  const input = (over: Partial<MoveInput>): MoveInput => ({
    project: p, originals: [a, aa], grabbed: a, startTime: 1, time: 1, pps, playhead: 0, snapping: true,
    lane: { kind: "track", track: p.videoTracks[0], index: 0 }, previousDelta: 0, ...over,
  });

  it("moves the dragged set by Δt, frame-snapped when nothing is near", () => {
    const r = computeMove(input({ time: 1 + 0.512 }));
    expect(r.snapLine).toBeUndefined();
    expect(r.clips.map((c) => c.start)).toEqual([expect.closeTo(0.5, 9), expect.closeTo(0.5, 9)]);
  });

  it("snaps an end onto another clip's start (8 px) and reports the guide", () => {
    const r = computeMove(input({ time: 1 + 1.95 })); // end 5.95 → b.start 6
    expect(r.snapLine).toBe(6);
    expect(r.clips[0].start).toBeCloseTo(2);
  });

  it("snaps to the playhead too, and never before 0", () => {
    expect(computeMove(input({ time: 1 + 2.97, playhead: 7 })).clips[0].start).toBeCloseTo(3);
    expect(computeMove(input({ time: -5 })).clips[0].start).toBe(0);
  });

  it("ignores snapping when it's off (⌘ inverts it in the UI)", () => {
    const r = computeMove(input({ time: 1 + 1.95, snapping: false }));
    expect(r.snapLine).toBeUndefined();
    expect(r.clips[0].start).toBeCloseTo(59 / 30, 9); // frame-snapped instead
  });

  it("moves the linked partner on the matching track (V1→V2 takes A1→A2)", () => {
    const r = computeMove(input({ lane: { kind: "track", track: p.videoTracks[1], index: 1 } }));
    expect(r.trackDelta).toBe(1);
    expect(r.clips.find((c) => c.id === "a")!.trackID).toBe("V2");
    expect(r.clips.find((c) => c.id === "aa")!.trackID).toBe("A2");
  });

  it("keeps the partner put when its destination is taken by other sound", () => {
    const music = clip("m", "A2", 0, 10, { kind: "audio" });
    const q = { ...p, clips: [...p.clips, music] };
    const r = computeMove(input({ project: q, lane: { kind: "track", track: q.videoTracks[1], index: 1 } }));
    expect(r.clips.find((c) => c.id === "aa")!.trackID).toBe("A1");
  });

  it("dropping in the + Video zone makes a new track; partners follow to a new audio track", () => {
    const r = computeMove(input({ lane: { kind: "newVideo" }, originals: [{ ...a, trackID: "V2" }, { ...aa, trackID: "A2" }], grabbed: { ...a, trackID: "V2" } }));
    expect(r.clips[0].trackID).toBe(NEW_VIDEO_TRACK);
    expect(r.clips[1].trackID).toBe(NEW_AUDIO_TRACK);
  });

  it("won't move onto a locked track (keeps the previous delta)", () => {
    const q = { ...p, videoTracks: [p.videoTracks[0], track("V2", "video", { locked: true })] };
    const r = computeMove(input({ project: q, lane: { kind: "track", track: q.videoTracks[1], index: 1 } }));
    expect(r.trackDelta).toBe(0);
    expect(r.clips[0].trackID).toBe("V1");
  });

  it("⌥-drag copies get fresh ids and links, still linked to each other", () => {
    let n = 0;
    const copies = freshCopies([a, aa], () => `id${++n}`);
    expect(copies.map((c) => c.id)).toEqual(["id1", "id3"]);
    expect(copies[0].linkID).toBe("id2");
    expect(copies[1].linkID).toBe("id2");
  });
});

describe("trim", () => {
  const a = clip("a", "V1", 0, 4, { assetID: "a", sourceStart: 2 });
  const b = clip("b", "V1", 4, 3, { assetID: "a", sourceStart: 10 });
  const c = clip("c", "V1", 7, 2, { assetID: "a" });
  const p = project([a, b, c]);
  const input = (over: Partial<TrimInput>): TrimInput => ({
    project: p, originals: [b], grabbed: b, left: false, startTime: 7, time: 7, pps, playhead: 0, snapping: false, sticky: false, ...over,
  });

  it("can't cross the next clip or go under the minimum", () => {
    expect(computeTrim(input({ time: 9 })).clips[0].duration).toBeCloseTo(3);
    expect(computeTrim(input({ time: 6 })).clips[0].duration).toBeCloseTo(2);
    expect(computeTrim(input({ time: 0 })).clips[0].duration).toBeCloseTo(1 / 30);
  });

  it("a head trim moves the start and source, limited by the media before it and the previous clip", () => {
    const r = computeTrim(input({ left: true, startTime: 4, time: 4.5 }));
    expect(r.clips[0].start).toBeCloseTo(4.5);
    expect(r.clips[0].sourceStart).toBeCloseTo(10.5);
    expect(r.clips[0].duration).toBeCloseTo(2.5);
    expect(computeTrim(input({ left: true, startTime: 4, time: 1 })).clips[0].start).toBeCloseTo(4); // a ends at 4
  });

  it("is limited by the end of the file", () => {
    const q = project([clip("x", "V1", 0, 15, { assetID: "a", sourceStart: 3 })]);
    const x = q.clips[0];
    const r = computeTrim({ ...input({}), project: q, originals: [x], grabbed: x, startTime: 15, time: 30 });
    expect(r.clips[0].duration).toBeCloseTo(17); // 20 s file from 3 s
  });

  it("snaps the edge to targets within 8 px", () => {
    const r = computeTrim(input({ snapping: true, time: 6.96, originals: [b], playhead: 6.5 }));
    // edge 6.96: nearest target within 0.08 s is c.start 7 (also the original edge) → clamped there.
    expect(r.clips[0].duration).toBeCloseTo(3);
    const s = computeTrim(input({ snapping: true, time: 6.45, playhead: 6.5 }));
    expect(s.snapLine).toBe(6.5);
    expect(s.clips[0].duration).toBeCloseTo(2.5);
  });

  it("sticky: shortening the end pulls the next clip back, growing pushes it", () => {
    const shorter = computeTrim(input({ sticky: true, time: 6 }));
    expect(shorter.clips.find((x) => x.id === "c")!.start).toBeCloseTo(6);
    const longer = computeTrim(input({ sticky: true, time: 8 }));
    expect(longer.clips.find((x) => x.id === "b")!.duration).toBeCloseTo(4);
    expect(longer.clips.find((x) => x.id === "c")!.start).toBeCloseTo(8);
  });

  it("sticky head trim keeps the start, takes content off the front, and ripples", () => {
    const r = computeTrim(input({ sticky: true, left: true, startTime: 4, time: 5 }));
    const nb = r.clips.find((x) => x.id === "b")!;
    expect(nb.start).toBeCloseTo(4);
    expect(nb.sourceStart).toBeCloseTo(11);
    expect(nb.duration).toBeCloseTo(2);
    expect(r.clips.find((x) => x.id === "c")!.start).toBeCloseTo(6);
  });

  it("a left edge in the open trims freely even with sticky on", () => {
    const lone = clip("l", "V2", 3, 2, { assetID: "a", sourceStart: 5 });
    const q = project([lone]);
    expect(attachedOnLeft([lone], q)).toBe(false);
    const r = computeTrim({ ...input({}), project: q, originals: [lone], grabbed: lone, left: true, startTime: 3, time: 3.5, sticky: true });
    expect(r.clips[0].start).toBeCloseTo(3.5);
    expect(attachedOnLeft([b], p)).toBe(true);
  });

  it("carried clips that would collide go only as far as fits", () => {
    const blocker = clip("z", "A1", 0, 20, { kind: "audio" });
    const cv = { ...c, linkID: "L" };
    const ca = clip("ca", "A1", 7, 2, { kind: "audio", linkID: "L" });
    // c's linked sound sits on A1 right after a clip that won't move: pushing c right pushes ca into nothing, but
    // pulling left would run ca into the blocker's end. Use a blocker ending at 7.
    const q = project([a, b, cv, ca, { ...blocker, duration: 7 }]);
    const r = computeTrim({ ...input({}), project: q, originals: [q.clips[1]], grabbed: q.clips[1], sticky: true, time: 6 });
    // Shortening b by 1 would pull c (and its sound) to 6, into the blocker: nothing fits, so nothing moves.
    expect(r.delta).toBeCloseTo(0, 5);
  });
});

describe("carried / fits", () => {
  it("butts touching clips onto the new end, transitively", () => {
    const p = project([clip("a", "V1", 0, 2), clip("b", "V1", 2, 2), clip("c", "V1", 4, 2)]);
    const out = carried(p, new Map([["a", { ...p.clips[0], duration: 3 }]]));
    expect(out.get("b")!.start).toBeCloseTo(3);
    expect(out.get("c")!.start).toBeCloseTo(5);
  });
  it("fits rejects overlaps and negative starts", () => {
    const p = project([clip("a", "V1", 0, 2), clip("b", "V1", 2, 2)]);
    expect(fits(p, new Map([["a", { ...p.clips[0], duration: 2.5 }]]))).toBe(false);
    expect(fits(p, new Map([["a", { ...p.clips[0], start: -1 }]]))).toBe(false);
    expect(fits(p, new Map([["a", { ...p.clips[0], duration: 1 }]]))).toBe(true);
  });
});

describe("fades and cut tool", () => {
  const p = project([clip("a", "V1", 2, 4, { fadeOut: 1 })]);
  it("fade lengths are frame-snapped and leave room for the other fade", () => {
    expect(fadeValue(p, p.clips[0], 3.01, true)).toBeCloseTo(1);
    expect(fadeValue(p, p.clips[0], 9, true)).toBeCloseTo(3);
    expect(fadeValue(p, p.clips[0], 1, true)).toBe(0);
  });
  it("the blade snaps to the playhead (6 px) and must be half a frame inside", () => {
    expect(cutTime(p, p.clips[0], 4.03, pps, 4, true)).toBe(4);
    expect(cutTime(p, p.clips[0], 4.011, pps, 0, false)).toBeCloseTo(4);
    expect(cutTime(p, p.clips[0], 2.001, pps, 0, false)).toBeUndefined();
  });
});

describe("drops", () => {
  const p = project([clip("a", "V1", 0, 4)]);
  it("lands on the lane under the pointer with audio on the matching track", () => {
    const d = planDrop({ project: p, payloads: [{ type: "asset", id: "a" }], lane: { kind: "track", track: p.videoTracks[1], index: 1 }, time: 6.013, pps, playhead: 0, snapping: false })!;
    expect(d.videoTrack).toBe("V2");
    expect(d.audioTrack).toBe("A2");
    expect(d.start).toBeCloseTo(6);
    expect(d.ghosts.map((g) => g.kind)).toEqual(["video", "audio"]);
    expect(d.ghosts[0].duration).toBeCloseTo(20);
  });
  it("snaps the start or end (8 px); over the headers lands at 0; zones make new tracks", () => {
    const d = planDrop({ project: p, payloads: [{ type: "text" }], lane: { kind: "newVideo" }, time: 4.05, pps, playhead: 0, snapping: true })!;
    expect(d.start).toBe(4);
    expect(d.snapLine).toBe(4);
    expect(d.videoTrack).toBe(NEW_VIDEO_TRACK);
    expect(planDrop({ project: p, payloads: [{ type: "solid" }], lane: { kind: "none" }, time: undefined, pps, playhead: 0, snapping: true })!.start).toBe(0);
  });
  it("never lands on a locked track", () => {
    const q = { ...p, videoTracks: [track("V1", "video", { locked: true }), track("V2", "video")] };
    const d = planDrop({ project: q, payloads: [{ type: "text" }], lane: { kind: "track", track: q.videoTracks[0], index: 0 }, time: 1, pps, playhead: 0, snapping: false })!;
    expect(d.videoTrack).toBe("V2");
  });
});
