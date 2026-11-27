// A Media item's picture (LibraryView.swift `MediaThumb`): its poster frame, or a symbol until there
// is one; moving across a video's picture scrubs through it, shows that frame full size in the viewer
// (labelled there, §1.4) and marks the position with a thin white line.

import { useEffect, useRef, useState } from "react";
import { fileURL, mediaPath } from "../../api";
import { engine } from "../../engine";
import type { MediaAsset } from "../../model";
import { store } from "../../store";
import { Glyph } from "../icons";

/** Hover-scrub frames are quantised to 60 positions so nearby ones share cached frames. */
const SCRUB_STEPS = 60;

/** Where a poster is taken from: a little way in, past black openings. */
const posterTime = (a: MediaAsset) => (a.kind === "video" ? Math.min(1, a.duration * 0.1) : 0);

function useBitmap(asset: MediaAsset, time: number | undefined, height: number) {
  const [bitmap, setBitmap] = useState<ImageBitmap>();
  useEffect(() => {
    if (time === undefined || asset.kind !== "video") return;
    let live = true;
    engine.thumbnail(asset.id, time, height).then((b) => { if (live && b) setBitmap(b); }).catch(() => {});
    return () => { live = false; };
  }, [asset.id, asset.kind, time, height]);
  return bitmap;
}

function BitmapCanvas({ bitmap }: { bitmap: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d")?.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={ref} className="pe-thumb-fill" />;
}

export function MediaThumb({ asset, offline, compact = false }: { asset: MediaAsset; offline: boolean; compact?: boolean }) {
  const height = compact ? 72 : 108;
  const poster = useBitmap(asset, posterTime(asset), height);
  const [scrub, setScrub] = useState<{ x: number; t: number }>();
  const scrubFrame = useBitmap(asset, scrub?.t, height);
  const [imageFailed, setImageFailed] = useState(false);
  const scrubbable = asset.kind === "video" && !offline && asset.duration > 0;

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbable || e.buttons) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(0, e.clientX - r.left), r.width);
    const f = x / Math.max(1, r.width);
    const t = Math.max(0, Math.min(asset.duration - 0.05, (Math.round(f * SCRUB_STEPS) / SCRUB_STEPS) * asset.duration));
    setScrub({ x, t });
    // The main viewer shows it too, full size and in playback's colours.
    const exact = Math.max(0, Math.min(asset.duration - 0.02, f * asset.duration));
    store().set({ skim: { asset: asset.id, time: exact } });
    engine.showSource({ asset: asset.id, time: exact });
  };
  const leave = () => {
    if (!scrub) return;
    setScrub(undefined);
    const s = store();
    if (s.skim && "asset" in s.skim) s.set({ skim: undefined });
    engine.showSource(undefined);
  };
  // Leaving the panel mid-scrub (a drag starting) still lets the viewer go back.
  useEffect(() => () => { if (scrub) engine.showSource(undefined); }, [scrub]);

  const shown = scrub && scrubFrame ? scrubFrame : poster;
  return (
    <div className="pe-thumb" onPointerMove={move} onPointerLeave={leave} onDragStart={leave}>
      {shown ? (
        <BitmapCanvas bitmap={shown} />
      ) : asset.kind === "image" && !offline && !imageFailed ? (
        <img className="pe-thumb-fill" src={fileURL(mediaPath(asset))} alt="" draggable={false} loading="lazy" onError={() => setImageFailed(true)} />
      ) : (
        <span className={`pe-thumb-symbol${asset.kind === "audio" ? " audio" : ""}`}>
          <Glyph symbol={asset.kind === "audio" ? "waveform" : asset.kind === "image" ? "photo" : "film"} size={compact ? 13 : 20} weight="regular" />
        </span>
      )}
      {offline && (
        <span className="pe-thumb-offline"><Glyph symbol="exclamationmark.triangle.fill" size={compact ? 11 : 13} /></span>
      )}
      {scrub && <span className="pe-thumb-scrub" style={{ left: scrub.x - 0.75 }} />}
    </div>
  );
}
