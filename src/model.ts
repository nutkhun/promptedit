// The project model as the Rust core sends it (crates/core/src/model.rs), which is
// Editroom's .room JSON. Field names must match exactly.

export type Id = string;

export interface RGBA { r: number; g: number; b: number; a: number }

export type TrackKind = "video" | "audio";
export interface Track {
  id: Id;
  kind: TrackKind;
  hidden: boolean;
  muted: boolean;
  gainDB: number;
  solo: boolean;
  locked: boolean;
  duckUnder?: Id;
  duckDB: number;
}

export type ClipKind = "video" | "audio" | "image" | "solid" | "text";
export type FadeCurve = "linear" | "easeIn" | "easeOut" | "smooth";
export type TransitionKind = "dissolve" | "dipToBlack" | "wipe";
export type ZoomMode = "in" | "inOut" | "out";

export interface TextStyle {
  string: string;
  fontName: string;
  bold: boolean;
  /** Point size relative to a 1080px tall frame. */
  size: number;
  color: RGBA;
  x: number;
  y: number;
}

export interface Transition { kind: TransitionKind; duration: number }
export interface ReverseSource { assetID: Id; sourceStart: number }
export interface ZoomMove { mode: ZoomMode; p1: number; p2: number; p3: number; p4: number; smooth: boolean }
export interface ClipTransform { scale: number; x: number; y: number; zoom?: ZoomMove }
export interface SpeedRamp {
  inFrom: number; inTo: number; outFrom: number; outTo: number; startSpeed: number; endSpeed: number;
}
export interface WheelPoint { x: number; y: number }
export interface ColorGrade {
  look?: string;
  lookIntensity: number;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  shadows: WheelPoint;
  midtones: WheelPoint;
  highlights: WheelPoint;
}

export interface Clip {
  id: Id;
  trackID: Id;
  kind: ClipKind;
  assetID?: Id;
  start: number;
  duration: number;
  sourceStart: number;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  fadeInCurve?: FadeCurve;
  fadeOutCurve?: FadeCurve;
  gainDB: number;
  linkID?: Id;
  color: RGBA;
  text: TextStyle;
  grade?: ColorGrade;
  transform?: ClipTransform;
  transitionIn?: Transition;
  freeze?: boolean;
  reversedFrom?: ReverseSource;
  reversed?: boolean;
  ramp?: SpeedRamp;
  captioned?: boolean;
}

export type MediaKind = "video" | "audio" | "image";
export interface MediaAsset {
  id: Id;
  path: string;
  relativePath?: string;
  playablePath?: string;
  name: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  bookmark?: string;
}

export type MarkerTint = "white" | "yellow" | "green" | "blue" | "purple" | "red";
export const MARKER_HEX: Record<MarkerTint, string> = {
  white: "#EDEDEA", yellow: "#F2B33D", green: "#6CC08B", blue: "#5B9BF0", purple: "#B07CF0", red: "#F0503C",
};
export interface Marker { id: Id; time: number; name: string; tint: MarkerTint }

export interface CaptionStyle {
  size: number; y: number; highlight: boolean;
  textColor: RGBA; highlightColor: RGBA; outline: boolean; outlineColor: RGBA;
}
export interface CaptionTrack { hidden: boolean; style: CaptionStyle }
export interface CaptionFix { start: number; text: string; merged?: boolean }
export interface MediaFolder { id: Id; path: string; relativePath?: string; bookmark?: string }
export interface MagicHistoryEntry { text: string; tab: string; date: number }

export interface Project {
  width: number;
  height: number;
  fps: number;
  settingsLocked: boolean;
  /** Index 0 is the bottom-most video track (V1). */
  videoTracks: Track[];
  /** Index 0 is the top-most audio track (A1). */
  audioTracks: Track[];
  clips: Clip[];
  assets: MediaAsset[];
  exportName?: string;
  exportDir?: string;
  markers?: Marker[];
  inPoint?: number;
  outPoint?: number;
  magicHistory?: MagicHistoryEntry[];
  captions?: CaptionTrack;
  /** Flat [assetId, fixes, assetId, fixes, …], as Swift encodes a UUID-keyed dictionary. */
  captionFixes?: (Id | CaptionFix[])[];
  folders?: MediaFolder[];
  hiddenMedia?: string[];
}

/** Placeholder track ids for "a new track" while dragging (crates/core model::track_token). */
export const NEW_VIDEO_TRACK = "00000000-0000-0000-0000-0000000000A1";
export const NEW_AUDIO_TRACK = "00000000-0000-0000-0000-0000000000A2";

