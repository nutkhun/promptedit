// Small projects for the timeline's unit tests.

import type { Clip, MediaAsset, Project, Track } from "../model";

export function track(id: string, kind: Track["kind"], extra: Partial<Track> = {}): Track {
  return { id, kind, hidden: false, muted: false, gainDB: 0, solo: false, locked: false, duckDB: -12, ...extra };
}

export function clip(id: string, trackID: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return {
    id, trackID, kind: "video", start, duration, sourceStart: 0, speed: 1, fadeIn: 0, fadeOut: 0, gainDB: 0,
    color: { r: 0.16, g: 0.16, b: 0.2, a: 1 },
    text: { string: "Text", fontName: "", bold: true, size: 110, color: { r: 1, g: 1, b: 1, a: 1 }, x: 0.5, y: 0.5 },
    ...extra,
  };
}

export function asset(id: string, duration: number, extra: Partial<MediaAsset> = {}): MediaAsset {
  return { id, path: `/m/${id}.mp4`, name: id, kind: "video", duration, width: 1920, height: 1080, fps: 30, hasAudio: true, ...extra };
}

/** V1 V2 A1 A2 at 30 fps. */
export function project(clips: Clip[] = [], extra: Partial<Project> = {}): Project {
  return {
    width: 1920, height: 1080, fps: 30, settingsLocked: false,
    videoTracks: [track("V1", "video"), track("V2", "video")],
    audioTracks: [track("A1", "audio"), track("A2", "audio")],
    clips, assets: [asset("a", 20)],
    ...extra,
  };
}
