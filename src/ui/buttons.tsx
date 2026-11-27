// Shared controls (docs/spec/04-ui.md §2.4): IconButton, PillButton, Spinner, Segmented, Switch, KeyCap.
// Every colour comes from the theme's CSS variables, so all five themes work without code.
//
//   <IconButton symbol="repeat" active={loop} help="Loop Playback (L)" onClick={toggle} />
//   <PillButton prominent onClick={exportNow}>Export</PillButton>
//   <PillButton large onClick={cancel}>Cancel</PillButton>

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Glyph, type Weight } from "./icons";
import "./buttons.css";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title">;

export interface IconButtonProps extends ButtonProps {
  /** Any `Glyph` symbol. */
  symbol: string;
  /** "On" state: `ink(0.1)` fill and `text` glyph. */
  active?: boolean;
  /** Square side, default 28. The glyph is 46% of it. */
  size?: number;
  /** Tooltip. */
  help?: string;
  /** Moves the glyph down (positive) or up, for symbols whose weight sits off-centre. */
  nudge?: number;
  weight?: Weight;
  /** Glyph point size, when it shouldn't be 46% of `size`. */
  glyphSize?: number;
}

/** Square icon button with hover and optional "on" state (Theme.swift `IconButton`). */
export function IconButton({
  symbol, active = false, size = 28, help, nudge = 0, weight = "medium", glyphSize, className, style, ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`pe-icon-button${active ? " active" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, ...style }}
      title={help}
      aria-label={help}
      aria-pressed={active || undefined}
      {...rest}
    >
      <Glyph symbol={symbol} size={glyphSize ?? size * 0.46} weight={weight} style={nudge ? { transform: `translateY(${nudge}px)` } : undefined} />
    </button>
  );
}

export interface PillButtonProps extends ButtonProps {
  /** White (`text`) pill with `onText` label: the main action. */
  prominent?: boolean;
  /** Sheet footer size: padding 18 and the `button` fill for quiet pills. */
  large?: boolean;
  help?: string;
  children: ReactNode;
}

/** Capsule button (ExportSheet.swift `PillButton`). */
export function PillButton({ prominent = false, large = false, help, className, children, ...rest }: PillButtonProps) {
  return (
    <button
      type="button"
      className={`pe-pill${prominent ? " prominent" : " quiet"}${large ? " large" : ""}${className ? ` ${className}` : ""}`}
      title={help}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The small indeterminate spinner (`ProgressView().controlSize(.small)`). */
export function Spinner({ size = 14, style }: { size?: number; style?: CSSProperties }) {
  return <span className="pe-spinner" style={{ width: size, height: size, ...style }} aria-label="Working" />;
}

/** Segmented switch in the app's own greys (SettingsView.swift `SegmentedChoice`). */
export function Segmented<T extends string | number | boolean>({ options, value, onChange, mono = false }: {
  options: [T, string][]; value: T; onChange: (v: T) => void; mono?: boolean;
}) {
  return (
    <div className="pe-segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={v === value}
          className={`pe-segment${v === value ? " on" : ""}${mono ? " mono" : ""}`} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Small on/off switch, accent tinted (SwiftUI `.toggleStyle(.switch).controlSize(.small)`). */
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`pe-switch${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

/** A key in a shortcut ("⌘K", "Space"). */
export function KeyCap({ children }: { children: ReactNode }) {
  return <span className="pe-keycap">{children}</span>;
}
