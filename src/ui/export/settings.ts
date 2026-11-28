// Export settings and their maths (Editroom's `ExportSettings`, Engine/Exporter.swift): output size per
// shape and resolution, whether the shape crops, bitrate and size estimates, and the engine options.
// ProRes (MOV) and MP3 are PromptEdit's own (Editroom had MP4 and WAV only): the usual ProRes 422
// family, and MP3 at a constant 320 or 192 kb/s.

import type { ExportOptions } from "../../engine";
import type { Project } from "../../model";
import { playRange, projectDuration } from "../../timing";

export type Format = "mp4" | "mov" | "wav" | "mp3";
export type ProresProfile = NonNullable<ExportOptions["proresProfile"]>;
export type Mp3Kbps = NonNullable<ExportOptions["mp3Kbps"]>;
export type Codec = "h264" | "hevc";
export type Quality = "high" | "web";
export type Shape = "original" | "vertical" | "square" | "portrait";

export interface ExportSettings {
  format: Format;
  /** Output height (the short side for crops); undefined keeps the sequence size. */
  height?: number;
  codec: Codec;
  quality: Quality;
  /** MOV: which ProRes. */
  prores: ProresProfile;
  /** MP3: constant bit rate. */
  mp3Kbps: Mp3Kbps;
  includeAudio: boolean;
  /** Target loudness in LUFS; undefined leaves levels as they are. */
  loudness?: number;
  shape: Shape;
  /** Which part of the picture a crop keeps: its centre, 0…1 across and down. */
  reframe: { x: number; y: number };
  rangeOnly: boolean;
}

export const defaultSettings = (p: Project): ExportSettings => ({
  format: "mp4", codec: "h264", quality: "high", prores: "standard", mp3Kbps: 320, includeAudio: true, shape: "original",
  reframe: { x: 0.5, y: 0.5 }, rangeOnly: playRange(p) !== undefined,
});

/** Formats with a picture. */
export const isVideo = (f: Format) => f === "mp4" || f === "mov";

export const FORMATS: [Format, string][] = [["mp4", "MP4 Video"], ["mov", "ProRes Video"], ["wav", "WAV Audio"], ["mp3", "MP3 Audio"]];
export const formatLabel = (f: Format) => FORMATS.find(([x]) => x === f)![1];

export const PRORES: [ProresProfile, string][] = [
  ["proxy", "ProRes 422 Proxy"], ["lt", "ProRes 422 LT"], ["standard", "ProRes 422"], ["hq", "ProRes 422 HQ"],
];
export const proresLabel = (p: ProresProfile) => PRORES.find(([x]) => x === p)![1];
export const MP3_RATES: Mp3Kbps[] = [320, 192];

/** Apple's target ProRes data rates at 1920 × 1080, 29.97 fps (Mb/s); they scale with pixels and frames. */
const PRORES_MBPS: Record<ProresProfile, number> = { proxy: 45, lt: 102, standard: 147, hq: 220 };

export function proresBitrate(profile: ProresProfile, size: { width: number; height: number }, fps: number): number {
  return Math.round(PRORES_MBPS[profile] * 1e6 * ((size.width * size.height) / (1920 * 1080)) * (fps / 29.97));
}

export const SHAPES: [Shape, string][] = [
  ["original", "Sequence shape"], ["vertical", "Vertical 9:16"], ["square", "Square 1:1"], ["portrait", "Portrait 4:5"],
];
/** Height over width, or undefined for the sequence's own shape. */
const tallness = (s: Shape) => (s === "vertical" ? 16 / 9 : s === "square" ? 1 : s === "portrait" ? 5 / 4 : undefined);

export const LOUDNESS: [string, number | undefined][] = [
  ["As mixed", undefined], ["−14 LUFS · web, YouTube", -14], ["−16 LUFS · podcasts", -16], ["−23 LUFS · broadcast", -23],
];
export const loudnessLabel = (v?: number) => (v === undefined ? "As mixed" : `${v} LUFS`.replace("-", "−"));

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export function renderSize(s: Pick<ExportSettings, "shape" | "height">, p: Project): { width: number; height: number } {
  const tall = tallness(s.shape);
  if (tall !== undefined) {
    // The resolution names the short side.
    const short = s.height ?? Math.min(p.width, p.height);
    return { width: even(short), height: even(short * tall) };
  }
  const h = s.height ?? p.height;
  return { width: even((h * p.width) / Math.max(1, p.height)), height: even(h) };
}

/** Whether the output crops the sequence's picture. */
export function crops(s: ExportSettings, p: Project): boolean {
  const o = renderSize(s, p);
  return Math.abs(o.width / o.height - p.width / p.height) > 0.01;
}

