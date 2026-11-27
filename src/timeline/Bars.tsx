// The zoom/scroll bar under the canvas and the row-scale bar beside it (docs/spec/04-ui.md §1.6):
// drag a thumb to scroll, drag a grip to zoom (columns) or change row height (rows). Each drag is
// computed from what it started with, never from the previous frame, so it can't drift.

import { useRef, useState } from "react";
import { useStore } from "../store";
import { ROW_MAX, ROW_MIN, RULER } from "./layout";
import {
  BAR, HANDLE, MAX_PPS, barPart, extent, gripDrag, gripMirror, minScrollY, rowAnchor, rowWindow, rowsVisible, rowsWorld,
} from "./viewMath";

const MIN_THUMB = HANDLE * 2 + 6;

function Thumb({ vertical, hot, active, length, offset }: { vertical: boolean; hot?: number; active: boolean; length: number; offset: number }) {
  const lit = hot !== undefined || active;
  const gripHot = hot === 0 || hot === 2;
  const style: React.CSSProperties = vertical
    ? { top: offset, height: length, width: HANDLE, left: (BAR - HANDLE) / 2, flexDirection: "column" }
    : { left: offset, width: length, height: HANDLE, top: (BAR - HANDLE) / 2 };
  return (
    <div className={`tl-thumb${lit ? " lit" : ""}${gripHot ? " grip-hot" : ""}`} style={style}>
      <div className="tl-grip" />
      <div className="tl-grip" />
    </div>
  );
}

interface BarDrag { part: number; pointer: number; start: Record<string, number> }

/** Horizontal bar: the bar is the whole scrollable timeline, the thumb what's on screen. */
export function ZoomScrollBar() {
  const view = useStore((s) => s.view);
  const project = useStore((s) => s.project);
  const ref = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState<number | undefined>();
  const [drag, setDrag] = useState<BarDrag | undefined>();
  const w = Math.max(1, ref.current?.clientWidth ?? view.viewWidth);
  const ext = extent(project);
  const len = Math.max(MIN_THUMB, Math.min(1, view.viewWidth / view.pps / ext) * w);
  const x = Math.min(Math.max(0, (view.scrollX / view.pps / ext) * w), w - len);

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const px = e.clientX - el.getBoundingClientRect().left;
    const s = useStore.getState();
    let part = barPart(px, x, len);
    if (part === undefined) {
      // Click on the empty bar: centre the thumb there and keep dragging it.
      s.setView({ scrollX: ((px - len / 2) / w) * ext * s.view.pps });
      part = 1;
    }
    const v = useStore.getState().view;
    const t = (s.playhead * v.pps - v.scrollX) / Math.max(1, v.viewWidth);
    const d: BarDrag = { part, pointer: e.clientX, start: { pps: v.pps, scrollX: v.scrollX, mirror: gripMirror(part, t) } };
    setDrag(d);
    setHot(part);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - d.pointer;
      const st = useStore.getState();
      const vw = st.view.viewWidth;
      if (d.part === 1) {
        st.setView({ scrollX: d.start.scrollX + (dx / w) * ext * d.start.pps });
      } else {
        const a0 = (d.start.scrollX / d.start.pps / ext) * w;
        const e2 = gripDrag(d.part, a0, a0 + (vw / d.start.pps / ext) * w, dx, w, (vw / MAX_PPS / ext) * w, w, d.start.mirror);
        const pps = vw / (((e2.end - e2.start) / w) * ext);
        st.setView({ pps, scrollX: (e2.start / w) * ext * pps });
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(undefined);
      setHot(undefined);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div ref={ref} className="tl-hbar"
      onPointerMove={(e) => !drag && setHot(barPart(e.clientX - e.currentTarget.getBoundingClientRect().left, x, len))}
      onPointerLeave={() => !drag && setHot(undefined)}
      onPointerDown={down}>
      <Thumb vertical={false} hot={hot} active={!!drag} length={len} offset={x} />
    </div>
  );
}

/** Vertical bar: thumb length = row zoom (full bar at the smallest rows), position = vertical scroll. */
export function RowScaleBar() {
  const view = useStore((s) => s.view);
  const project = useStore((s) => s.project);
  const ref = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState<number | undefined>();
  const [drag, setDrag] = useState<BarDrag | undefined>();
  const h = Math.max(1, (ref.current?.clientHeight ?? view.viewHeight) - RULER);
  const world = rowsWorld(project, view);
  const len = Math.max(MIN_THUMB, rowWindow(project, view) * h);
  const y = Math.min(Math.max(0, ((view.scrollY - minScrollY(project, view)) / world) * h), h - len);

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const py = e.clientY - el.getBoundingClientRect().top - RULER;
    const s = useStore.getState();
    let part = barPart(py, y, len);
    if (part === undefined) {
      s.setView({ scrollY: minScrollY(project, s.view) + ((py - len / 2) / h) * world });
      part = 1;
    }
    const v = useStore.getState().view;
    const p = useStore.getState().project;
    const anchor = rowAnchor(p, v.rowHeight, v.scrollY + rowsVisible(v) / 2);
    const d: BarDrag = {
      part, pointer: e.clientY,
      start: {
        scrollY: v.scrollY, length: rowWindow(p, v) * h, content: rowsWorld(p, v),
        start: ((v.scrollY - minScrollY(p, v)) / rowsWorld(p, v)) * h, fixed: anchor.fixed, rows: anchor.rows,
      },
    };
    setDrag(d);
    setHot(part);
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - d.pointer;
      const st = useStore.getState();
      if (d.part === 1) {
        st.setView({ scrollY: d.start.scrollY + (dy / h) * d.start.content });
        return;
      }
      // A shorter thumb means taller rows; the grip stays under the mouse, the other end mirrors it.
      const pv = st.view, pp = st.project;
      const e2 = gripDrag(d.part, d.start.start, d.start.start + d.start.length, dy, h,
        rowWindow(pp, pv, ROW_MAX) * h, rowWindow(pp, pv, ROW_MIN) * h);
      // Rows are whole points tall: take the height whose thumb is closest to the one asked for.
      let best = pv.rowHeight, miss = Infinity;
      for (let r = ROW_MIN; r <= ROW_MAX; r++) {
        const off = Math.abs(rowWindow(pp, pv, r) * h - (e2.end - e2.start));
        if (off < miss) {
          miss = off;
          best = r;
        }
      }
      // What was in the middle of the view stays there as rows grow and shrink.
      const centre = d.start.fixed + d.start.rows * best;
      st.setView({ rowHeight: best, scrollY: centre - rowsVisible(pv) / 2 });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(undefined);
      setHot(undefined);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div ref={ref} className="tl-vbar"
      onPointerMove={(e) => !drag && setHot(barPart(e.clientY - e.currentTarget.getBoundingClientRect().top - RULER, y, len))}
      onPointerLeave={() => !drag && setHot(undefined)}
      onPointerDown={down}>
      <Thumb vertical hot={hot} active={!!drag} length={len} offset={RULER + y} />
    </div>
  );
}
