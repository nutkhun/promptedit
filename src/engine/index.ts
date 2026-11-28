// The media engine's public surface. Everything else in the UI talks to the engine only
// through this object. See docs/ARCHITECTURE.md (decode: WebCodecs; draw: WebGL2;
// sound: Web Audio over PCM extracted by FFmpeg; export: same renderer + WebCodecs encoder).

import type { Id } from "../model";
import type { MeterLevels } from "./audio/meters";
import type { Waveform } from "./audio/waveform";
import { MediaEngine } from "./engine";

export type { MeterLevels, MeterReading } from "./audio/meters";
export type { Waveform } from "./audio/waveform";

export interface ExportOptions {
  /** Full output path, chosen by the person. */
  path: string;
  format: "mp4-h264" | "mp4-hevc" | "mov-prores" | "wav" | "mp3";
  width: number;
  height: number;
  fps: number;
  quality: "high" | "web";
  /** Loudness target in LUFS, or undefined to leave levels alone. */
  loudness?: number;
  /** Only the in/out range. */
  rangeOnly: boolean;
  /** Video formats: false leaves the sound out (Export › Audio › "No audio"). Default true. */
  includeAudio?: boolean;
  /** How the picture fills a different frame shape: centre crop with an offset (-1…1). */
  reframe?: { x: number; y: number };
  /** mov-prores: the ProRes profile (default "standard", ProRes 422). */
  proresProfile?: "proxy" | "lt" | "standard" | "hq";
  /** mp3: constant bit rate in kb/s (default 320). */
  mp3Kbps?: 192 | 320;
}

export interface ExportProgress {
  fraction: number;
  phase: "preparing" | "rendering" | "finishing" | "done" | "failed" | "cancelled";
  message?: string;
}

export interface Engine {
  /** The viewer's canvas; the engine draws into it at the sequence's aspect. */
  attachViewer(canvas: HTMLCanvasElement | null): void;
  /** Show the timeline at time t. `fast` allows an approximate (nearest keyframe/cached) frame. */
  showFrame(t: number, fast?: boolean): void;
  /** Show a frame of one file (library hover-scrub, trim edge preview); undefined returns to the timeline. */
  showSource(source?: { asset: Id; time: number }): void;
  /** Start playback from t. The engine moves the store's playhead while playing. */
  play(from: number): void;
  pause(): void;
  /** A frame of a file, for filmstrips and library posters. Cached. */
  thumbnail(asset: Id, time: number, height: number): Promise<ImageBitmap | undefined>;
  /** Loudness envelope: RMS per 1/200 s of the file, 0…1. Cached. */
  waveform(asset: Id): Promise<Float32Array | undefined>;
  /** Output levels in dB (left, right), for the meters; -Infinity when silent. */
  meters(): [number, number];
  /** Short burst of sound at t (audio scrubbing). */
  scrubAudio(t: number): void;
  export(options: ExportOptions, onProgress: (p: ExportProgress) => void): Promise<void>;
  cancelExport(): void;
  /** Every meter (per track, master, left, right) with peak hold and clip state, in dBFS (−60 floor). */
  levels?(): MeterLevels;
  /** The whole waveform (peaks, left, right, rms at 200/s). Cached. */
  waveformData?(asset: Id): Promise<Waveform | undefined>;
  /** Whether video exported bigger than its own pixels is upscaled here (the export sheet's badge, §12). */
  canUpscale?(): boolean;
}

/** Placeholder until the real engine lands: draws nothing, plays a clock. */
class NullEngine implements Engine {
  attachViewer() {}
  showFrame() {}
  showSource() {}
  play() {}
  pause() {}
  async thumbnail() { return undefined; }
  async waveform() { return undefined; }
  meters(): [number, number] { return [-Infinity, -Infinity]; }
  scrubAudio() {}
  async export() { throw new Error("Export isn't available yet."); }
  cancelExport() {}
}

/** The real engine in a browser/webview; the null one where there's no DOM (unit tests). */
export let engine: Engine = typeof window !== "undefined" && typeof document !== "undefined" ? new MediaEngine() : new NullEngine();
export function setEngine(e: Engine) { engine = e; }
