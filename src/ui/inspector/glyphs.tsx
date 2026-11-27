// Icons for the inspector. Everything the app's shared icon set draws (src/ui/icons.tsx: Editroom's
// line icons and SF Symbol stand-ins) comes from there; this adds the few the inspector alone uses:
// the fade-in / fade-out row icons (an arrow against a bar, as Editroom draws them), a timer, and
// the compact "into the line" arrow for the Out transition.

import type { CSSProperties } from "react";
import { Glyph as SharedGlyph, type Weight } from "../icons";

const LOCAL: Record<string, string> = {
  // Editroom's RowIcon.fadeIn: arrow.right 9 pt + a 1.5 × 10 bar.
  fadeIn: "M1.5 8L10 8 M6.8 4.8L10 8L6.8 11.2 M13.5 3L13.5 13",
  fadeOut: "M2.5 3L2.5 13 M5.8 8L14.3 8 M11.1 4.8L14.3 8L11.1 11.2",
  timer: "M13.5 9A5.5 5.5 0 1 1 2.5 9A5.5 5.5 0 1 1 13.5 9Z M8 9L8 6.2 M6.3 1.8L9.7 1.8 M8 1.8L8 3.5",
  "arrow.right.to.line.compact": "M3 8L10.5 8 M7.6 5.2L10.5 8L7.6 10.8 M13 4.5L13 11.5",
};

const STROKE: Record<Weight, number> = { light: 1.0, regular: 1.2, medium: 1.35, semibold: 1.6, bold: 1.85, heavy: 2.1 };

/** An icon by SF Symbol name (as Editroom names them), `size` in points like an SF Symbol. */
export function Icon({ symbol, size = 11, weight = "medium", style, className }: {
  symbol: string;
  size?: number;
  weight?: Weight;
  style?: CSSProperties;
  className?: string;
}) {
  const d = LOCAL[symbol];
  if (!d) return <SharedGlyph symbol={symbol} size={size} weight={weight} style={style} className={className} />;
  const box = size * 1.2;
  return (
    <svg width={box} height={box} viewBox="0 0 16 16" style={{ display: "block", flex: "none", ...style }} className={className} aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={(STROKE[weight] * size) / 13}
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
