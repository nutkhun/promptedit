// Waveforms (peaks, left, right, rms at 200 per second) made once per file by the Rust side in
// Editroom's `.wave` layout (docs/spec/02-engine.md §11.1), fetched and parsed here.

import { fileURL, mediaPath } from "../../api";
import type { Clip, MediaAsset } from "../../model";
import { backend } from "../backend";

export interface Waveform {
  peaksPerSecond: number;
  peaks: Float32Array;
  left: Float32Array;
  right: Float32Array;
  rms: Float32Array;
}

export function parseWave(buf: ArrayBuffer): Waveform | undefined {
  if (buf.byteLength < 20) return undefined;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46575245 || dv.getUint32(4, true) !== 1) return undefined;
  const pps = dv.getFloat64(8, true);
  const n = dv.getUint32(16, true);
  if (n === 0 || buf.byteLength !== 20 + 16 * n) return undefined;
  const arr = (k: number) => new Float32Array(buf.slice(20 + k * n * 4, 20 + (k + 1) * n * 4));
  return { peaksPerSecond: pps, peaks: arr(0), left: arr(1), right: arr(2), rms: arr(3) };
}

const reversedCopy = (w: Waveform): Waveform => ({
  peaksPerSecond: w.peaksPerSecond,
  peaks: w.peaks.slice().reverse(),
  left: w.left.slice().reverse(),
  right: w.right.slice().reverse(),
  rms: w.rms.slice().reverse(),
});

export class Waveforms {
  private loads = new Map<string, Promise<Waveform | undefined>>();
  private ready = new Map<string, Waveform | undefined>();
  private reversed = new Map<string, Waveform>();

  constructor(private onReady: () => void = () => {}) {}

  get(a: MediaAsset): Promise<Waveform | undefined> {
    const path = mediaPath(a);
    let p = this.loads.get(path);
    if (!p) {
      p = (async () => {
        if (!a.hasAudio && a.kind !== "audio") return undefined;
        const info = await backend.audioWaveform(path);
        const r = await fetch(fileURL(info.path));
        return parseWave(await r.arrayBuffer());
      })().catch(() => undefined).then((w) => {
        this.ready.set(path, w);
        this.onReady();
        return w;
      });
      this.loads.set(path, p);
    }
    return p;
  }

  /** The waveform if loaded (starting the load otherwise). */
  now(a: MediaAsset): Waveform | undefined {
    const path = mediaPath(a);
    if (!this.loads.has(path)) void this.get(a);
    return this.ready.get(path);
  }

  /** As Editroom's `media.waveform(clip)`: a reversed clip reads the arrays back to front. */
  forClip(a: MediaAsset | undefined, c: Clip): Waveform | undefined {
    if (!a) return undefined;
    const w = this.now(a);
    if (!w || c.reversed !== true) return w;
    const path = mediaPath(a);
    let r = this.reversed.get(path);
    if (!r) { r = reversedCopy(w); this.reversed.set(path, r); }
    return r;
  }
}
