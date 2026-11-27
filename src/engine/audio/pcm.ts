// Streaming access to the PCM caches the Rust side makes (f32le, 48 kHz, stereo interleaved):
// one-second blocks fetched with Range requests and kept in a bounded LRU, so long files never
// sit in memory whole.

import { fileURL } from "../../api";
import { backend, type PcmInfo } from "../backend";
import { fetchRange } from "../decode/demux";

export const RATE = 48000;
const BLOCK = RATE; // frames per block
const MAX_BLOCKS = 240; // ≈ 90 MB at most

export interface PcmVariant { path: string; reversed: boolean; speed: number }

const variantKey = (v: PcmVariant) => `${v.path}|${v.reversed ? 1 : 0}|${v.speed.toFixed(5)}`;

export class PcmStore {
  private infos = new Map<string, Promise<PcmInfo | undefined>>();
  private ready = new Map<string, PcmInfo | undefined>();
  private blocks = new Map<string, Float32Array>();
  private loading = new Map<string, Promise<Float32Array | undefined>>();

  /** The cache file for a variant (made on first request). */
  info(v: PcmVariant): Promise<PcmInfo | undefined> {
    const k = variantKey(v);
    let p = this.infos.get(k);
    if (!p) {
      p = backend.audioPcm(v.path, v.reversed, v.speed).then(
        (info) => { this.ready.set(k, info); return info; },
        () => { this.ready.set(k, undefined); return undefined; },
      );
      this.infos.set(k, p);
    }
    return p;
  }

  infoNow(v: PcmVariant): PcmInfo | undefined {
    const k = variantKey(v);
    if (!this.infos.has(k)) void this.info(v);
    return this.ready.get(k);
  }

  private blockKey(info: PcmInfo, i: number) {
    return `${info.path}#${i}`;
  }

  block(info: PcmInfo, i: number): Promise<Float32Array | undefined> {
    const k = this.blockKey(info, i);
    const hit = this.blocks.get(k);
    if (hit) return Promise.resolve(hit);
    let p = this.loading.get(k);
    if (!p) {
      const start = i * BLOCK, end = Math.min(info.frames, start + BLOCK);
      p = end <= start
        ? Promise.resolve(new Float32Array(0))
        : fetchRange(fileURL(info.path), start * 8, end * 8).then((r) => {
          const bytes = r.data;
          // Copy to an aligned buffer before viewing as floats.
          const out = new Float32Array(Math.floor(bytes.length / 4));
          new Uint8Array(out.buffer).set(bytes.subarray(0, out.length * 4));
          return out;
        });
      p = p.then((data) => {
        this.loading.delete(k);
        if (data) {
          this.blocks.set(k, data);
          if (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
        }
        return data;
      }, () => { this.loading.delete(k); return undefined; });
      this.loading.set(k, p);
    }
    return p;
  }

  blockNow(info: PcmInfo, i: number): Float32Array | undefined {
    const k = this.blockKey(info, i);
    const hit = this.blocks.get(k);
    if (hit) {
      // Refresh its place in the LRU.
      this.blocks.delete(k);
      this.blocks.set(k, hit);
      return hit;
    }
    void this.block(info, i);
    return undefined;
  }

  /**
   * Interleaved frames [start, start+count) if every block they need is loaded (zeros outside
   * the file), else undefined (and the missing blocks start loading).
   */
  readNow(info: PcmInfo, start: number, count: number): Float32Array | undefined {
    const out = new Float32Array(count * 2);
    const lo = Math.max(0, start), hi = Math.min(info.frames, start + count);
    let ok = true;
    for (let b = Math.floor(lo / BLOCK); b * BLOCK < hi; b++) {
      const data = this.blockNow(info, b);
      if (!data) { ok = false; continue; }
      const a = Math.max(lo, b * BLOCK), z = Math.min(hi, (b + 1) * BLOCK);
      out.set(data.subarray((a - b * BLOCK) * 2, (z - b * BLOCK) * 2), (a - start) * 2);
    }
    return ok ? out : undefined;
  }

  /** As readNow, waiting for the blocks. */
  async read(info: PcmInfo, start: number, count: number): Promise<Float32Array> {
    const lo = Math.max(0, start), hi = Math.min(info.frames, start + count);
    const waits: Promise<unknown>[] = [];
    for (let b = Math.floor(lo / BLOCK); b * BLOCK < hi; b++) waits.push(this.block(info, b));
    await Promise.all(waits);
    // Blocks just loaded can't have been evicted unless the read is enormous; fall back to zeros.
    return this.readNow(info, start, count) ?? new Float32Array(count * 2);
  }
}
