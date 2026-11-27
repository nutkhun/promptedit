// Vertical arrangement of the timeline, shared by the canvas, the track headers and the scroll bars
// (Editroom's TimelineLayout, docs/spec/04-ui.md §3.1). All sizes are CSS px.

import { NEW_AUDIO_TRACK, NEW_VIDEO_TRACK } from "../model";
import type { Id, Project, Track } from "../model";

export const RULER = 26;
/** The "+ Video" / "+ Audio" add-track drop zones above and below the tracks. */
export const ZONE = 26;
export const GAP = 1;
/** Between the video and audio tracks. */
export const DIVIDER = 9;
export const HEADER_WIDTH = 176;
export const CAPTION_ROW = 30;
/** Height everything except the track rows takes up. */
export const FIXED_HEIGHT = ZONE * 2 + DIVIDER;
export const ROW_MIN = 30;
export const ROW_MAX = 110;
export const ROW_DEFAULT = 62;

/** Height the caption track takes above the video tracks (none without one). */
export const captionSpace = (p: Project) => (p.captions ? CAPTION_ROW + GAP : 0);

export interface Row {
  track: Track;
  /** Index in its kind's array: V1 / A1 = 0. */
  index: number;
  /** Content y (0 = top of the tracks, before scrolling). */
  y: number;
  height: number;
}

export interface Layout {
  rows: Row[];
  /** The caption row, at the top, when the sequence has a caption track. */
  captionY?: number;
  videoZoneY: number;
  dividerY: number;
  audioZoneY: number;
  contentHeight: number;
}

/** Caption row → "+ Video" zone → V_n … V1 → divider → A1 … A_n → "+ Audio" zone. */
export function makeLayout(p: Project, rowHeight: number): Layout {
  let y = 0;
  let captionY: number | undefined;
  if (p.captions) {
    captionY = y;
    y += CAPTION_ROW + GAP;
  }
  const videoZoneY = y;
  y += ZONE;
  const rows: Row[] = [];
  for (let i = p.videoTracks.length - 1; i >= 0; i--) {
    rows.push({ track: p.videoTracks[i], index: i, y, height: rowHeight });
    y += rowHeight + GAP;
  }
  const dividerY = y;
  y += DIVIDER;
  p.audioTracks.forEach((track, index) => {
    rows.push({ track, index, y, height: rowHeight });
    y += rowHeight + GAP;
  });
  const audioZoneY = y;
  y += ZONE;
  return { rows, captionY, videoZoneY, dividerY, audioZoneY, contentHeight: y };
}

/** Vertical band (content y) of a track, including the "new track" placeholders (zone inset 2). */
export function band(l: Layout, trackID: Id): { y: number; height: number } | undefined {
  if (trackID === NEW_VIDEO_TRACK) return { y: l.videoZoneY + 2, height: ZONE - 4 };
  if (trackID === NEW_AUDIO_TRACK) return { y: l.audioZoneY + 2, height: ZONE - 4 };
  const row = l.rows.find((r) => r.track.id === trackID);
  return row ? { y: row.y, height: row.height } : undefined;
}

export type Lane =
  | { kind: "track"; track: Track; index: number }
  | { kind: "newVideo" }
  | { kind: "newAudio" }
  | { kind: "none" };

/** What lies at a content y: a track row (with the gap below it), a new-track zone, or nothing. */
export function laneAt(l: Layout, contentY: number): Lane {
  if (contentY < l.videoZoneY + ZONE) return { kind: "newVideo" };
  if (contentY >= l.audioZoneY) return { kind: "newAudio" };
  for (const row of l.rows) {
    if (contentY >= row.y && contentY < row.y + row.height + GAP) return { kind: "track", track: row.track, index: row.index };
  }
  return { kind: "none" };
}

/** Whether a track is "off": dim label and lane (locked, hidden video, inaudible audio). */
export function trackOff(p: Project, t: Track): boolean {
  if (t.locked) return true;
  if (t.kind === "video") return t.hidden;
  if (t.muted) return true;
  return p.audioTracks.some((x) => x.solo) && !t.solo;
}

export const trackLabel = (t: Track, index: number) => `${t.kind === "video" ? "V" : "A"}${index + 1}`;
