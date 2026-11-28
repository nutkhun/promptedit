import { describe, expect, it } from "vitest";
import { settingsFor } from "./agentExports";

describe("agent export requests", () => {
  it("map onto the export sheet's settings", () => {
    const s = settingsFor({
      id: "x", file: "/tmp/a.mp4", format: "video", shape: "vertical", height: 1920, codec: "hevc", quality: "web",
      includeAudio: true, loudness: -14, rangeOnly: false, reframeX: 0.3, reframeY: 0.5,
    });
    expect(s).toMatchObject({ format: "mp4", shape: "vertical", height: 1920, codec: "hevc", loudness: -14, reframe: { x: 0.3, y: 0.5 } });
    expect(settingsFor({ id: "y", file: "/tmp/a.wav", format: "audio", shape: "original", height: null, codec: "h264", quality: "high",
      includeAudio: true, loudness: null, rangeOnly: true, reframeX: 0.5, reframeY: 0.5 })).toMatchObject({ format: "wav", height: undefined, loudness: undefined });
    const base = { id: "z", shape: "original" as const, height: null, codec: "h264" as const, includeAudio: true, loudness: null,
      rangeOnly: false, reframeX: 0.5, reframeY: 0.5 };
    expect(settingsFor({ ...base, file: "/tmp/a.mov", format: "prores", quality: "high", proresProfile: "hq" })).toMatchObject({ format: "mov", prores: "hq" });
    expect(settingsFor({ ...base, file: "/tmp/a.mov", format: "prores", quality: "high" })).toMatchObject({ format: "mov", prores: "standard" });
    expect(settingsFor({ ...base, file: "/tmp/a.mp3", format: "mp3", quality: "web" })).toMatchObject({ format: "mp3", mp3Kbps: 192 });
    expect(settingsFor({ ...base, file: "/tmp/a.mp3", format: "mp3", quality: "high" })).toMatchObject({ format: "mp3", mp3Kbps: 320 });
  });
});
