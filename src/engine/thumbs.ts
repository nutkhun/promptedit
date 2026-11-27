// Thumbnails for filmstrips and library posters (docs/spec/02-engine.md §8.4): a file's own frame
// (no grade), upright, scaled to the asked height. Cached in memory (cleared at > 1500).

import type { Id } from "../model";
import type { Media } from "./decode/media";
import type { Rotation } from "./gl/compositor";

const MAX_ENTRIES = 1500;
/** Filmstrip frames may come from up to ±0.25 s away (a keyframe decodes on its own). */
const TOLERANCE = 0.25;

export class Thumbnails {
  private cache = new Map<string, Promise<ImageBitmap | undefined>>();
  /** One decode at a time per file, so a filmstrip's requests run in order on its thumbnail lane. */
  private queues = new Map<Id, Promise<unknown>>();

  constructor(private media: Media) {}

  get(asset: Id, time: number, height: number): Promise<ImageBitmap | undefined> {
    const h = Math.max(1, Math.round(height));
    const key = `${asset}|${Math.round(time * 1000)}|${h}`;
    let p = this.cache.get(key);
    if (p) return p;
    if (this.cache.size > MAX_ENTRIES) this.cache.clear();
    const prev = this.queues.get(asset) ?? Promise.resolve();
    p = prev.then(() => this.make(asset, time, h)).catch(() => undefined);
    this.queues.set(asset, p);
    this.cache.set(key, p);
    p.then((b) => { if (!b) this.cache.delete(key); });
    return p;
  }

  private async make(asset: Id, time: number, h: number): Promise<ImageBitmap | undefined> {
    const a = this.media.asset(asset);
    if (!a) return undefined;
    if (a.kind === "image") {
      const bmp = await this.media.still(asset);
      if (!bmp) return undefined;
      return createImageBitmap(bmp, { resizeHeight: h, resizeWidth: Math.max(1, Math.round((bmp.width * h) / bmp.height)), resizeQuality: "medium" });
    }
    if (a.kind !== "video") return undefined;
    const src = await this.media.video(asset);
    if (!src) return undefined;
    const rotation = await this.media.rotationAsync(asset);
    const t = Math.min(Math.max(0, time), Math.max(0, a.duration - 0.05));
    const frame = await src.thumbnailFrame(t, TOLERANCE);
    if (!frame) return undefined;
    try {
      return await upright(frame, rotation, h);
    } finally {
      frame.close();
    }
  }
}

async function upright(frame: VideoFrame, rotation: Rotation, h: number): Promise<ImageBitmap> {
  const fw = frame.displayWidth, fh = frame.displayHeight;
  const quarter = rotation % 180 !== 0;
  const [w0, h0] = quarter ? [fh, fw] : [fw, fh];
  const w = Math.max(1, Math.round((w0 * h) / h0));
  if (rotation === 0) return createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const [dw, dh] = quarter ? [h, w] : [w, h];
  ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
  return createImageBitmap(c);
}
