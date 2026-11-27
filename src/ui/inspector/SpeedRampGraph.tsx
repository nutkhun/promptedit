// A clip's speed across its footage, under the Speed row (docs/spec/04-ui.md §1.5 "Speed ramp
// graph"; Editroom's SpeedRampGraph). The flat middle is the speed; an inner dot pulled in from
// either edge makes an ease, whose outer dot sets where it begins and the speed before (or after)
// it. Across is the clip's footage, which stays put while the clip's length changes.

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip } from "../../model";
import { ShapePills } from "../controls";
import type { RampMode } from "./prefs";
import {
  dragRamp, hasIn, hasOut, RAMP_HI, RAMP_LO, rampCurveAt, rampMode, rampShapeOf, snapSpeed, switchRampMode,
  type RampPart, type RampShape,
} from "./shapes";
import { lengthLabel } from "./values";
import { useWidth } from "./useWidth";

const H = 76;

const yOf = (v: number) => {
  const n = (Math.log(Math.min(Math.max(v, RAMP_LO), RAMP_HI)) - Math.log(RAMP_LO)) / (Math.log(RAMP_HI) - Math.log(RAMP_LO));
  return 6 + (H - 12) * (1 - n);
};
const speedAtY = (y: number) => {
  const n = 1 - (y - 6) / (H - 12);
  return snapSpeed(Math.exp(Math.log(RAMP_LO) + Math.min(1, Math.max(0, n)) * (Math.log(RAMP_HI) - Math.log(RAMP_LO))));
};

