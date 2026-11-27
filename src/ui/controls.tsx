// Shared inspector-style controls (docs/spec/04-ui.md §1.5 "Shared controls"): sections with a
// remembered fold, parameter rows (thin slider + typed value), menu fields and pop-up menus,
// chips, the fade-curve menu, the ramp button, colour wells with their picker, and colour wheels.
// Ported from Editroom's InspectorView.swift building blocks. Everything here is presentational:
// callers decide what an edit is (see src/ui/inspector/live.ts for one-undo-step gestures).

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { FadeCurve, RGBA, WheelPoint } from "../model";
import { applyCurve } from "../timing";
import { Icon } from "./inspector/glyphs";
import { committedValue, fromNormal, nudgedValue, toNormal, WHEEL_REACH, wheelPoint, type Range } from "./inspector/values";
import { cssColor, fromHSV, fromHex, sameColour, toHSV, toHex, type HSV } from "./inspector/colour";
import type { Gesture } from "./inspector/live";
import "./inspector/controls.css";

export { parseNumber, committedValue, nudgedValue, toNormal, fromNormal, wheelPoint } from "./inspector/values";
export type { Gesture } from "./inspector/live";

// ---------------------------------------------------------------------------------------------
// Section

const collapsedKey = (title: string) => `inspector.collapsed.${title}`;

function readCollapsed(title: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(collapsedKey(title));
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}

/**
 * A titled group of rows. Clicking the header folds it; the choice is remembered per title
 * (`inspector.collapsed.<Title>`). A folded section that has changes shows an accent dot, and an
 * optional text action ("Reset") shows at the right while it's open.
 */
export function InspectorSection({
  title, action, collapsedByDefault = false, marked = false, children,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  collapsedByDefault?: boolean;
  marked?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(title, collapsedByDefault));
  // Another section with the same title (e.g. "Transform" for a text clip) shares the setting.
  useEffect(() => setCollapsed(readCollapsed(title, collapsedByDefault)), [title, collapsedByDefault]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(collapsedKey(title), String(next)); } catch { /* private mode */ }
  };
  return (
    <section className="ctl-section" data-section={title}>
      <div className="ctl-section-head">
        <button className="ctl-section-toggle" onClick={toggle} aria-expanded={!collapsed}>
          <span className={`ctl-section-chevron${collapsed ? "" : " open"}`}>
            <Icon symbol="chevron.right" size={7.5} weight="bold" />
          </span>
          <span className="ctl-section-title">{title}</span>
          {marked && collapsed && <span className="ctl-section-dot" />}
        </button>
        {action && !collapsed && <TextLink label={action.label} onClick={action.onClick} />}
      </div>
      {!collapsed && <div className="ctl-section-body">{children}</div>}
    </section>
  );
}

export function TextLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button className="ctl-link" onClick={onClick}>{label}</button>;
}

// ---------------------------------------------------------------------------------------------
// Rows

/** The 18-wide icon column of a row. */
export function RowIcon({ symbol, children, dim }: { symbol?: string; children?: ReactNode; dim?: boolean }) {
  return (
    <span className="ctl-row-icon" style={dim ? { color: "var(--text-faint)" } : undefined}>
      {symbol ? <Icon symbol={symbol} size={11} /> : children}
    </span>
  );
}

/**
 * Slim slider: 2 pt track, filled up to a 13 pt knob ringed in the panel colour. Dragging anywhere
 * sets the value (no minimum distance). `value` is the normalised position 0…1.
 */
