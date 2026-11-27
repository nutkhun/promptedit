// MP4/MOV demuxing over HTTP Range requests: the top-level boxes are walked header by header
// until the `moov` is found, only `ftyp` + `moov` are read and parsed (mp4box.js), and sample
// bytes are fetched later on demand, a small window at a time. Whole files are never loaded.

import * as MP4BoxNS from "mp4box";
import type { ISOFile, MP4ArrayBuffer, Mp4Box, Mp4Trak } from "mp4box";

// mp4box is CommonJS: under Vite the namespace may arrive as `default`.
const MP4Box = ((MP4BoxNS as unknown as { default?: typeof MP4BoxNS }).default ?? MP4BoxNS) as typeof MP4BoxNS;
try { MP4Box.Log.setLogLevel(MP4Box.Log.error); } catch { /* older builds */ }

export interface Sample {
  offset: number;
  size: number;
  /** Presentation time, seconds (edit list applied). */
  pts: number;
  key: boolean;
}

export interface VideoTrack {
  /** WebCodecs codec string from the sample entry (e.g. avc1.64001f). */
  codec: string;
  description?: Uint8Array;
  codedWidth: number;
  codedHeight: number;
  /** Samples in decode order. */
  samples: Sample[];
  /** Presentation order → decode index. */
  byPts: Int32Array;
  /** Decode index → presentation index. */
  ptsRank: Int32Array;
  /** Presentation times sorted ascending (= samples[byPts[i]].pts). */
  ptsSorted: Float64Array;
  /** How far (in samples) decode order runs ahead of presentation order: B-frame depth. */
  reorder: number;
  /** Nominal frame duration, seconds. */
  frameDuration: number;
}

/** Reads bytes [start, end) of a URL with one Range request. */
export async function fetchRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<{ data: Uint8Array; total?: number }> {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if (!r.ok) throw new Error(`Couldn't read the file (${r.status}).`);
  const range = r.headers.get("content-range");
  const total = range ? Number(range.split("/")[1]) : undefined;
  if (r.status === 206) return { data: new Uint8Array(await r.arrayBuffer()), total };
  // The server ignored the range: read only as far as needed, then stop the download.
  const reader = r.body!.getReader();
  const out = new Uint8Array(end - start);
  let pos = 0, got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    const lo = Math.max(start, pos), hi = Math.min(end, pos + value.length);
    if (hi > lo) { out.set(value.subarray(lo - pos, hi - pos), lo - start); got += hi - lo; }
    pos += value.length;
    if (pos >= end) { reader.cancel().catch(() => {}); break; }
  }
  return { data: out.subarray(0, got), total: Number(r.headers.get("content-length") ?? 0) || undefined };
}

const fourcc = (d: Uint8Array, o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);

interface TopBox { type: string; start: number; size: number }

/** Walks the top-level boxes by their headers alone until `moov` is found. */
async function findBoxes(url: string): Promise<TopBox[]> {
  const boxes: TopBox[] = [];
  let pos = 0, total = Infinity;
  for (let guard = 0; guard < 4096 && pos < total; guard++) {
    const { data, total: t } = await fetchRange(url, pos, pos + 16);
    if (t !== undefined) total = t;
    if (data.length < 8) break;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let size = dv.getUint32(0);
    const type = fourcc(data, 4);
    if (size === 1) {
      if (data.length < 16) break;
      size = Number(dv.getBigUint64(8));
    } else if (size === 0) {
      size = (Number.isFinite(total) ? total : pos + 8) - pos;
    }
    if (size < 8) break;
    boxes.push({ type, start: pos, size });
    if (type === "moov") break;
    pos += size;
  }
  return boxes;
}

function boxBytes(box: Mp4Box): Uint8Array {
  const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8); // without the box header
}

