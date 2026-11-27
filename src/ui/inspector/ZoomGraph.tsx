// The zoom on Scale, drawn like the speed ramp (docs/spec/04-ui.md §1.5 "Zoom graph"; Editroom's
// ZoomGraph): across is the clip, up is the scale from the full frame (100%) to the zoomed-in
// Scale. The dots set when each move starts and ends (snapped to frames, a frame apart); the top
// line sets the Scale. Along the bottom: In, In/Out, Out, and smooth or linear moves.

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip, ZoomMode, ZoomMove } from "../../model";
import { zoomAmount } from "../../timing";
import { ShapePills } from "../controls";
import { dragZoom, zoomGraphTop, zoomLineSpan, zoomStarter, type ZoomPart } from "./shapes";
import { useWidth } from "./useWidth";

const H = 76;
const LO = 1;

export function ZoomGraph({ clip, zoom, scale, fps, onEditing, onChange, onSet }: {
  clip: Clip;
  zoom: ZoomMove;
  scale: number;
  fps: number;
  onEditing: (began: boolean) => void;
  /** Mid-drag: the zoom, the scale, and the time into the clip of the dot held (undefined for the top line). */
  onChange: (z: ZoomMove, scale: number, focus: number | undefined) => void;
  /** A change made in one go (the buttons). */
  onSet: (z: ZoomMove) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [drag, setDrag] = useState<{ part: ZoomPart; zoom: ZoomMove; scale: number; top: number } | undefined>();
  // The graph steps up when a zoom needs more room, never back down (for this clip).
  const [kept, setKept] = useState({ clip: clip.id, top: 0 });
  const keptTop = kept.clip === clip.id ? kept.top : 0;
  const [cursor, setCursor] = useState("default");

  const z = drag?.zoom ?? zoom, s = drag?.scale ?? scale;
  const top = drag?.top ?? Math.max(zoomGraphTop(scale), keptTop);
  const length = Math.max(clip.duration, 1e-6);

  const yOf = (v: number) => {
    const n = (Math.log(Math.min(Math.max(v, LO), top)) - Math.log(LO)) / (Math.log(top) - Math.log(LO));
    return 6 + (H - 12) * (1 - n);
  };
  const scaleAtY = (y: number) => {
    const n = 1 - (y - 6) / (H - 12);
    const v = Math.exp(Math.log(LO) + Math.min(1, Math.max(0, n)) * (Math.log(top) - Math.log(LO)));
    return Math.max(1.05, Math.round(v * 100) / 100);
  };
  const xOf = (t: number) => Math.min(Math.max(5, (t / length) * w), w - 5);

  const dots = (zz: ZoomMove, ss: number): [Exclude<ZoomPart, "line">, number, number][] => {
    const yt = yOf(ss), yb = yOf(1);
    const out: [Exclude<ZoomPart, "line">, number, number][] = [];
    if (zz.mode !== "out") out.push(["p1", xOf(zz.p1), yb], ["p2", xOf(zz.p2), yt]);
    if (zz.mode !== "in") out.push(["p3", xOf(zz.p3), yt], ["p4", xOf(zz.p4), yb]);
    return out;
  };
  const hit = (px: number, py: number): ZoomPart | undefined => {
    let near: { part: ZoomPart; d: number } | undefined;
    for (const [part, x, y] of dots(z, s)) {
      const d = Math.hypot(px - x, py - y);
      if (d < 10 && d < (near?.d ?? Infinity)) near = { part, d };
    }
    if (near) return near.part;
    const [a, b] = zoomLineSpan(z, length);
    if (px > xOf(a) && px < xOf(b) && Math.abs(py - yOf(s)) < 8) return "line";
    return undefined;
  };
  const local = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || w <= 0) return;
    const [px, py] = local(e);
    const part = hit(px, py);
    if (!part) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ part, zoom: z, scale: s, top });
    onEditing(true);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const [px, py] = local(e);
    if (!drag) {
      const part = hit(px, py);
      setCursor(part === "line" ? "ns-resize" : part ? "ew-resize" : "default");
      return;
    }
    let t = (Math.min(Math.max(0, px), w) / w) * length;
    if (px < 6) t = 0;
    if (px > w - 6) t = length;
    t = Math.round(t * fps) / fps;
    const next = { ...drag };
    if (drag.part === "line") next.scale = scaleAtY(py);
    else next.zoom = dragZoom(drag.part, drag.zoom, t, length, fps);
    setDrag(next);
    const focus = drag.part === "line" ? undefined : next.zoom[drag.part];
    onChange(next.zoom, next.scale, focus);
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setKept({ clip: clip.id, top: Math.max(keptTop, zoomGraphTop(drag.scale), drag.top) });
    setDrag(undefined);
    onEditing(false);
  };

  const n = 160;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * length;
    const v = Math.exp(Math.log(Math.max(s, 1e-3)) * zoomAmount(z, u));
    pts.push(`${((u / length) * w).toFixed(2)},${yOf(v).toFixed(2)}`);
  }
  const base = yOf(1);
  const area = `M${pts[0]} L${pts.slice(1).join(" L")} L${w},${base} L0,${base} Z`;
  const [la, lb] = zoomLineSpan(z, length);

  const pickMode = (m: ZoomMode) => {
    if (m === zoom.mode) return;
    onSet(zoomStarter(m, length, zoom.smooth));
  };

  return (
    <div className="insp-graph" data-graph="zoom">
      <div
        ref={ref}
        className="insp-graph-plot"
        style={{ height: H, cursor: drag ? (drag.part === "line" ? "ns-resize" : "ew-resize") : cursor }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => !drag && setCursor("default")}
      >
        {w > 0 && (
          <svg width={w} height={H} style={{ display: "block", overflow: "visible" }}>
            <line x1={0} x2={w} y1={base} y2={base} stroke="rgba(var(--ink-rgb), 0.14)" strokeDasharray="2 3" />
            <path d={area} fill="rgba(var(--ink-rgb), 0.05)" />
            <polyline points={pts.join(" ")} fill="none" stroke="var(--text)" strokeWidth={1.5} strokeLinejoin="round" />
            {dots(z, s).map(([part, x, y]) => {
              const r = (drag?.part === part ? 12 : 10) / 2;
              return <circle key={part} cx={x} cy={y} r={r + 1.25} fill="var(--text)" stroke="var(--field)" strokeWidth={2.5} />;
            })}
            {drag?.part === "line" && (() => {
              const x = (xOf(la) + xOf(lb)) / 2, y = yOf(s);
              return (
                <text x={x} y={y < 16 ? y + 12 : y - 11} textAnchor="middle" dominantBaseline="middle" className="insp-graph-label">
                  {Math.round(s * 100)}%
                </text>
              );
            })()}
          </svg>
        )}
      </div>
      <div className="insp-graph-foot">
        <ShapePills<ZoomMode>
          options={[
            { value: "in", label: "In", title: "Zoom in" },
            { value: "inOut", label: "In/Out", title: "Zoom in, hold, and back out" },
            { value: "out", label: "Out", title: "Zoom out" },
          ]}
          picked={z.mode}
          onPick={pickMode}
        />
        <span className="ctl-spacer" />
        <ShapePills<"smooth" | "linear">
          options={[
            { value: "smooth", label: <EaseGlyph smooth />, title: "Smooth: eases into and out of each move" },
            { value: "linear", label: <EaseGlyph smooth={false} />, title: "Linear: moves at an even pace" },
          ]}
          picked={z.smooth ? "smooth" : "linear"}
          onPick={(v) => {
            const smooth = v === "smooth";
            if (smooth !== zoom.smooth) onSet({ ...zoom, smooth });
          }}
        />
      </div>
    </div>
  );
}

/** Smooth (an S-curve) or linear (a straight line), 9 × 7 in a 20 × 15 button. */
function EaseGlyph({ smooth }: { smooth: boolean }) {
  return (
    <svg width={20} height={15} viewBox="0 0 20 15" style={{ display: "block", margin: "0 -6px" }} aria-hidden>
      <path
        d={smooth ? "M5.5 11C11.35 11 8.65 4 14.5 4" : "M5.5 11L14.5 4"}
        fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round"
      />
    </svg>
  );
}
