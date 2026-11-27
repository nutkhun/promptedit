// The viewer (docs/spec/04-ui.md §1.4): the picture, at the sequence's aspect, fitted or at a zoom
// level; the empty-timeline prompt; the label for a Media item being hover-scrubbed (or a trim edge);
// dragging the one selected clip to move it (one undo step); and the transport bar.
//
// The engine draws into the canvas given to `engine.attachViewer`. The viewer sizes the canvas's
// backing store to its displayed size × devicePixelRatio, and asks for the frame to show whenever the
// playhead, the timeline skimmer or the project changes while not playing (the engine moves the
// playhead itself during playback).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { engine } from "../engine";
import type { Clip, ClipTransform, Id } from "../model";
import { store, useStore } from "../store";
import { clamp, timecode, zoomedOffset } from "../timing";
import { EmptyPrompt } from "./viewer/EmptyPrompt";
import { Transport, type ViewerZoom } from "./viewer/Transport";
import "./viewer/viewer.css";

/** Follows the store into the engine: the frame under the playhead (or the timeline skimmer). */
function useFrameFollow() {
  useEffect(() => {
    const show = () => {
      const s = store();
      if (s.playing) return;
      if (s.skim && "asset" in s.skim) return; // a Media item is showing (Library → engine.showSource)
      if (s.skim) engine.showFrame(s.skim.time, true);
      else engine.showFrame(s.playhead);
    };
    show();
    return useStore.subscribe((s, p) => {
      if (s.playhead !== p.playhead || s.skim !== p.skim || s.project !== p.project || s.playing !== p.playing) show();
    });
  }, []);
}

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function Viewer() {
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const hasClips = useStore((s) => s.project.clips.length > 0);
  const hasMedia = useStore((s) => s.project.assets.length > 0);
  const viewerOnly = useStore((s) => s.viewerOnly);
  const [zoom, setZoom] = useState<ViewerZoom>(undefined);
  const [area, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useFrameFollow();

  const aspect = width / Math.max(1, height);
  const dpr = window.devicePixelRatio || 1;
  // 100% is one frame pixel per screen pixel.
  const w = zoom === undefined ? Math.max(0, Math.min(size.w, size.h * aspect)) : (width * zoom) / dpr;
  const h = w / aspect;
  const scrolls = w > size.w + 0.5 || h > size.h + 0.5;

  useEffect(() => {
    engine.attachViewer(canvas.current);
    return () => engine.attachViewer(null);
  }, []);
  useEffect(() => {
    const c = canvas.current;
    if (!c || w <= 0 || h <= 0) return;
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
      if (!store().playing) engine.showFrame(store().playhead);
    }
  }, [w, h, dpr]);

  return (
    <div className={`pe-viewer${viewerOnly ? " only" : ""}`}>
      <div className={`pe-picture-area${scrolls ? " scrolls" : ""}`} ref={area}>
        <div className="pe-picture-centre" style={scrolls ? { width: Math.max(w, size.w), height: Math.max(h, size.h) } : undefined}>
          <Picture w={w} h={h} canvas={canvas} hasClips={hasClips} hasMedia={hasMedia} />
        </div>
      </div>
      <Transport zoom={zoom} setZoom={setZoom} />
    </div>
  );
}

function Picture({ w, h, canvas, hasClips, hasMedia }: {
  w: number; h: number; canvas: React.RefObject<HTMLCanvasElement | null>; hasClips: boolean; hasMedia: boolean;
}) {
  const source = useStore((s) => (s.skim && "asset" in s.skim ? s.skim : undefined));
  const drag = useDirectManipulation(w, h);
  return (
    <div className="pe-picture" style={{ width: w, height: h }} {...drag}>
      <canvas ref={canvas} className="pe-canvas" />
      {!hasClips && !source && <EmptyPrompt hasMedia={hasMedia} />}
      {source && <SourceLabel asset={source.asset} time={source.time} note={source.note} />}
    </div>
  );
}

/** A Media item (or a trim edge) showing in the viewer, labelled so it isn't mistaken for the edit. */
function SourceLabel({ asset, time, note }: { asset: Id; time: number; note?: "In" | "Out" }) {
  const a = useStore((s) => s.project.assets.find((x) => x.id === asset));
  const style = useStore((s) => s.timeStyle);
  if (!a) return null;
  const fps = a.fps > 1 ? a.fps : 30;
  return (
    <div className="pe-source-label">
      {note ? <span className="note">{note}</span> : <span className="name">{a.name}</span>}
      <span className={`time mono${note ? " bright" : ""}`}>{timecode(time, fps, style)}</span>
    </div>
  );
}

// ---- Direct manipulation (§1.4) ----

const isIdentity = (t: ClipTransform) => t.scale === 1 && t.x === 0 && t.y === 0 && !t.zoom;

/**
 * With exactly one visual clip selected, dragging in the viewer moves it: a text clip's position (0…1),
 * or a picture's offset (snapping to centre within 5 pt; a picture that fills the frame can't be pulled
 * past its edge; whole frame pixels). Live edits while dragging, one undo step on release.
 */
function useDirectManipulation(w: number, h: number) {
  const drag = useRef<{ id: Id; x0: number; y0: number; sx: number; sy: number; started: boolean; clip: Clip } | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const queued = useRef<Clip | null>(null);

  const send = (c: Clip) => {
    queued.current = c;
    if (inflight.current) return;
    const pump = async () => {
      while (queued.current) {
        const next = queued.current;
        queued.current = null;
        const patch = next.kind === "text" ? { text: next.text } : { transform: next.transform && !isIdentity(next.transform) ? next.transform : null };
        await store().edit({ op: "update", ids: [next.id], patch }, true);
      }
      inflight.current = null;
    };
    inflight.current = pump();
  };

  const target = (): Clip | undefined => {
    const s = store();
    const visual = s.project.clips.filter((c) => s.selection.has(c.id) && c.kind !== "audio");
    return visual.length === 1 ? visual[0] : undefined;
  };

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || store().tool !== "select") return;
      const c = target();
      if (!c || (c.kind !== "text" && c.kind !== "video" && c.kind !== "image" && c.kind !== "solid")) return;
      const [sx, sy] = c.kind === "text" ? [c.text.x, c.text.y] : zoomedOffset(c.transform ?? { scale: 1, x: 0, y: 0 });
      drag.current = { id: c.id, x0: e.clientX, y0: e.clientY, sx, sy, started: false, clip: c };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || w <= 0 || h <= 0) return;
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (!d.started && Math.hypot(dx, dy) < 2) return;
      d.started = true;
      const c = d.clip;
      if (c.kind === "text") {
        send({ ...c, text: { ...c.text, x: clamp(d.sx + dx / w, 0, 1), y: clamp(d.sy + dy / h, 0, 1) } });
        return;
      }
      const p = store().project;
      const tf: ClipTransform = c.transform ?? { scale: 1, x: 0, y: 0 };
      let nx = d.sx + dx / w, ny = d.sy + dy / h;
      if (Math.abs(nx) * w < 5) nx = 0;
      if (Math.abs(ny) * h < 5) ny = 0;
      // Bigger than the frame ("fills", scale > 100%): it can't be pulled past the frame's edge.
      if (tf.scale > 1.001) {
        const m = (tf.scale - 1) / 2;
        nx = clamp(nx, -m, m);
        ny = clamp(ny, -m, m);
      }
      send({ ...c, transform: { ...tf, x: Math.round(nx * p.width) / p.width, y: Math.round(ny * p.height) / p.height } });
    },
    onPointerUp: async () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.started) return;
      while (inflight.current) await inflight.current;
      await store().commitLive();
    },
  };
}
