// Export settings and their maths (Editroom's `ExportSettings`, Engine/Exporter.swift): output size per
// shape and resolution, whether the shape crops, bitrate and size estimates, and the engine options.

import type { ExportOptions } from "../../engine";
import type { Project } from "../../model";
import { playRange, projectDuration } from "../../timing";

export type Format = "mp4" | "wav";
export type Codec = "h264" | "hevc";
export type Quality = "high" | "web";
export type Shape = "original" | "vertical" | "square" | "portrait";

export interface ExportSettings {
  format: Format;
  /** Output height (the short side for crops); undefined keeps the sequence size. */
  height?: number;
  codec: Codec;
  quality: Quality;
  includeAudio: boolean;
  /** Target loudness in LUFS; undefined leaves levels as they are. */
  loudness?: number;
  shape: Shape;
  /** Which part of the picture a crop keeps: its centre, 0…1 across and down. */
  reframe: { x: number; y: number };
  rangeOnly: boolean;
}

export const defaultSettings = (p: Project): ExportSettings => ({
  format: "mp4", codec: "h264", quality: "high", includeAudio: true, shape: "original",
  reframe: { x: 0.5, y: 0.5 }, rangeOnly: playRange(p) !== undefined,
});

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

export function estimatedSize(s: ExportSettings, p: Project): string {
  const bits = s.format === "mp4"
    ? videoBitrate(s, renderSize(s, p), p.fps) + (s.includeAudio ? 256_000 : 0)
    : 48000 * 24 * 2;
  const mb = (bits * outputDuration(s, p)) / 8 / 1_000_000;
  return mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${Math.round(Math.max(1, mb))} MB`;
}

export const extension = (s: ExportSettings) => (s.format === "mp4" ? "mp4" : "wav");

/** "H.264 · 1080p" / "WAV": the export list's detail. */
export function kindLabel(s: ExportSettings, p: Project): string {
  if (s.format === "wav") return "WAV";
  return `${s.codec === "hevc" ? "HEVC" : "H.264"} · ${renderSize(s, p).height}p`;
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
  return {
    path,
    format: s.format === "wav" ? "wav" : s.codec === "hevc" ? "mp4-hevc" : "mp4-h264",
    width: size.width,
    height: size.height,
    fps: p.fps,
    quality: s.quality,
    loudness: s.format === "wav" || s.includeAudio ? s.loudness : undefined,
    rangeOnly: s.rangeOnly && playRange(p) !== undefined,
    includeAudio: s.format === "wav" ? true : s.includeAudio,
    reframe: s.format === "mp4" && crops(s, p) ? reframeOffset(s, p) : undefined,
  };
}
