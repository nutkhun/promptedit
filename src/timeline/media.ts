// Synchronous caches over the engine's async thumbnails and waveforms, for drawing. A miss asks
// the engine once and repaints when the answer arrives; a miss the engine can't fill yet (the
// placeholder engine returns undefined) is retried later rather than every frame.

import { engine } from "../engine";
import type { Engine } from "../engine";
import type { Id } from "../model";

const RETRY_MS = 3000;
const MAX_THUMBS = 1500;

type Entry<T> = { value?: T; pending: boolean; failedAt?: number };

let owner: Engine | undefined;
const thumbs = new Map<string, Entry<ImageBitmap>>();
const waves = new Map<Id, Entry<Float32Array>>();
const listeners = new Set<() => void>();

/** Called when something new can be drawn. */
export function onMediaUpdate(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

let notifyQueued = false;
function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    listeners.forEach((f) => f());
  });
}

/** A new engine (the real one replacing the placeholder) invalidates every miss. */
function checkEngine() {
  if (owner === engine) return;
  owner = engine;
  thumbs.clear();
  waves.clear();
}

function lookup<K, T>(map: Map<K, Entry<T>>, key: K, load: () => Promise<T | undefined>): T | undefined {
  const hit = map.get(key);
  if (hit) {
    if (hit.value !== undefined || hit.pending) return hit.value;
    if (hit.failedAt !== undefined && performance.now() - hit.failedAt < RETRY_MS) return undefined;
  }
  const entry: Entry<T> = { pending: true };
  map.set(key, entry);
  const from = engine;
  load().then(
    (v) => {
      if (from !== engine) return;
      entry.pending = false;
      if (v === undefined) entry.failedAt = performance.now();
      else {
        entry.value = v;
        notify();
      }
    },
    () => {
      entry.pending = false;
      entry.failedAt = performance.now();
    },
  );
  return undefined;
}

/** Thumbnail heights are bucketed so row zooming doesn't refetch every pixel step. */
export const thumbHeight = (px: number) => Math.max(32, Math.min(256, Math.ceil(px / 32) * 32));

const thumbKey = (asset: Id, time: number, height: number) => `${asset}|${Math.round(time * 1000)}|${height}`;

/** A frame of a file, or undefined until it's made (asks for it). */
export function thumbnail(asset: Id, time: number, height: number): ImageBitmap | undefined {
  checkEngine();
  if (thumbs.size > MAX_THUMBS) {
    // Oldest first (Map keeps insertion order); the engine keeps its own cache behind this one.
    let drop = thumbs.size - MAX_THUMBS * 0.8;
    for (const k of thumbs.keys()) {
      if (drop-- <= 0) break;
      thumbs.delete(k);
    }
  }
  return lookup(thumbs, thumbKey(asset, time, height), () => engine.thumbnail(asset, time, height));
}

/** A frame already made, without asking for one (stand-ins while a neighbour loads). */
export function cachedThumbnail(asset: Id, time: number, height: number): ImageBitmap | undefined {
  return thumbs.get(thumbKey(asset, time, height))?.value;
}

/** Loudness envelope (RMS per 1/200 s, 0…1), or undefined until it's made. */
export function waveform(asset: Id): Float32Array | undefined {
  checkEngine();
  return lookup(waves, asset, () => engine.waveform(asset));
}

/** Envelope samples per second of the file. */
export const WAVE_RATE = 200;