function videoTrack(file: ISOFile, trak: Mp4Trak): VideoTrack {
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const ts = trak.mdia.mdhd.timescale;
  const movieScale = file.moov!.mvhd.timescale;
  // Edit list: leading empty edits delay the track; the first real edit says where media starts.
  let delay = 0, shift = 0;
  for (const e of trak.edts?.elst.entries ?? []) {
    if (e.media_time === -1) { delay += e.segment_duration / movieScale; continue; }
    shift = e.media_time;
    break;
  }
  const samples: Sample[] = trak.samples.map((s) => ({
    offset: s.offset, size: s.size, key: s.is_sync, pts: (s.cts - shift) / ts + delay,
  }));
  const n = samples.length;
  const byPts = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => samples[a].pts - samples[b].pts || a - b);
  const ptsRank = new Int32Array(n);
  byPts.forEach((d, p) => { ptsRank[d] = p; });
  let reorder = 0;
  for (let d = 0; d < n; d++) reorder = Math.max(reorder, d - ptsRank[d], ptsRank[d] - d);
  const ptsSorted = Float64Array.from(byPts, (d) => samples[d].pts);
  const frameDuration = n > 1 ? (ptsSorted[n - 1] - ptsSorted[0]) / (n - 1) : 1 / 30;
  const config = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  return {
    codec: entry.getCodec(),
    description: config ? boxBytes(config) : undefined,
    codedWidth: entry.width,
    codedHeight: entry.height,
    samples, byPts, ptsRank, ptsSorted, reorder, frameDuration,
  };
}

/** Opens an MP4/MOV file's first video track by reading only its `ftyp` and `moov`. */
export async function openVideoTrack(url: string): Promise<VideoTrack> {
  const boxes = await findBoxes(url);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("This file has no movie header.");
  const ftyp = boxes.find((b) => b.type === "ftyp");
  const parts = await Promise.all([ftyp, moov].filter((b): b is TopBox => !!b).map((b) => fetchRange(url, b.start, b.start + b.size)));
  const buf = new Uint8Array(parts.reduce((s, p) => s + p.data.length, 0 + (ftyp ? 0 : 24)));
  let at = 0;
  if (!ftyp) {
    // mp4box wants a file type box first; old QuickTime files may not have one.
    buf.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 2, 0, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]);
    at = 24;
  }
  for (const p of parts) { buf.set(p.data, at); at += p.data.length; }
  const file = MP4Box.createFile(false);
  let error: string | undefined;
  file.onError = (e) => { error = e; };
  const ab = buf.buffer as MP4ArrayBuffer;
  ab.fileStart = 0;
  file.appendBuffer(ab, true);
  file.flush();
  if (!file.moov) throw new Error(error ?? "Couldn't read the movie header.");
  const trak = file.moov.traks.find((t) => t.mdia.hdlr.handler === "vide" && t.samples.length > 0);
  if (!trak) throw new Error("No picture in this file.");
  return videoTrack(file, trak);
}

/**
 * Fetches sample bytes in windows (a run of consecutive samples, ≤ 2 MB), keeping the last few
 * windows, so decoding forward through a GOP costs a handful of requests.
 */
export class SampleReader {
  private windows: { first: number; last: number; base: number; data: Promise<Uint8Array> }[] = [];

  constructor(private url: string, private samples: Sample[]) {}

  async get(i: number): Promise<Uint8Array> {
    let w = this.windows.find((x) => i >= x.first && i <= x.last);
    if (!w) {
      const s = this.samples;
      const base = s[i].offset;
      let last = i, end = base + s[i].size;
      while (last + 1 < s.length && last - i < 48) {
        const n = s[last + 1];
        if (n.offset < end || n.offset + n.size - base > 2 * 1024 * 1024) break;
        last++;
        end = n.offset + n.size;
      }
      w = { first: i, last, base, data: fetchRange(this.url, base, end).then((r) => r.data) };
      this.windows.push(w);
      if (this.windows.length > 6) this.windows.shift();
      w.data.catch(() => { this.windows = this.windows.filter((x) => x !== w); });
    }
    const data = await w.data;
    const s = this.samples[i];
    return data.subarray(s.offset - w.base, s.offset - w.base + s.size);
  }
}
