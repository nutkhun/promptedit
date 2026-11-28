// Raw Y′CbCr planes of a decoded frame, for HDR and Log sources (docs/spec/02-engine.md §3.7).
//
// Why: a browser drawing an HDR VideoFrame converts it its own way (each engine tone-maps
// differently, and Chromium clips PQ to garbage when it colour-manages). `VideoFrame.copyTo` with no
// format hands over the decoder's own samples (10-bit stays 10-bit), which our shader turns into
// R′G′B′ with the file's matrix before the source cube.
//
// What engines give (checked in Chromium 158 on Linux, software decode; see docs/PARITY.md):
// H.264 High 10, VP9 profile 2 and AV1 10-bit arrive as `I420P10` in CPU memory and copy exactly.
// Hardware frames (Windows Media Foundation HEVC Main 10 as P010, macOS VideoToolbox 10-bit
// biplanar) may report `format === null`, which `copyTo` can't copy raw: those fall back to the
// browser's own Y′CbCr→R′G′B′ (texture upload with colour conversion off), see Compositor.

export type PlaneFormat =
  | "I420" | "I420P10" | "I420P12" | "I422" | "I422P10" | "I422P12" | "I444" | "I444P10" | "I444P12" | "NV12";

export interface PlaneInfo {
  /** Chroma subsampling: horizontal and vertical factor (2 = half). */
  sx: 1 | 2;
  sy: 1 | 2;
  bits: 8 | 10 | 12;
  /** Cb and Cr interleaved in one plane (NV12). */
  interleaved: boolean;
}

const INFO: Record<PlaneFormat, PlaneInfo> = {
  I420: { sx: 2, sy: 2, bits: 8, interleaved: false },
  I420P10: { sx: 2, sy: 2, bits: 10, interleaved: false },
  I420P12: { sx: 2, sy: 2, bits: 12, interleaved: false },
  I422: { sx: 2, sy: 1, bits: 8, interleaved: false },
  I422P10: { sx: 2, sy: 1, bits: 10, interleaved: false },
  I422P12: { sx: 2, sy: 1, bits: 12, interleaved: false },
  I444: { sx: 1, sy: 1, bits: 8, interleaved: false },
  I444P10: { sx: 1, sy: 1, bits: 10, interleaved: false },
  I444P12: { sx: 1, sy: 1, bits: 12, interleaved: false },
  NV12: { sx: 2, sy: 2, bits: 8, interleaved: true },
};

export function planeInfo(format: string | null): PlaneInfo | undefined {
  return format && format in INFO ? INFO[format as PlaneFormat] : undefined;
}

/** How to turn the samples into R′G′B′. */
export interface YuvColor {
  /** Luma coefficients (Kr, Kb) of the file's matrix. */
  k: [number, number];
  fullRange: boolean;
}

export interface YuvPlanes extends YuvColor {
  info: PlaneInfo;
  /** Visible picture size in samples (the luma plane). */
  width: number;
  height: number;
  data: Uint8Array;
  layout: PlaneLayout[];
  /** Hands the buffer back to the pool once drawn. */
  close(): void;
}

/** Buffers are reused frame to frame (a 4K 10-bit frame is 24 MB). */
const pool = new Map<number, Uint8Array[]>();
const POOL_PER_SIZE = 6;

function take(size: number): Uint8Array {
  return pool.get(size)?.pop() ?? new Uint8Array(size);
}

function give(buf: Uint8Array) {
  let list = pool.get(buf.byteLength);
  if (!list) {
    // Only a couple of frame sizes are live at once; forget the others.
    if (pool.size > 4) pool.clear();
    list = [];
    pool.set(buf.byteLength, list);
  }
  if (list.length < POOL_PER_SIZE) list.push(buf);
}

/** The frame's samples as they came from the decoder, or undefined when it can't hand them over. */
export async function copyPlanes(frame: VideoFrame, color: YuvColor): Promise<YuvPlanes | undefined> {
  const info = planeInfo(frame.format);
  const rect = frame.visibleRect;
  if (!info || !rect) return undefined;
  let buf: Uint8Array | undefined;
  try {
    buf = take(frame.allocationSize());
    const layout = await frame.copyTo(buf);
    const data = buf;
    let closed = false;
    return {
      ...color, info, data, layout, width: rect.width, height: rect.height,
      close: () => { if (!closed) { closed = true; give(data); } },
    };
  } catch {
    if (buf) give(buf);
    return undefined;
  }
}
