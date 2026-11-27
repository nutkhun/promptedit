// The timeline panel (docs/spec/04-ui.md §1.6): toolbar, track headers, the clip canvas with its
// playhead overlay, and the zoom/scroll and row-scale bars.

import type { Payload } from "../model";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Id, Project } from "../model";
import { store, useStore } from "../store";
import { Toolbar } from "./Toolbar";
import { TrackHeaders } from "./TrackHeaders";
import { RowScaleBar, ZoomScrollBar } from "./Bars";
import { MenuHost } from "./ContextMenu";
import { MarkerPanel, openMarkerPanel } from "./MarkerPanel";
import { fitRows } from "./viewMath";
import { timeline } from "./controller";
import { onMediaUpdate } from "./media";
import { onPaletteChange } from "./palette";
import { useCaptions } from "./captions";
import { startMeters } from "./meters";
import "./timeline.css";

export { zoomIn, zoomOut, zoomToFit, selectAll } from "./actions";
export { openMarkerPanel } from "./MarkerPanel";
export { timeline } from "./controller";

const PLAYHEAD_WIDTH = 16;

/** No track in common: a different project was opened (or created), not an edit of this one. */
function isAnotherProject(a: Project, b: Project) {
  const ids = new Set([...a.videoTracks, ...a.audioTracks].map((t) => t.id));
  return ![...b.videoTracks, ...b.audioTracks].some((t) => ids.has(t.id));
}

/** Accent cap 11 wide from y 5 (3 pt rounded top corners), straight to 13, a point at 19, then a 1 pt stem. */
function playheadPath(height: number) {
  const mid = PLAYHEAD_WIDTH / 2, l = mid - 5.5, r = mid + 5.5, top = 5, shoulder = 13, tip = 19, rad = 3;
  return `M${l} ${top + rad}Q${l} ${top} ${l + rad} ${top}L${r - rad} ${top}Q${r} ${top} ${r} ${top + rad}L${r} ${shoulder}`
    + `L${mid + 0.5} ${tip}L${mid + 0.5} ${height}L${mid - 0.5} ${height}L${mid - 0.5} ${tip}L${l} ${shoulder}Z`;
}

