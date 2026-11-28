// Typed calls to the engine's Rust commands (src-tauri/src/render.rs). Big results come back
// as cache-file paths, read with `fileURL` (Range requests work in Tauri and the dev server).

import { invoke } from "@tauri-apps/api/core";
import { call, DEV_SERVER, inTauri } from "../api";

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
  /** "mov" finishes a ProRes job started with `exportVideoStart`. */
  container: "mp4" | "wav" | "mov" | "mp3";
  codec?: "h264" | "hevc";
  fpsNum?: number;
  fpsDen?: number;
  audioKbps?: number;
  gainDb?: number;
}

export type ProresProfile = "proxy" | "lt" | "standard" | "hq";

/** A picture encoded in Rust from raw frames (ProRes; see src-tauri/src/render/prores.rs). */
export interface VideoStart {
  codec: "prores";
  profile: ProresProfile;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  /** The loudness gain for the mix sent so far, which becomes the movie's sound. */
  gainDb: number;
}

/** The encoders FFmpeg has for the formats WebCodecs can't make. */
export interface Encoders { prores: "prores_videotoolbox" | "prores_ks" | null; mp3: boolean }

/** A command whose body is raw bytes (Tauri's raw-body invoke; the dev server's `/raw/<cmd>`). */
async function callRaw<T>(cmd: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string>): Promise<T> {
  if (inTauri) return invoke<T>(cmd, body, { headers });
  // As a Blob: Chromium uploads ArrayBuffer bodies about 10× slower (measured, 1080p frames).
  const r = await fetch(`${DEV_SERVER}/raw/${cmd}`, { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body: new Blob([body]) });
  const text = await r.text();
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw text || `${r.status} ${r.statusText}`; }
  if (!r.ok) throw v;
  return v as T;
}

export const backend = {
  audioPcm: (path: string, reversed: boolean, speed: number) => call<PcmInfo>("audio_pcm", { path, reversed, speed }),
  audioWaveform: (path: string) => call<WaveInfo>("audio_waveform", { path }),
  exportBegin: (path: string) => call<{ job: number }>("export_begin", { path }),
  exportAppend: (job: number, stream: "video" | "audio", data: string) => call<null>("export_append", { job, stream, data }),
  exportLoudness: (job: number) => call<Loudness | null>("export_loudness", { job }),
  exportFinish: (job: number, options: FinishOptions) => call<string>("export_finish", { job, options }),
  exportCancel: (job: number) => call<null>("export_cancel", { job }),
  exportEncoders: () => call<Encoders>("export_encoders"),
  exportVideoStart: (job: number, options: VideoStart) => call<null>("export_video_start", { job, options }),
  /** v210 frame bytes for a job started with `exportVideoStart`, in order. */
  exportFrames: (job: number, bytes: Uint8Array<ArrayBuffer>) => callRaw<null>("export_frames", bytes, { "x-export-job": String(job) }),
};

/** Base64 of bytes, in pieces so large buffers don't overflow the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  return btoa(s);
}