export function ThinSlider({
  value, onBegin, onChange, onEnd,
}: {
  value: number;
  onBegin: () => void;
  onChange: (n: number) => void;
  onEnd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Read by the pointer handlers, which can run again before React re-renders.
  const held = useRef(false);
  const [width, setWidth] = useState(0);
  const knob = 13;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const at = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const travel = Math.max(1, r.width - knob);
    return Math.min(1, Math.max(0, (e.clientX - r.left - knob / 2) / travel));
  };
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    held.current = true;
    setDragging(true);
    onBegin();
    onChange(at(e));
  };
  const move = (e: ReactPointerEvent) => {
    if (held.current) onChange(at(e));
  };
  const up = (e: ReactPointerEvent) => {
    if (!held.current) return;
    held.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    onEnd();
  };

  const travel = Math.max(1, width - knob);
  const x = Math.min(1, Math.max(0, value)) * travel;
  return (
    <div
      ref={ref}
      className={`ctl-slider${dragging ? " dragging" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      role="slider"
      aria-valuenow={value}
    >
      <div className="ctl-slider-track" />
      <div className="ctl-slider-fill" style={{ width: x + knob / 2 }} />
      <div className="ctl-slider-knob" style={{ left: x }} />
    </div>
  );
}

/**
 * The typed value of a row: always editable (Tab moves on), Return or leaving applies, Esc puts
 * it back, ↑/↓ step (Shift ×10). What's typed is read with `parseNumber` and clamped.
 */
export function ValueField({
  value, range, format, step, live, inside, width = 68,
}: {
  value: number;
  range: Range;
  format: (v: number) => string;
  step?: number;
  live: Gesture<number>;
  inside?: ReactNode;
  width?: number;
}) {
  const shown = format(value);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);

  const apply = (v: number) => {
    live.begin();
    live.change(v);
    live.end();
  };
  const commit = () => {
    const v = committedValue(text, shown, range);
    if (v !== undefined) apply(v);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      cancelled.current = true;
      e.currentTarget.blur();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const v = nudgedValue({ text, value, shown, step, up: e.key === "ArrowUp", big: e.shiftKey, range });
      apply(v);
      setText(format(v));
      cancelled.current = false;
    }
    // Keys typed here are for the field, not the app's shortcuts.
    e.stopPropagation();
  };
  return (
    <div
      className={`ctl-value${focused ? " focused" : ""}${inside ? " with-inside" : ""}`}
      style={{ width }}
      onPointerDown={(e) => {
        // The whole box is the click target, not just the digits.
        if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); }
      }}
    >
      <input
        ref={input}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => { cancelled.current = false; setFocused(true); e.target.select(); }}
        onBlur={() => {
          if (!cancelled.current) commit();
          cancelled.current = false;
          setFocused(false);
          setText(shown);
        }}
        onKeyDown={onKey}
      />
      {inside && <span className="ctl-value-inside">{inside}</span>}
    </div>
  );
}

/**
 * One parameter: icon · label (52 wide) · ThinSlider · value field · optional trailing control.
 * Each slider drag is one gesture (one undo step); `log` maps the slider logarithmically.
 */
export function ParamRow({
  icon, label, value, range, log = false, step, format, live, inside, trailing,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  range: Range;
  log?: boolean;
  step?: number;
  format: (v: number) => string;
  live: Gesture<number>;
  inside?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="ctl-row" data-param={label}>
      {typeof icon === "string" ? <RowIcon symbol={icon} /> : icon}
      <span className="ctl-row-label">{label}</span>
      <ThinSlider
        value={toNormal(value, range, log)}
        onBegin={live.begin}
        onChange={(n) => live.change(fromNormal(n, range, log))}
        onEnd={live.end}
      />
      <ValueField value={value} range={range} format={format} step={step} live={live} inside={inside} />
      {trailing}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Popovers and menus

type Placement = "below" | "left";

/**
 * A floating panel anchored to an element, drawn above everything (portal). Closes on Escape or
 * a press outside it (but not on its anchor, which toggles it itself).
 */
export function Popover({
  anchor, placement = "below", onClose, children, style, matchWidth = false, className = "",
}: {
  anchor: HTMLElement;
  placement?: Placement;
  onClose: () => void;
  children: ReactNode;
  style?: CSSProperties;
  matchWidth?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number }>({ left: -9999, top: -9999 });
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const w = Math.max(el.offsetWidth, matchWidth ? a.width : 0), h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, m = 6;
    let left: number, top: number;
    if (placement === "left") {
      left = a.left - w - 10;
      if (left < m) left = a.right + 10;
      top = a.top + a.height / 2 - h / 2;
    } else {
      left = a.left;
      top = a.bottom + 4;
      if (top + h > vh - m) top = Math.max(m, a.top - h - 4);
    }
    left = Math.min(Math.max(m, left), vw - w - m);
    top = Math.min(Math.max(m, top), vh - h - m);
    setPos({ left, top, minWidth: matchWidth ? a.width : undefined });
  }, [anchor, placement, matchWidth]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); }
    };
    const onBlur = () => close.current();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className={`ctl-popover ${className}`} style={{ ...pos, ...style }}>
      {children}
    </div>,
    document.body,
  );
}

export type MenuItem =
  | { label: string; onSelect: () => void; checked?: boolean; icon?: ReactNode; disabled?: boolean }
  | "divider";

/** A pop-up menu: ticked current item, arrow keys + Return, Escape or a click outside closes. */
export function PopupMenu({
  anchor, items, onClose, matchWidth = true,
}: {
  anchor: HTMLElement;
  items: MenuItem[];
  onClose: () => void;
  matchWidth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.map((it, i) => (it !== "divider" && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState<number>(-1);
  useEffect(() => ref.current?.focus(), []);

  const pick = (i: number) => {
    const it = items[i];
    if (it === "divider" || it.disabled) return;
    onClose();
    it.onSelect();
  };
  const onKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const k = enabled.indexOf(active);
      const next = e.key === "ArrowDown" ? enabled[Math.min(enabled.length - 1, k + 1)] : enabled[Math.max(0, k <= 0 ? 0 : k - 1)];
      setActive(next ?? -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (active >= 0) pick(active);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} matchWidth={matchWidth}>
      <div ref={ref} className="ctl-menu" tabIndex={-1} onKeyDown={onKey} role="menu">
        {items.map((it, i) =>
          it === "divider" ? (
            <div key={i} className="ctl-menu-divider" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={`ctl-menu-item${active === i ? " active" : ""}`}
              disabled={it.disabled}
              style={it.disabled ? { opacity: 0.4 } : undefined}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(-1)}
              onClick={() => pick(i)}
            >
              <span className="ctl-menu-check">{it.checked && <Icon symbol="checkmark" size={9} weight="bold" />}</span>
              {it.icon}
              <span>{it.label}</span>
            </button>
          ),
        )}
      </div>
    </Popover>
  );
}

/** Opens a popover from a button; returns its open state, a ref for the anchor and a toggle. */
export function useAnchored<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return { ref, open, toggle, close, setOpen };
}

/** A menu shown as a field: the current choice (truncated in the middle) and a chevron. */
export function MenuField({
  label, items, height = 28, title,
}: {
  label: string;
  items: MenuItem[];
  height?: number;
  title?: string;
}) {
  const a = useAnchored<HTMLButtonElement>();
  return (
    <>
      <button
        ref={a.ref}
        className={`ctl-menu-field${a.open ? " open" : ""}`}
        style={{ height }}
        onClick={a.toggle}
        title={title}
        data-menu={label}
      >
        <span className="ctl-menu-field-label">{middleTruncate(label, 34)}</span>
        <Icon symbol="chevron.down" size={8.5} weight="bold" className="ctl-chevron" />
      </button>
      {a.open && a.ref.current && <PopupMenu anchor={a.ref.current} items={items} onClose={a.close} />}
    </>
  );
}

/** "A very long file name.cube" → "A very lo…name.cube", as macOS truncates in the middle. */
export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1, head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

// ---------------------------------------------------------------------------------------------
// Chip, curve menu, ramp button, shape pills

export function Chip({ label, on, onClick, title }: { label: string; on: boolean; onClick: () => void; title?: string }) {
  return (
    <button className={`ctl-chip${on ? " on" : ""}`} onClick={onClick} title={title} aria-pressed={on}>
      {label}
    </button>
  );
}

export const CURVE_LABEL: Record<FadeCurve, string> = {
  linear: "Linear", easeIn: "Exponential", easeOut: "Logarithmic", smooth: "S-Curve",
};
const CURVES: FadeCurve[] = ["linear", "easeIn", "easeOut", "smooth"];

/** A fade shape drawn small: rising for a fade in, falling for a fade out. */
export function CurveGlyph({ curve, rising, color, width = 20, height = 12 }: {
  curve: FadeCurve; rising: boolean; color: string; width?: number; height?: number;
}) {
  const pts: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const x = i / 20;
    const y = applyCurve(curve, rising ? x : 1 - x);
    pts.push(`${(1 + x * (width - 2)).toFixed(2)},${(1 + (1 - y) * (height - 2)).toFixed(2)}`);
  }
  return (
    <svg width={width} height={height} style={{ flex: "none", display: "block" }} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The fade shape menu: the curve (accent while the fade is on) and a chevron; four shapes. */
export function CurveMenu({ selection, rising, active, onPick }: {
  selection: FadeCurve; rising: boolean; active: boolean; onPick: (c: FadeCurve) => void;
}) {
  const a = useAnchored<HTMLButtonElement>();
  const items: MenuItem[] = CURVES.map((c) => ({
    label: CURVE_LABEL[c],
    checked: c === selection,
    icon: <span style={{ marginRight: 6, display: "flex" }}><CurveGlyph curve={c} rising={rising} color="currentColor" width={22} height={13} /></span>,
    onSelect: () => onPick(c),
  }));
  return (
    <>
      <button ref={a.ref} className={`ctl-curve${a.open ? " open" : ""}`} onClick={a.toggle} title={CURVE_LABEL[selection]}>
        <CurveGlyph curve={selection} rising={rising} color={active ? "var(--accent)" : "var(--text-dim)"} />
        <Icon symbol="chevron.down" size={7.5} weight="bold" className="ctl-chevron" />
      </button>
      {a.open && a.ref.current && <PopupMenu anchor={a.ref.current} items={items} onClose={a.close} matchWidth={false} />}
    </>
  );
}

/** A small ramp curve inside a value field: toggles a speed ramp (or a zoom move on Scale). */
export function RampButton({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      className={`ctl-ramp${on ? " on" : ""}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onPointerDown={(e) => e.stopPropagation()}
      title={title ?? (on ? "Remove the speed ramp" : "Speed ramp: ease into and out of the speed")}
      aria-pressed={on}
    >
      <svg width={11} height={8} viewBox="0 0 11 8" aria-hidden style={{ display: "block", overflow: "visible" }}>
        <path
          d="M0 8H2.42C4.62 8 4.4 0 6.6 0H11"
          fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** A graph's shape picked by name (In, In/Out, Out), in a small tray. */
export function ShapePills<M extends string>({ options, picked, onPick }: {
  options: { value: M; label: ReactNode; title: string }[];
  picked: M;
  onPick: (m: M) => void;
}) {
  return (
    <div className="ctl-pills">
      {options.map((o) => (
        <button key={o.value} className={`ctl-pill${picked === o.value ? " on" : ""}`} title={o.title} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Colour well and picker

/**
 * A colour well that opens PromptEdit's own picker (saturation/brightness square, hue strip, hex
 * field). There is no opacity control: alpha is kept as it is. `onChange` fires continuously;
 * `onDone` when the picker closes.
 */
export function ColourWell({ color, onChange, onDone, dim = false, title }: {
  color: RGBA;
  onChange: (c: RGBA) => void;
  onDone?: () => void;
  dim?: boolean;
  title?: string;
}) {
  const a = useAnchored<HTMLButtonElement>();
  const close = () => {
    a.close();
    onDone?.();
  };
  return (
    <>
      <button
        ref={a.ref}
        className={`ctl-well${a.open ? " open" : ""}`}
        style={dim ? { opacity: 0.4 } : undefined}
        onClick={() => (a.open ? close() : a.setOpen(true))}
        title={title ?? toHex(color)}
      >
        <div className="ctl-well-swatch" style={{ background: cssColor(color) }} />
      </button>
      {a.open && a.ref.current && (
        <Popover anchor={a.ref.current} placement="left" onClose={close}>
          <ColourPicker color={color} onChange={onChange} />
        </Popover>
      )}
    </>
  );
}

const SWATCHES = ["#FFFFFF", "#000000", "#FFD640", "#FF4A1C", "#F0503C", "#6CC08B", "#5B9BF0", "#B07CF0", "#292933"];

function ColourPicker({ color, onChange }: { color: RGBA; onChange: (c: RGBA) => void }) {
  // Hue and saturation are kept locally so they don't jump while the colour is black or grey.
  const [hsv, setHSV] = useState<HSV>(() => toHSV(color));
  const last = useRef<RGBA>(color);
  const [hex, setHex] = useState(toHex(color));

  useEffect(() => {
    if (!sameColour(color, last.current)) {
      last.current = color;
      setHSV(toHSV(color));
      setHex(toHex(color));
    }
  }, [color]);

  const set = (next: HSV) => {
    setHSV(next);
    const c = fromHSV(next, color.a);
    last.current = c;
    setHex(toHex(c));
    onChange(c);
  };
  const setRGB = (c: RGBA) => {
    last.current = c;
    setHSV(toHSV(c));
    setHex(toHex(c));
    onChange(c);
  };

  const sv = useDrag((fx, fy) => set({ h: hsv.h, s: fx, v: 1 - fy }));
  const hue = useDrag((fx) => set({ ...hsv, h: Math.min(0.9999, fx) }));
  const hueColour = cssColor(fromHSV({ h: hsv.h, s: 1, v: 1 }));
  const current = fromHSV(hsv, color.a);
  return (
    <div className="ctl-picker" onKeyDown={(e) => e.stopPropagation()}>
      <div className="ctl-picker-sv" style={{ backgroundColor: hueColour }} {...sv}>
        <div className="ctl-picker-puck" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: cssColor(current) }} />
      </div>
      <div className="ctl-picker-hue" {...hue}>
        <div className="ctl-picker-puck" style={{ left: `${hsv.h * 100}%`, background: hueColour }} />
      </div>
      <div className="ctl-picker-row">
        <div className="ctl-picker-preview" style={{ background: cssColor(current) }} />
        <input
          className="ctl-field"
          value={hex}
          spellCheck={false}
          onChange={(e) => {
            setHex(e.target.value);
            const c = fromHex(e.target.value, color.a);
            if (c) setRGB(c);
          }}
          onBlur={() => setHex(toHex(current))}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      </div>
      <div className="ctl-picker-swatches">
        {SWATCHES.map((s) => (
          <button key={s} className="ctl-picker-swatch" style={{ background: s }} title={s} onClick={() => setRGB(fromHex(s, color.a)!)} />
        ))}
      </div>
    </div>
  );
}

/** Pointer drag over an element, reporting the position as fractions of its box (0…1). */
function useDrag(onMove: (fx: number, fy: number) => void) {
  const dragging = useRef(false);
  const report = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onMove(
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    );
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      report(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (dragging.current) report(e); },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      dragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Colour wheel

const WHEEL = 78;
const REACH = WHEEL_REACH;

/**
 * A tint wheel: drag the puck toward a colour to push that tonal range toward it (red at 0°, green
 * at 120°, blue at 240°, y down). Double-click resets. Each drag is one gesture.
 */
export function ColourWheel({ title, point, live }: { title: string; point: WheelPoint; live: Gesture<WheelPoint> }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; dragging: boolean } | undefined>(undefined);
  const active = point.x !== 0 || point.y !== 0;
  const at = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return wheelPoint(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
  };
  const puck = dragging ? 13 : 11;
  return (
    <div className="ctl-wheel" data-wheel={title}>
      <div
        className={`ctl-wheel-disc${dragging ? " dragging" : ""}`}
        title={`Drag to tint ${title.toLowerCase()}. Double-click to reset.`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, y: e.clientY, dragging: false };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          // Two points of travel before it counts as a drag, so a double-click doesn't nudge it.
          if (!s.dragging) {
            if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 2) return;
            s.dragging = true;
            setDragging(true);
            live.begin();
          }
          live.change(at(e));
        }}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = undefined;
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (s?.dragging) {
            setDragging(false);
            live.end();
          }
        }}
        onDoubleClick={() => {
          live.begin();
          live.change({ x: 0, y: 0 });
          live.end();
        }}
      >
        <div className="ctl-wheel-ring" />
        <div className="ctl-wheel-cross-h" />
        <div className="ctl-wheel-cross-v" />
        <div
          className={`ctl-wheel-puck${active ? " active" : ""}`}
          style={{
            width: puck, height: puck,
            left: WHEEL / 2 + point.x * REACH - puck / 2,
            top: WHEEL / 2 + point.y * REACH - puck / 2,
          }}
        />
      </div>
      <span className={`ctl-wheel-label${active ? " active" : ""}`}>{title}</span>
    </div>
  );
}