function Canvas() {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const playheadSvg = useRef<SVGPathElement>(null);
  const fitted = useRef(false);

  useLayoutEffect(() => {
    timeline.attach(canvas.current);
    timeline.onOpenMarker = (id: Id) => {
      const rect = canvas.current?.getBoundingClientRect();
      const x = timeline.markerX(id);
      if (rect && x !== undefined) openMarkerPanel(id, { x: rect.left + x, y: rect.top });
    };
    return () => timeline.attach(null);
  }, []);

  // Size: the canvas reports its size into the view (the scroll limits depend on it); the first
  // real size fits the rows to the panel, as Editroom does at launch.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      timeline.resize(w, h);
      const s = store();
      if (!fitted.current) {
        fitted.current = true;
        s.set({ view: fitRows(s.project, { ...s.view, viewWidth: w, viewHeight: h }) });
      } else s.setView({ viewWidth: w, viewHeight: h });
      if (playheadSvg.current) playheadSvg.current.setAttribute("d", playheadPath(h));
      placePlayhead();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Repaint on whatever the canvas shows; the playhead moves on its own without a repaint.
  useEffect(() => {
    let prev = store();
    const unsub = useStore.subscribe((s) => {
      // Take the previous state first: setView below re-enters this listener synchronously.
      const before = prev;
      prev = s;
      if (s.project !== before.project) {
        if (isAnotherProject(before.project, s.project)) {
          // A project opening (or the first one arriving at launch) fits its rows to the panel.
          s.set({ view: fitRows(s.project, s.view) });
        } else {
          // A longer or shorter edit, or another track, changes how far the view may scroll.
          s.setView({});
        }
        timeline.invalidate();
      } else if (s.view !== before.view || s.selection !== before.selection || s.thumbnails !== before.thumbnails
        || s.skim !== before.skim || s.tool !== before.tool || s.timeStyle !== before.timeStyle || s.theme !== before.theme) {
        timeline.invalidate();
      }
      if (s.playhead !== before.playhead || s.view !== before.view || s.playing !== before.playing) placePlayhead();
    });
    const offMedia = onMediaUpdate(timeline.invalidate);
    const offPalette = onPaletteChange(timeline.invalidate);
    const offCaptions = useCaptions.subscribe(timeline.invalidate);
    const offMeters = startMeters();
    return () => {
      unsub();
      offMedia();
      offPalette();
      offCaptions();
      offMeters();
    };
  }, []);

  // A playhead running off screen while playing brings the view along (48 pt from the left).
  function placePlayhead() {
    const el = playhead.current;
    if (!el) return;
    const s = store();
    let px = s.playhead * s.view.pps - s.view.scrollX;
    if (s.playing && (px > timeline.width - 28 || px < 0)) {
      s.setView({ scrollX: s.playhead * s.view.pps - 48 });
      px = s.playhead * store().view.pps - store().view.scrollX;
    }
    const hidden = px < -PLAYHEAD_WIDTH || px > timeline.width + PLAYHEAD_WIDTH;
    el.style.display = hidden ? "none" : "block";
    el.style.transform = `translateX(${Math.round((px - PLAYHEAD_WIDTH / 2) * 2) / 2}px)`;
  }

  // Pointer handling: the canvas captures the pointer for the length of a drag.
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Right-click and ⌃-click are context menus.
    if (e.button !== 0 || (e.ctrlKey && /Mac/.test(navigator.platform))) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    host.current?.closest<HTMLElement>(".tl-body")?.focus({ preventScroll: true });
    const p = local(e);
    timeline.pointerDown(p.x, p.y, e.nativeEvent);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    timeline.pointerMove(p.x, p.y, e.nativeEvent);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const p = local(e);
    timeline.pointerUp(p.x, p.y);
  };

  return (
    <div ref={host} className="tl-canvas-host">
      <canvas ref={canvas} className="tl-canvas"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={() => timeline.cancelDrag()}
        onPointerLeave={() => timeline.pointerLeave()}
        onContextMenu={(e) => {
          e.preventDefault();
          const p = local(e);
          timeline.contextMenu(p.x, p.y, e.clientX, e.clientY);
        }} />
      <div ref={playhead} className="tl-playhead">
        <svg width={PLAYHEAD_WIDTH} height="100%"><path ref={playheadSvg} d={playheadPath(400)} /></svg>
      </div>
    </div>
  );
}