export function SpeedRampGraph({ clip, onEditing, onChange, onPick }: {
  clip: Clip;
  onEditing: (began: boolean) => void;
  /** The shape mid-drag, and how far across the footage the held dot is (undefined for the middle line). */
  onChange: (s: RampShape, focus: number | undefined) => void;
  /** A mode picked on the pills: remembered for new ramps, and the shape to switch to if it changed. */
  onPick: (mode: RampMode, shape: RampShape | undefined) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [drag, setDrag] = useState<{ part: RampPart; shape: RampShape; mode: RampMode } | undefined>();
  const [cursor, setCursor] = useState("default");
  const s = drag?.shape ?? rampShapeOf(clip);
  const mode = drag?.mode ?? rampMode(s);

  const xOf = (f: number) => Math.min(Math.max(5, f * w), w - 5);
  const dots = (sh: RampShape): [RampPart, number, number][] => {
    const midY = yOf(sh.mid);
    const out: [RampPart, number, number][] = [["inEnd", xOf(sh.p2), midY]];
    // In has no way back out, so no dot to start one.
    if (mode !== "in") out.push(["outStart", xOf(sh.p3), midY]);
    if (hasIn(sh)) out.push(["inStart", xOf(sh.p1), yOf(sh.start)]);
    if (hasOut(sh)) out.push(["outEnd", xOf(sh.p4), yOf(sh.end)]);
    return out;
  };

  /** The nearest dot within reach (an inner dot when they sit together), else the flat middle. */
  const hit = (px: number, py: number): RampPart | undefined => {
    let near: { part: RampPart; d: number } | undefined;
    for (const [part, x, y] of dots(s)) {
      const d = Math.hypot(px - x, py - y);
      if (d >= 10) continue;
      const inner = part === "inEnd" || part === "outStart";
      if (near) {
        if (Math.abs(near.d - d) < 2) { if (inner) near = { part, d }; } else if (d < near.d) near = { part, d };
      } else near = { part, d };
    }
    if (near) {
      // Inner dots on top of each other: whichever side the pointer is on.
      if (mode === "inOut" && (near.part === "inEnd" || near.part === "outStart")) {
        const x2 = s.p2 * w, x3 = s.p3 * w;
        if (Math.abs(x2 - x3) < 10) return px < (x2 + x3) / 2 ? "inEnd" : "outStart";
      }
      return near.part;
    }
    const midY = yOf(s.mid);
    if (px > s.p2 * w && px < s.p3 * w && Math.abs(py - midY) < 8) return "line";
    return undefined;
  };

  const local = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const fractionOf = (part: RampPart, sh: RampShape) =>
    part === "inStart" ? sh.p1 : part === "inEnd" ? sh.p2 : part === "outStart" ? sh.p3 : part === "outEnd" ? sh.p4 : (sh.p2 + sh.p3) / 2;
  const speedOf = (part: RampPart, sh: RampShape) => (part === "inStart" ? sh.start : part === "outEnd" ? sh.end : sh.mid);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || w <= 0) return;
    const [px, py] = local(e);
    const part = hit(px, py);
    if (!part) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ part, shape: s, mode: rampMode(s) });
    onEditing(true);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const [px, py] = local(e);
    if (!drag) {
      const part = hit(px, py);
      setCursor(
        part === "inEnd" ? (mode === "in" ? "grab" : "ew-resize")
          : part === "outStart" ? "ew-resize"
          : part === "inStart" || part === "outEnd" ? "grab"
          : part === "line" ? "ns-resize" : "default",
      );
      return;
    }
    let f = Math.min(Math.max(0, px), w) / w;
    if (px < 6) f = 0;
    if (px > w - 6) f = 1;
    const next = dragRamp(drag.part, drag.shape, f, speedAtY(py), drag.mode);
    setDrag({ ...drag, shape: next });
    onChange(next, drag.part === "line" ? undefined : fractionOf(drag.part, next));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDrag(undefined);
    onEditing(false);
  };

  // The speed line, and the area between it and 100%.
  const n = 160;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    pts.push(`${(x * w).toFixed(2)},${yOf(rampCurveAt(s, x)).toFixed(2)}`);
  }
  const base = yOf(1);
  const area = `M${pts[0]} L${pts.slice(1).join(" L")} L${w},${base} L0,${base} Z`;

  let label: { x: number; y: number; text: string } | undefined;
  if (drag) {
    const p = drag.part;
    const ax = p === "line" ? ((s.p2 + s.p3) / 2) * w : xOf(fractionOf(p, s));
    const ay = yOf(speedOf(p, s));
    label = {
      x: ax > w - 44 ? ax - 26 : ax + 26,
      y: ay < 16 ? ay + 12 : ay - 11,
      text: `${Math.round(speedOf(p, s) * 100)}%`,
    };
  }

  return (
    <div className="insp-graph" data-graph="ramp">
      <div
        ref={ref}
        className="insp-graph-plot"
        style={{ height: H, cursor: drag ? (drag.part === "line" ? "ns-resize" : drag.part === "outStart" || (drag.part === "inEnd" && drag.mode !== "in") ? "ew-resize" : "grabbing") : cursor }}
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
            {dots(s).map(([part, x, y]) => {
              const r = (drag?.part === part ? 12 : 10) / 2;
              return <circle key={part} cx={x} cy={y} r={r + 1.25} fill="var(--text)" stroke="var(--field)" strokeWidth={2.5} />;
            })}
            {label && (
              <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" className="insp-graph-label">
                {label.text}
              </text>
            )}
          </svg>
        )}
      </div>
      <div className="insp-graph-foot">
        <ShapePills<RampMode>
          options={[
            { value: "in", label: "In", title: "Ease from one speed into another" },
            { value: "inOut", label: "In/Out", title: "Ease into the speed and back out" },
          ]}
          picked={mode}
          onPick={(m) => onPick(m, m === mode ? undefined : switchRampMode(m, s))}
        />
        <span className="ctl-spacer" />
        <span className="insp-graph-length" title="How long the clip plays with its ramp">
          <span className="insp-graph-length-label">Length</span>
          <span className="mono">{lengthLabel(clip.duration)}</span>
        </span>
      </div>
    </div>
  );
}