/** What ffprobe found (src-tauri/src/media.rs `Probe`). */
export interface Probe {
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  /** Degrees clockwise to rotate when drawing. */
  rotation: number;
  container: string;
  videoCodec?: string;
  /** WebCodecs codec string. */
  codecString?: string;
  audioCodec?: string;
  audioRate?: number;
  audioChannels?: number;
  colorPrimaries?: string;
  colorTransfer?: string;
}

// ---- Edits (crates/core/src/edit.rs `Edit`) ----

export type Payload = { type: "asset"; id: Id } | { type: "text" } | { type: "solid" };

export interface ClipPatch {
  fadeIn?: number;
  fadeOut?: number;
  fadeInCurve?: FadeCurve | null;
  fadeOutCurve?: FadeCurve | null;
  gainDB?: number;
  color?: RGBA;
  text?: TextStyle;
  grade?: ColorGrade | null;
  transform?: ClipTransform | null;
  transitionIn?: Transition | null;
}

export interface TrackPatch {
  hidden?: boolean;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
  gainDB?: number;
  duckUnder?: Id | null;
  duckDB?: number;
}

export type Edit =
  | { op: "add"; payloads: Payload[]; start: number; videoTrack: Id; audioTrack: Id; snap: boolean }
  | { op: "addAtPlayhead"; payloads: Payload[]; playhead: number }
  | { op: "place"; clips: Clip[] }
  | { op: "insert"; clips: Clip[]; at: number }
  | { op: "duplicate"; ids: Id[] }
  | { op: "split"; ids: Id[]; at: number }
  | { op: "splitAtPlayhead"; selection: Id[]; playhead: number }
  | { op: "delete"; ids: Id[]; ripple: boolean }
  | { op: "rippleTrim"; selection: Id[]; playhead: number; head: boolean }
  | { op: "reverse"; selection: Id[] }
  | { op: "freezeFrame"; selection: Id[]; playhead: number }
  | { op: "setTransition"; id: Id; transition: Transition | null }
  | { op: "addDissolve"; selection: Id[]; playhead: number }
  | { op: "detachAudio"; ids: Id[] }
  | { op: "deleteGap"; track: Id; at: number }
  | { op: "closeAllGaps"; tracks: Id[] }
  | { op: "setSpeed"; ids: Id[]; speed: number; sticky: boolean }
  | { op: "setRamp"; ids: Id[]; speed: number; points: [number, number, number, number]; start: number; end: number; sticky: boolean }
  | { op: "update"; ids: Id[]; patch: ClipPatch }
  | { op: "pasteGrade"; ids: Id[]; grade: ColorGrade | null }
  | { op: "addTrack"; kind: TrackKind }
  | { op: "removeTrack"; id: Id }
  | { op: "setTrack"; id: Id; patch: TrackPatch }
  | { op: "setSequence"; width: number; height: number }
  | { op: "setFps"; fps: number }
  | { op: "matchSequence"; asset: Id }
  | { op: "removeAssets"; ids: Id[] }
  | { op: "addMarker"; playhead: number }
  | { op: "updateMarker"; marker: Marker }
  | { op: "removeMarker"; id: Id }
  | { op: "clearMarkers" }
  | { op: "setIn"; playhead: number }
  | { op: "setOut"; playhead: number }
  | { op: "clearInOut" }
  | { op: "addCaptions"; ids: Id[] }
  | { op: "removeCaptions"; ids: Id[] }
  | { op: "removeCaptionTrack" }
  | { op: "setCaptionsHidden"; hidden: boolean }
  | { op: "setCaptionStyle"; style: CaptionStyle }
  | { op: "setCaptionFixes"; asset: Id; fixes: CaptionFix[] }
  | { op: "setGains"; gains: Record<Id, number> };

export interface Outcome { changed: boolean; selection?: Id[] | null; seek?: number | null }

export interface Snapshot {
  project: Project;
  file?: string | null;
  title: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  outcome?: Outcome | null;
}

export interface ImportResult {
  snapshot: Snapshot;
  added: Id[];
  probes: [Id, Probe][];
  failed: string[];
}

export const DEFAULT_CLIP_COLOR: RGBA = { r: 0.16, g: 0.16, b: 0.2, a: 1 };
export const DEFAULT_GRADE: ColorGrade = {
  lookIntensity: 1, exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
  shadows: { x: 0, y: 0 }, midtones: { x: 0, y: 0 }, highlights: { x: 0, y: 0 },
};
export const SEQUENCE_PRESETS: [string, number, number][] = [
  ["4K", 3840, 2160], ["1440p", 2560, 1440], ["1080p", 1920, 1080], ["720p", 1280, 720],
  ["Vertical", 1080, 1920], ["Vertical 4K", 2160, 3840], ["Square", 1080, 1080],
];
export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120];