export function Timeline() {
  const body = useRef<HTMLDivElement>(null);

  // Wheel and pinch anywhere over the headers or the canvas (non-passive, to keep the page still).
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".tl-hbar, .tl-vbar")) return;
      e.preventDefault();
      timeline.wheel(e);
    };
    // Safari / WKWebView pinch (macOS app window).
    let lastScale = 1;
    const gestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as unknown as { scale: number }).scale;
      store().zoomBy(scale / lastScale);
      lastScale = scale;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gestureStart);
    el.addEventListener("gesturechange", gestureChange);
    // Modifier changes mid-drag (⌥ copies, ⌘ toggles snapping) and Esc cancelling a drag.
    const key = (e: KeyboardEvent) => {
      if (timeline.keyChanged(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gestureStart);
      el.removeEventListener("gesturechange", gestureChange);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
    };
  }, []);

  // Drops from the Media panel over the canvas or the headers (over headers: at the start).
  const canvasPoint = (e: React.DragEvent) => {
    const c = body.current?.querySelector(".tl-canvas")?.getBoundingClientRect();
    return c ? { x: e.clientX - c.left, y: e.clientY - c.top } : { x: 0, y: 0 };
  };
  const onDragOver = (e: React.DragEvent) => {
    const payloads = timeline.payloadsFrom(e.dataTransfer, false);
    if (!payloads) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const p = canvasPoint(e);
    timeline.dragOver(p.x, p.y, payloads);
  };
  const onDrop = (e: React.DragEvent) => {
    const payloads = timeline.payloadsFrom(e.dataTransfer, true);
    if (!payloads) return;
    e.preventDefault();
    const p = canvasPoint(e);
    timeline.drop(p.x, p.y, payloads);
    timeline.dragPayloads = undefined;
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!body.current?.contains(e.relatedTarget as Node)) timeline.clearDrop();
  };

  // Pointer-driven drags from the Media panel (src/ui/pointerDrag.ts) and OS file drops
  // (src/ui/shell/Shell.tsx), both as CustomEvents with client coordinates.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const point = (x: number, y: number) => {
      const c = el.querySelector(".tl-canvas")?.getBoundingClientRect();
      return c ? { x: x - c.left, y: y - c.top } : { x: 0, y: 0 };
    };
    type D = { x: number; y: number; payloads?: Payload[]; paths?: string[] };
    let fileLabel: string | undefined;
    const label = (paths: string[]) => {
      const names = paths.map((p) => p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? p);
      return names.length > 1 ? `${names[0]} + ${names.length - 1} more` : names[0];
    };
    const mediaDrag = (e: Event) => {
      const d = (e as CustomEvent<D>).detail;
      const p = point(d.x, d.y);
      timeline.dragOver(p.x, p.y, d.payloads ?? []);
    };
    const mediaDrop = (e: Event) => {
      const d = (e as CustomEvent<D>).detail;
      const p = point(d.x, d.y);
      void timeline.drop(p.x, p.y, d.payloads ?? []);
    };
    const fileDrag = (e: Event) => {
      const d = (e as CustomEvent<D>).detail;
      if (d.paths?.length) fileLabel = label(d.paths);
      const p = point(d.x, d.y);
      timeline.dragOver(p.x, p.y, [], fileLabel ?? "Media");
    };
    const fileDrop = (e: Event) => {
      const d = (e as CustomEvent<D>).detail;
      fileLabel = undefined;
      const p = point(d.x, d.y);
      void timeline.dropFiles(p.x, p.y, d.paths ?? []);
    };
    const leave = () => {
      fileLabel = undefined;
      timeline.clearDrop();
    };
    el.addEventListener("promptedit:media-drag", mediaDrag);
    el.addEventListener("promptedit:media-drop", mediaDrop);
    el.addEventListener("promptedit:media-leave", leave);
    el.addEventListener("promptedit:file-drag", fileDrag);
    el.addEventListener("promptedit:file-drop", fileDrop);
    el.addEventListener("promptedit:file-leave", leave);
    return () => {
      el.removeEventListener("promptedit:media-drag", mediaDrag);
      el.removeEventListener("promptedit:media-drop", mediaDrop);
      el.removeEventListener("promptedit:media-leave", leave);
      el.removeEventListener("promptedit:file-drag", fileDrag);
      el.removeEventListener("promptedit:file-drop", fileDrop);
      el.removeEventListener("promptedit:file-leave", leave);
    };
  }, []);

  const locateMarker = (id: Id) => {
    const rect = body.current?.querySelector(".tl-canvas")?.getBoundingClientRect();
    const x = timeline.markerX(id);
    return rect && x !== undefined ? { x: rect.left + x, y: rect.top } : undefined;
  };

  return (
    <div className="tl">
      <Toolbar />
      <div className="tl-hairline" />
      <div ref={body} className="tl-body" tabIndex={-1} data-media-drop-target data-file-drop-target onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave}
        onPointerDown={() => {
          if (store().mediaSelection.size) store().set({ mediaSelection: new Set() });
        }}>
        <TrackHeaders />
        <div className="tl-vline" />
        <div className="tl-main">
          <div className="tl-upper">
            <Canvas />
            <RowScaleBar />
          </div>
          <div className="tl-lower">
            <ZoomScrollBar />
            <div className="tl-bar-corner" />
          </div>
        </div>
      </div>
      <MenuHost />
      <MarkerPanel locate={locateMarker} />
    </div>
  );
}
