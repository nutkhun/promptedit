// Typed calls to the engine's Rust commands (src-tauri/src/render.rs). Big results come back
// as cache-file paths, read with `fileURL` (Range requests work in Tauri and the dev server).

import { call } from "../api";

export interface PcmInfo {
  path: string;
  frames: number;
  rate: number;
  channels: number;
  duration: number;
}

export interface WaveInfo { path: string; count: number; peaksPerSecond: number }
export interface Loudness { lufs: number; peakDb: number }

export interface FinishOptions {
  container: "mp4" | "wav";
  codec?: "h264" | "hevc";
  fpsNum?: number;
  fpsDen?: number;
  audioKbps?: number;
  gainDb?: number;
}

export const backend = {
  audioPcm: (path: string, reversed: boolean, speed: number) => call<PcmInfo>("audio_pcm", { path, reversed, speed }),
  audioWaveform: (path: string) => call<WaveInfo>("audio_waveform", { path }),
  exportBegin: (path: string) => call<{ job: number }>("export_begin", { path }),
  exportAppend: (job: number, stream: "video" | "audio", data: string) => call<null>("export_append", { job, stream, data }),
  exportLoudness: (job: number) => call<Loudness | null>("export_loudness", { job }),
  exportFinish: (job: number, options: FinishOptions) => call<string>("export_finish", { job, options }),
  exportCancel: (job: number) => call<null>("export_cancel", { job }),
};

/** Base64 of bytes, in pieces so large buffers don't overflow the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  return btoa(s);
}
