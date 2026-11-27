// Turns evaluated layers (layers.ts) into pictures the compositor can draw: decoded frames,
// stills, text bitmaps and solid colours, each placed on the layout canvas (fit, §1.2 step 3).

import type { Media } from "./decode/media";
import type { DecodeMode, Lane } from "./decode/video-source";
import type { DrawLayer, Rect, Rotation } from "./gl/compositor";
import type { GradeBaker } from "./grade";
import type { Layer } from "./layers";
import { textImage } from "./text";

/** Aspect-fit a w×h picture into the canvas, centred (areas outside stay transparent). */
export function fitInto(W: number, H: number, w: number, h: number): Rect {
  const s = Math.min(W / w, H / h);
  return { x: (W - w * s) / 2, y: (H - h * s) / 2, width: w * s, height: h * s };
}

export interface Resolved {
  layers: DrawLayer[];
  /** Frames to close once drawn. */
  frames: VideoFrame[];
  /** False when some picture wasn't available (yet): draw again when it arrives. */
  complete: boolean;
  /** Decoder lanes used, per file (so look-ahead decoding uses other lanes). */
  busy: Map<string, Set<Lane>>;
}

export async function resolveLayers(
  layers: Layer[], media: Media, baker: GradeBaker, canvas: { width: number; height: number },
  mode: DecodeMode, keyPrefix = "", onCubeReady?: () => void, busyIn?: Map<string, Set<Lane>>,
): Promise<Resolved> {
  const W = canvas.width, H = canvas.height;
  const busy = new Map<string, Set<Lane>>(busyIn ?? []);
  let complete = true;
  const frames: VideoFrame[] = [];
  const out = await Promise.all(layers.map(async (l): Promise<DrawLayer | undefined> => {
    const base = { opacity: l.opacity, wipe: l.wipe, transform: l.transform, cube: baker.cube(l.grade, onCubeReady) };
    const s = l.source;
    switch (s.kind) {
      case "solid":
        return { ...base, picture: { kind: "solid", color: [s.color.r, s.color.g, s.color.b, s.color.a] } };
      case "text": {
        const img = textImage(s.style, W, H);
        if (!img) return undefined;
        return {
          ...base,
          picture: { kind: "texture", source: img.canvas, key: img.canvas, width: img.width, height: img.height, rotation: 0,
            rect: { x: img.x, y: img.y, width: img.width, height: img.height } },
        };
      }
      case "image": {
        const bmp = mode === "play" ? media.stillNow(s.asset) : await media.still(s.asset);
        if (!bmp) { complete = false; return undefined; }
        return {
          ...base,
          picture: { kind: "texture", source: bmp, key: bmp, width: bmp.width, height: bmp.height, rotation: 0, rect: fitInto(W, H, bmp.width, bmp.height) },
        };
      }
      case "video": {
        const src = mode === "play" ? media.videoNow(s.pick.asset) : await media.video(s.pick.asset);
        if (!src) { complete = false; return undefined; }
        let set = busy.get(s.pick.asset);
        if (!set) { set = new Set(); busy.set(s.pick.asset, set); }
        const rotation: Rotation = mode === "play" ? media.rotation(s.pick.asset) : await media.rotationAsync(s.pick.asset);
        const frame = await src.frame(s.pick, mode, keyPrefix + l.clipID, set);
        if (!frame) { complete = false; return undefined; }
        frames.push(frame);
        if (mode === "play" && Math.abs(frame.timestamp / 1e6 - src.ptsOf(src.indexFor(s.pick))) > 1e-4) complete = false;
        const fw = frame.displayWidth, fh = frame.displayHeight;
        const [w, h] = rotation % 180 === 0 ? [fw, fh] : [fh, fw];
        return { ...base, picture: { kind: "texture", source: frame, width: w, height: h, rotation, rect: fitInto(W, H, w, h) } };
      }
    }
  }));
  return { layers: out.filter((x): x is DrawLayer => !!x), frames, complete, busy };
}
