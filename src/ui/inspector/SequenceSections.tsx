// Nothing selected: the sequence's frame size and rate (docs/spec/04-ui.md §1.5 Frame, Frame rate;
// docs/spec/01-model.md §3.19). Each choice is one undo step.

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { FRAME_RATES } from "../../model";
import { useStore } from "../../store";
import { InspectorSection, MenuField, type MenuItem } from "../controls";
import { fpsLabel, frameDimension, steppedDimension } from "./values";

const SIZES: [string, number, number][] = [
  ["4K  3840 × 2160", 3840, 2160],
  ["1440p  2560 × 1440", 2560, 1440],
  ["1080p  1920 × 1080", 1920, 1080],
  ["720p  1280 × 720", 1280, 720],
  ["Vertical  1080 × 1920", 1080, 1920],
  ["Vertical 4K  2160 × 3840", 2160, 3840],
  ["Square  1080 × 1080", 1080, 1080],
];

export function SequenceSections() {
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const fps = useStore((s) => s.project.fps);
  const locked = useStore((s) => s.project.settingsLocked);
  const hasVideo = useStore((s) => s.project.assets.some((a) => a.kind === "video"));
  const edit = useStore((s) => s.edit);

  const setSize = (w: number, h: number) => void edit({ op: "setSequence", width: w, height: h });
  const sizes: MenuItem[] = SIZES.map(([label, w, h]) => ({ label, onSelect: () => setSize(w, h) }));
  const rates: MenuItem[] = FRAME_RATES.map((r) => ({
    label: fpsLabel(r),
    onSelect: () => void edit({ op: "setFps", fps: r }),
  }));

  return (
    <>
      <InspectorSection title="Frame">
        <MenuField label={`${width} × ${height}`} items={sizes} />
        <FrameSizeFields width={width} height={height} apply={setSize} />
      </InspectorSection>
      <InspectorSection title="Frame rate">
        <MenuField label={fpsLabel(fps)} items={rates} />
        {!locked && !hasVideo && <div className="insp-hint">Matches the first video you import.</div>}
      </InspectorSection>
    </>
  );
}

/** Width × height for a custom size. Return or clicking away applies, Esc reverts, ↑/↓ ±2 (Shift ±20). */
function FrameSizeFields({ width, height, apply }: { width: number; height: number; apply: (w: number, h: number) => void }) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  const [focus, setFocus] = useState<0 | 1 | undefined>();

  const sync = () => {
    setW(String(width));
    setH(String(height));
  };
  useEffect(sync, [width, height]);

  const commit = (tw = w, th = h) => {
    const cw = frameDimension(tw), ch = frameDimension(th);
    if (cw === undefined || ch === undefined) return sync();
    if (cw !== width || ch !== height) apply(cw, ch);
    else sync();
  };

  const field = (tag: 0 | 1) => {
    const text = tag === 0 ? w : h;
    const set = tag === 0 ? setW : setH;
    const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        sync();
        // Blur after the reverted text is in place, so the blur doesn't apply what was typed.
        e.currentTarget.dataset.cancel = "1";
        e.currentTarget.blur();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const n = String(steppedDimension(text, tag === 0 ? width : height, e.key === "ArrowUp", e.shiftKey));
        set(n);
        if (tag === 0) commit(n, h); else commit(w, n);
      }
    };
    return (
      <input
        className="ctl-field"
        value={text}
        spellCheck={false}
        aria-label={tag === 0 ? "Width" : "Height"}
        onChange={(e) => set(e.target.value)}
        onFocus={(e) => { setFocus(tag); e.target.select(); }}
        onBlur={(e) => {
          setFocus(undefined);
          if (e.currentTarget.dataset.cancel) delete e.currentTarget.dataset.cancel;
          else commit();
        }}
        onKeyDown={onKey}
        data-focused={focus === tag || undefined}
      />
    );
  };

  return (
    <div className="ctl-row" style={{ gap: 6 }}>
      {field(0)}
      <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>×</span>
      {field(1)}
    </div>
  );
}