/** The Resolution menu: Source, then 4K…720p, sized for the current shape. */
export function resolutions(s: ExportSettings, p: Project): [string, number | undefined][] {
  const vertical = p.height > p.width;
  const base: [string, number][] = [["4K", 2160], ["1440p", 1440], ["1080p", 1080], ["720p", 720]];
  const src = renderSize({ shape: s.shape, height: undefined }, p);
  return [
    [`Source (${src.width} × ${src.height})`, undefined],
    ...base.map(([label, h]): [string, number] => {
      // A vertical sequence names its short side too.
      const height = s.shape === "original" && vertical ? Math.round((h * p.height) / p.width) : h;
      const o = renderSize({ shape: s.shape, height }, p);
      return [`${label} (${o.width} × ${o.height})`, height];
    }),
  ];
}

export function videoBitrate(s: ExportSettings, size: { width: number; height: number }, fps: number): number {
  let bpp = s.quality === "high" ? 0.2 : 0.085;
  if (s.codec === "hevc") bpp *= 0.62;
  return Math.round(size.width * size.height * Math.min(fps, 60) * bpp);
}

/** Seconds that will be exported. */
export function outputDuration(s: ExportSettings, p: Project): number {
  const r = s.rangeOnly ? playRange(p) : undefined;
  return r ? r[1] - r[0] : projectDuration(p);
}

/** Bits per second of the file. */
function fileBitrate(s: ExportSettings, p: Project): number {
  switch (s.format) {
    case "mp4": return videoBitrate(s, renderSize(s, p), p.fps) + (s.includeAudio ? 256_000 : 0);
    // The sound is 24-bit PCM beside the picture.
    case "mov": return proresBitrate(s.prores, renderSize(s, p), p.fps) + (s.includeAudio ? 48000 * 24 * 2 : 0);
    case "wav": return 48000 * 24 * 2;
    case "mp3": return s.mp3Kbps * 1000;
  }
}

export function estimatedSize(s: ExportSettings, p: Project): string {
  const bits = fileBitrate(s, p);
  const mb = (bits * outputDuration(s, p)) / 8 / 1_000_000;
  return mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${Math.round(Math.max(1, mb))} MB`;
}

export const extension = (s: ExportSettings): string => s.format;

/** "H.264 · 1080p" / "ProRes 422 HQ · 1080p" / "WAV" / "MP3 · 320 kbps": the export list's detail. */
export function kindLabel(s: ExportSettings, p: Project): string {
  if (s.format === "wav") return "WAV";
  if (s.format === "mp3") return `MP3 · ${s.mp3Kbps} kbps`;
  const codec = s.format === "mov" ? proresLabel(s.prores) : s.codec === "hevc" ? "HEVC" : "H.264";
  return `${codec} · ${renderSize(s, p).height}p`;
}

/** The part of the picture a crop keeps, as fractions of the picture's width and height. */
export function cropWindow(s: ExportSettings, p: Project): { w: number; h: number } {
  const o = renderSize(s, p);
  const oa = o.width / o.height, pa = p.width / p.height;
  return oa < pa ? { w: oa / pa, h: 1 } : { w: 1, h: pa / oa };
}

/**
 * The engine's reframe: how far the crop sits from centre, −1…1 of the room it has to move in each
 * direction (−1 = against the left/top edge, 1 = right/bottom).
 */
export function reframeOffset(s: ExportSettings, p: Project): { x: number; y: number } {
  const win = cropWindow(s, p);
  const off = (c: number, size: number) => (size >= 1 ? 0 : Math.max(-1, Math.min(1, (c - 0.5) / ((1 - size) / 2))));
  return { x: off(s.reframe.x, win.w), y: off(s.reframe.y, win.h) };
}

export function engineOptions(s: ExportSettings, p: Project, path: string): ExportOptions {
  const size = renderSize(s, p);
  const video = isVideo(s.format);
  return {
    path,
    format: s.format === "mp4" ? (s.codec === "hevc" ? "mp4-hevc" : "mp4-h264") : s.format === "mov" ? "mov-prores" : s.format,
    width: size.width,
    height: size.height,
    fps: p.fps,
    quality: s.quality,
    loudness: !video || s.includeAudio ? s.loudness : undefined,
    rangeOnly: s.rangeOnly && playRange(p) !== undefined,
    includeAudio: video ? s.includeAudio : true,
    reframe: video && crops(s, p) ? reframeOffset(s, p) : undefined,
    ...(s.format === "mov" ? { proresProfile: s.prores } : {}),
    ...(s.format === "mp3" ? { mp3Kbps: s.mp3Kbps } : {}),
  };
}
