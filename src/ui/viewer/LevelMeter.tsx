// A vertical level meter (docs/spec/04-ui.md §1.6 "Level meter"; TimelinePanel.swift `LevelMeter`):
// 2 pt segments 1 pt apart, the top one a clip light, the rest spanning −60…0 dB, lit red above −3 dB,
// yellow above −12, else `meterLow`; a peak-hold segment; empty the instant playback stops.
//
//   <LevelMeter read={() => engine.meters()[0]} active={playing} />   // `read` returns dB (−Infinity = silent)
//
// It polls `read` once per frame while `active`, and draws by setting segment colours directly (no
// React render per frame).

import { useEffect, useRef } from "react";

const FLOOR = -60;
const SEGMENT = 2, GAP = 1;
/** Peaks hold this long before falling. */
const PEAK_HOLD = 1.0;
const CLIP_HOLD = 2.0;

const segColor = (db: number) => (db > -3 ? "var(--alert)" : db > -12 ? "var(--snap)" : "var(--meter-low)");

export function LevelMeter({ read, active, height = 24, width = 4, title }: {
  read: () => number; active: boolean; height?: number; width?: number; title?: string;
}) {
  const count = Math.max(4, Math.floor((height + GAP) / (SEGMENT + GAP)));
  const span = count - 1;
  const box = useRef<HTMLDivElement>(null);
  const state = useRef({ level: FLOOR, peak: FLOOR, peakAt: 0, clipAt: -Infinity });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const segs = Array.from(el.children) as HTMLElement[];
    const draw = (level: number, peak: number, clipped: boolean) => {
      // segs[0] is the clip light (top); segs[1 + j] is segment index span-1-j.
      segs[0].style.background = clipped ? "var(--alert)" : "var(--well)";
      const lit = Math.floor(Math.min(span, Math.max(0, span * ((level - FLOOR) / -FLOOR))));
      const pk = Math.floor(Math.min(span, Math.max(0, span * ((peak - FLOOR) / -FLOOR)))) - 1;
      for (let i = 0; i < span; i++) {
        const on = i < lit || (i === pk && peak > FLOOR + 0.5);
        segs[span - i].style.background = on ? segColor(FLOOR * (1 - (i + 1) / span)) : "var(--well)";
      }
      el.title = title ?? (clipped ? "Clipping" : "Level");
    };
    if (!active) {
      state.current = { level: FLOOR, peak: FLOOR, peakAt: 0, clipAt: -Infinity };
      draw(FLOOR, FLOOR, false);
      return;
    }
    let frame = 0;
    const tick = (now: number) => {
      const t = now / 1000;
      const db = read();
      const level = Number.isFinite(db) ? Math.max(FLOOR, db) : FLOOR;
      const s = state.current;
      // Fast attack, ~20 dB/s release, so the bar reads smoothly.
      s.level = level >= s.level ? level : Math.max(level, s.level - 20 / 60);
      if (level >= s.peak || t - s.peakAt > PEAK_HOLD) { s.peak = level >= s.peak ? level : Math.max(level, s.peak - 30 / 60); if (level >= s.peak) s.peakAt = t; }
      if (db > -0.1) s.clipAt = t;
      draw(s.level, s.peak, t - s.clipAt < CLIP_HOLD);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, read, span, title]);

  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: GAP, width, height, flex: "none" }}>
      {Array.from({ length: count }, (_, i) => <div key={i} style={{ height: SEGMENT, background: "var(--well)", flex: "none" }} />)}
    </div>
  );
}
