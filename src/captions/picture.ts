// The caption layer the compositor draws on top of every video track, in the viewer and in export
// (docs/spec/02-engine.md §9.3). Placed in the output frame: after the crop of a reframed export.

import type { CaptionStyle, Id, Project } from "../model";
import type { DrawLayer, Frame } from "../engine/gl/compositor";
import { EPS } from "../engine/layers";
import { projectCaptions } from "./blocks";
import type { CaptionBlock } from "./layout";
import { captionImage, captionLayers, layerAt, type CaptionLayer } from "./render";
import { captionedAssets } from "./layout";
import { fetchTranscript, useTranscripts } from "./store";

let memo: { blocks: CaptionBlock[]; style: CaptionStyle; layers: CaptionLayer[] } | undefined;
function layersFor(blocks: CaptionBlock[], style: CaptionStyle): CaptionLayer[] {
  if (memo && memo.blocks === blocks && memo.style === style) return memo.layers;
  const layers = captionLayers(blocks, style);
  memo = { blocks, style, layers };
  return layers;
}

/** The caption showing at frame time `frameTime`, as a layer for the compositor; none when hidden or silent. */
export function captionDrawLayer(p: Project, frameTime: number, f: Frame): DrawLayer | undefined {
  const track = p.captions;
  if (!track || track.hidden) return undefined;
  const layer = layerAt(layersFor(projectCaptions(p), track.style), frameTime + EPS);
  if (!layer) return undefined;
  const img = captionImage(layer, f.outWidth, f.outHeight);
  if (!img) return undefined;
  return {
    opacity: 1,
    picture: {
      kind: "texture", source: img.canvas, key: img.canvas, width: img.width, height: img.height, rotation: 0,
      // The compositor places pictures on the layout canvas; the output is the window at the offset.
      rect: { x: f.offsetX + img.x, y: f.offsetY + img.y, width: img.width, height: img.height },
    },
  };
}

/** Before an export: every captioned file's transcript read, so the captions are all there. */
export async function prepareCaptions(p: Project): Promise<void> {
  if (!p.captions || p.captions.hidden) return;
  await Promise.all(captionedAssets(p).map((id: Id) => fetchTranscript(id)));
}

/** Calls back when the captions on the picture may have changed without an edit (a transcript arrived). */
export function onCaptionsChanged(f: () => void): () => void {
  return useTranscripts.subscribe((s, prev) => { if (s.version !== prev.version) f(); });
}
