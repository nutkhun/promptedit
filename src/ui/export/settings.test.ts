// The export settings' maths for every format: file names, list labels, size estimates and the
// options the engine gets.

import { describe, expect, it } from "vitest";
import type { Clip, Project } from "../../model";
import { DEFAULT_CLIP_COLOR } from "../../model";
import { defaultSettings, engineOptions, estimatedSize, extension, kindLabel, proresBitrate, type ExportSettings } from "./settings";

const clip: Clip = {
  id: "c", trackID: "V1", kind: "video", start: 0, duration: 60, sourceStart: 0, speed: 1, fadeIn: 0, fadeOut: 0, gainDB: 0,
  color: DEFAULT_CLIP_COLOR, assetID: "a",
  text: { string: "", fontName: "", bold: true, size: 110, color: { r: 1, g: 1, b: 1, a: 1 }, x: 0.5, y: 0.5 },
};
const project: Project = {
  width: 1920, height: 1080, fps: 30, settingsLocked: false, videoTracks: [], audioTracks: [], clips: [clip],
  assets: [{ id: "a", path: "/m/a.mp4", name: "a", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true }],
};
const settings = (s: Partial<ExportSettings>): ExportSettings => ({ ...defaultSettings(project), ...s });

describe("export formats", () => {
  it("name files and list entries", () => {
    expect(extension(settings({ format: "mov" }))).toBe("mov");
    expect(extension(settings({ format: "mp3" }))).toBe("mp3");
    expect(kindLabel(settings({ format: "mov", prores: "hq" }), project)).toBe("ProRes 422 HQ · 1080p");
    expect(kindLabel(settings({ format: "mp3", mp3Kbps: 192 }), project)).toBe("MP3 · 192 kbps");
    expect(kindLabel(settings({}), project)).toBe("H.264 · 1080p");
  });

  it("estimate sizes from Apple's ProRes rates and the MP3 bit rate", () => {
    // 1080p at 29.97 is Apple's published rate; it scales with frames and pixels.
    expect(proresBitrate("hq", { width: 1920, height: 1080 }, 29.97)).toBe(220_000_000);
    expect(proresBitrate("standard", { width: 3840, height: 2160 }, 29.97)).toBe(588_000_000);
    // A minute of ProRes 422 at 1080p30 with 24-bit sound: (147 × 30/29.97 + 2.304) Mb/s × 60 s ≈ 1.1 GB.
    expect(estimatedSize(settings({ format: "mov" }), project)).toBe("~1.1 GB");
    // A minute at 320 kb/s is 2.4 MB.
    expect(estimatedSize(settings({ format: "mp3" }), project)).toBe("~2 MB");
  });

  it("give the engine its options", () => {
    const mov = engineOptions(settings({ format: "mov", prores: "lt", loudness: -16 }), project, "/o/a.mov");
    expect(mov).toMatchObject({ format: "mov-prores", proresProfile: "lt", width: 1920, height: 1080, loudness: -16, includeAudio: true });
    expect(mov.mp3Kbps).toBeUndefined();
    const silent = engineOptions(settings({ format: "mov", includeAudio: false, loudness: -16 }), project, "/o/a.mov");
    expect(silent).toMatchObject({ includeAudio: false, loudness: undefined });
    // A sound-only file always has its sound, even after "No audio" was picked for a movie.
    const mp3 = engineOptions(settings({ format: "mp3", mp3Kbps: 192, includeAudio: false, loudness: -14, shape: "vertical" }), project, "/o/a.mp3");
    expect(mp3).toMatchObject({ format: "mp3", mp3Kbps: 192, includeAudio: true, loudness: -14, reframe: undefined });
  });
});
