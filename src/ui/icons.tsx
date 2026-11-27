// PromptEdit's icons (docs/spec/04-ui.md §2.5).
//
// - The app's own line-icon family, ported verbatim from Editroom's `Theme.swift` `LineIcon.path`:
//   a 16-point grid drawn with one 1.3-point round stroke, so they read as one family at any size.
// - `textformat` (a T in a frame) and `solid` (a filled 16:9 frame), Editroom's custom clip icons.
// - Stand-ins for the SF Symbols Editroom uses elsewhere (play, frame step, chevrons, film, …), drawn on
//   the same 16-point grid so they sit with the line icons. Their stroke grows with size and weight, as
//   SF Symbols do.
//
// Everything draws in `currentColor`, so colour comes from CSS (`color: var(--text-dim)` etc.).
//
//   <Glyph symbol="scissors" size={12} />     // size = the point size an SF Symbol would be drawn at
//   <LineIcon name="eye" size={16} />          // a line icon in a box of exactly `size`

import { useId, type CSSProperties, type ReactNode } from "react";

export type Weight = "light" | "regular" | "medium" | "semibold" | "bold" | "heavy";

/** Editroom's own line icons (Theme.swift `LineIcon.names`, plus its "textformat" glyph line form). */
export const LINE_ICONS = [
  "cursorarrow", "scissors", "square.and.arrow.down", "eye", "eye.slash", "lock", "repeat",
  "arrow.left.and.right", "arrow.up.left.and.arrow.down.right", "arrow.down.right.and.arrow.up.left", "trash",
] as const;
export type LineIconName = (typeof LINE_ICONS)[number];

const lineSet = new Set<string>(LINE_ICONS);

/** Line icon paths on the 16×16 grid, from `LineIcon.path(in:)`. */
const LINE_PATHS: Record<LineIconName, string> = {
  cursorarrow: "M3 2L13 8.2L8.6 9.1L11.1 13.5L9.5 14.4L7 10L3.6 12Z",
  scissors:
    "M6.3 12A2.3 2.3 0 1 1 1.7 12A2.3 2.3 0 1 1 6.3 12Z M14.3 12A2.3 2.3 0 1 1 9.7 12A2.3 2.3 0 1 1 14.3 12Z " +
    "M5.6 10.4L13 2 M10.4 10.4L3 2",
  "square.and.arrow.down": "M8 1.5L8 10 M5 7L8 10L11 7 M3 9.5L3 12.5Q3 14 4.5 14L11.5 14Q13 14 13 12.5L13 9.5",
  eye: "M1.5 8Q8 1 14.5 8Q8 15 1.5 8 M10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8Z",
  "eye.slash": "M1.5 8Q8 1 14.5 8Q8 15 1.5 8 M10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8Z M2.5 13.5L13.5 2.5",
  lock:
    "M4.5 7L11.5 7Q13 7 13 8.5L13 13Q13 14.5 11.5 14.5L4.5 14.5Q3 14.5 3 13L3 8.5Q3 7 4.5 7Z " +
    "M5.2 7L5.2 5A2.8 2.8 0 0 1 10.8 5L10.8 7",
  repeat:
    "M2 7L2 6Q2 3.5 4.5 3.5L13 3.5 M11 1.5L13 3.5L11 5.5 M14 9L14 10Q14 12.5 11.5 12.5L3 12.5 M5 14.5L3 12.5L5 10.5",
  "arrow.left.and.right": "M1.5 8L14.5 8 M4.5 5L1.5 8L4.5 11 M11.5 5L14.5 8L11.5 11",
  "arrow.up.left.and.arrow.down.right": "M2 6L2 2L6 2 M2 2L6.5 6.5 M14 10L14 14L10 14 M14 14L9.5 9.5",
  "arrow.down.right.and.arrow.up.left": "M6.5 2.5L6.5 6.5L2.5 6.5 M2 2L6.5 6.5 M9.5 13.5L9.5 9.5L13.5 9.5 M14 14L9.5 9.5",
  trash: "M2.5 4.5L13.5 4.5 M6 4.5L6 3L10 3L10 4.5 M4 4.5L4.7 13.5L11.3 13.5L12 4.5",
};

const svgBase: CSSProperties = { display: "block", flex: "none", overflow: "visible" };

/** One of Editroom's line icons in a `size`×`size` box, stroked 1.3 pt whatever the size. */
export function LineIcon({ name, size = 16, strokeWidth = 1.3, style, className }: {
  name: LineIconName; size?: number; strokeWidth?: number; style?: CSSProperties; className?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ ...svgBase, ...style }} className={className} aria-hidden>
      <path d={LINE_PATHS[name]} fill="none" stroke="currentColor" strokeWidth={strokeWidth}
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The text clip icon: a T inside a rounded frame, on a 17 × 13 grid (Theme.swift `TextFrameIcon`). */
export function TextFrameIcon({ width = 17, height = 13, lineWidth = 1.3, style }: {
  width?: number; height?: number; lineWidth?: number; style?: CSSProperties;
}) {
  const h = lineWidth / 2, sx = width / 17, sy = height / 13;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ ...svgBase, ...style }} aria-hidden>
      <rect x={h} y={h} width={width - lineWidth} height={height - lineWidth} rx={2.2} fill="none" stroke="currentColor" strokeWidth={lineWidth} />
      <path d={`M${5 * sx} ${4 * sy}L${12 * sx} ${4 * sy} M${8.5 * sx} ${4 * sy}L${8.5 * sx} ${9.5 * sy}`}
        fill="none" stroke="currentColor" strokeWidth={lineWidth} strokeLinecap="round" />
    </svg>
  );
}

/** The solid clip icon: a 16:9 frame filled with colour (Theme.swift `SolidIcon`). */
export function SolidIcon({ width = 17, height = 13, lineWidth = 1.3, style }: {
  width?: number; height?: number; lineWidth?: number; style?: CSSProperties;
}) {
  const h = lineWidth / 2, inset = lineWidth + 1.1;
  const ow = width - lineWidth, oh = height - lineWidth;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ ...svgBase, ...style }} aria-hidden>
      <rect x={h} y={h} width={ow} height={oh} rx={2.2} fill="none" stroke="currentColor" strokeWidth={lineWidth} />
      <rect x={h + inset} y={h + inset} width={Math.max(0, ow - 2 * inset)} height={Math.max(0, oh - 2 * inset)} rx={1} fill="currentColor" />
    </svg>
  );
}

// ---- SF Symbol stand-ins ----

type Draw = (sw: number, id: string) => ReactNode;
const S = (d: string, sw: number, extra: Record<string, unknown> = {}) => (
  <path d={d} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
    vectorEffect="non-scaling-stroke" {...extra} />
);
const F = (d: string, extra: Record<string, unknown> = {}) => <path d={d} fill="currentColor" {...extra} />;
/** A filled shape with a stroked mark knocked out of it (xmark.circle.fill and friends). */
const knockout = (id: string, shape: ReactNode, mark: string, sw: number, markFill = false) => (
  <>
    <defs>
      <mask id={id} maskUnits="userSpaceOnUse" x="-2" y="-2" width="20" height="20">
        <rect x="-2" y="-2" width="20" height="20" fill="white" />
        {markFill
          ? <path d={mark} fill="black" />
          : <path d={mark} fill="none" stroke="black" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      </mask>
    </defs>
    <g mask={`url(#${id})`}>{shape}</g>
  </>
);

function gearPath(): string {
  // Eight teeth around a ring, as `gearshape`.
  const pts: string[] = [];
  const teeth = 8, rOut = 7, rIn = 5.4;
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 4 === 0 || i % 4 === 1 ? rOut : rIn;
    pts.push(`${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z M10.3 8A2.3 2.3 0 1 1 5.7 8A2.3 2.3 0 1 1 10.3 8Z`;
}
const GEAR = gearPath();
const sparkle = (cx: number, cy: number, r: number) =>
  `M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`;

const SYMBOLS: Record<string, Draw> = {
  // Transport
  "play.fill": () => F("M4.6 2.6Q4.6 1.9 5.2 2.2L13.4 7.4Q14 7.9 13.4 8.4L5.2 13.6Q4.6 13.9 4.6 13.2Z"),
  "pause.fill": () => <><rect x="3.6" y="2.5" width="3" height="11" rx="0.8" fill="currentColor" /><rect x="9.4" y="2.5" width="3" height="11" rx="0.8" fill="currentColor" /></>,
  "stop.fill": () => <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />,
  "backward.end.fill": () => <><rect x="2.5" y="3" width="1.9" height="10" rx="0.6" fill="currentColor" />{F("M13.5 3.6Q13.5 2.8 12.8 3.3L5.6 7.5Q5 8 5.6 8.5L12.8 12.7Q13.5 13.2 13.5 12.4Z")}</>,
  "forward.end.fill": () => <><rect x="11.6" y="3" width="1.9" height="10" rx="0.6" fill="currentColor" />{F("M2.5 3.6Q2.5 2.8 3.2 3.3L10.4 7.5Q11 8 10.4 8.5L3.2 12.7Q2.5 13.2 2.5 12.4Z")}</>,
  "backward.frame.fill": () => <><rect x="11" y="3" width="2.4" height="10" rx="0.7" fill="currentColor" />{F("M9.6 3.7Q9.6 2.9 8.9 3.4L2.9 7.5Q2.3 8 2.9 8.5L8.9 12.6Q9.6 13.1 9.6 12.3Z")}</>,
  "forward.frame.fill": () => <><rect x="2.6" y="3" width="2.4" height="10" rx="0.7" fill="currentColor" />{F("M6.4 3.7Q6.4 2.9 7.1 3.4L13.1 7.5Q13.7 8 13.1 8.5L7.1 12.6Q6.4 13.1 6.4 12.3Z")}</>,
  // Chevrons and arrows
  "chevron.down": (sw) => S("M3.5 6L8 10.5L12.5 6", sw),
  "chevron.up": (sw) => S("M3.5 10L8 5.5L12.5 10", sw),
  "chevron.right": (sw) => S("M6 3.5L10.5 8L6 12.5", sw),
  "chevron.left": (sw) => S("M10 3.5L5.5 8L10 12.5", sw),
  "arrow.right": (sw) => S("M2 8L14 8 M9.5 3.5L14 8L9.5 12.5", sw),
  "arrow.down": (sw) => S("M8 2L8 14 M3.5 9.5L8 14L12.5 9.5", sw),
  "arrow.up.and.down": (sw) => S("M8 1.5L8 14.5 M5 4.5L8 1.5L11 4.5 M5 11.5L8 14.5L11 11.5", sw),
  "arrow.down.to.line": (sw) => S("M8 1.5L8 11 M4 7L8 11L12 7 M2.5 14L13.5 14", sw),
  "arrow.right.to.line": (sw) => S("M1.5 8L11 8 M7 4L11 8L7 12 M14 2.5L14 13.5", sw),
  "arrow.right.from.line": (sw) => S("M2 2.5L2 13.5 M5 8L14.5 8 M10.5 4L14.5 8L10.5 12", sw),
  "arrow.uturn.backward": (sw) => S("M5.5 3L2.5 6L5.5 9 M2.5 6L10 6Q13.5 6 13.5 9.5Q13.5 13 10 13L6 13", sw),
  "arrow.uturn.forward": (sw) => S("M10.5 3L13.5 6L10.5 9 M13.5 6L6 6Q2.5 6 2.5 9.5Q2.5 13 6 13L10 13", sw),
  "arrow.down.circle": (sw) => S("M14.5 8A6.5 6.5 0 1 1 1.5 8A6.5 6.5 0 1 1 14.5 8Z M8 4.5L8 11 M5.2 8.4L8 11.2L10.8 8.4", sw),
  "square.and.arrow.up": (sw) => S("M8 10L8 1.5 M5 4.5L8 1.5L11 4.5 M5.5 7L4.5 7Q3 7 3 8.5L3 13Q3 14.5 4.5 14.5L11.5 14.5Q13 14.5 13 13L13 8.5Q13 7 11.5 7L10.5 7", sw),
  // Marks
  xmark: (sw) => S("M3.5 3.5L12.5 12.5 M12.5 3.5L3.5 12.5", sw),
  checkmark: (sw) => S("M2.5 8.5L6.2 12.2L13.5 3.8", sw),
  plus: (sw) => S("M8 2.5L8 13.5 M2.5 8L13.5 8", sw),
  minus: (sw) => S("M2.5 8L13.5 8", sw),
  ellipsis: () => <><circle cx="3" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="13" cy="8" r="1.3" fill="currentColor" /></>,
  "xmark.circle": (sw) => S("M14.5 8A6.5 6.5 0 1 1 1.5 8A6.5 6.5 0 1 1 14.5 8Z M5.6 5.6L10.4 10.4 M10.4 5.6L5.6 10.4", sw),
  "xmark.circle.fill": (sw, id) => knockout(id, <circle cx="8" cy="8" r="7" fill="currentColor" />, "M5.6 5.6L10.4 10.4 M10.4 5.6L5.6 10.4", Math.max(1.4, sw)),
  "checkmark.circle.fill": (sw, id) => knockout(id, <circle cx="8" cy="8" r="7" fill="currentColor" />, "M4.9 8.3L7.1 10.5L11.2 5.8", Math.max(1.5, sw)),
  "exclamationmark.triangle.fill": (_sw, id) => knockout(id,
    F("M7 2.2Q8 0.6 9 2.2L15 12.6Q15.8 14.2 14 14.2L2 14.2Q0.2 14.2 1 12.6Z"),
    "M7.25 5.2L8.75 5.2L8.5 9.6L7.5 9.6Z M8 10.6A0.95 0.95 0 1 1 8 12.5A0.95 0.95 0 1 1 8 10.6Z", 0, true),
  // Things
  film: (sw) => S("M3.5 2.5L12.5 2.5Q14 2.5 14 4L14 12Q14 13.5 12.5 13.5L3.5 13.5Q2 13.5 2 12L2 4Q2 2.5 3.5 2.5Z M5 2.5L5 13.5 M11 2.5L11 13.5 M2 5.5L5 5.5 M2 8L5 8 M2 10.5L5 10.5 M11 5.5L14 5.5 M11 8L14 8 M11 10.5L14 10.5", sw),
  photo: (sw) => S("M3 3L13 3Q14.5 3 14.5 4.5L14.5 11.5Q14.5 13 13 13L3 13Q1.5 13 1.5 11.5L1.5 4.5Q1.5 3 3 3Z M1.8 11L5.5 7.3L8.6 10.2L10.4 8.5L14.3 12 M11.6 5.9A1.1 1.1 0 1 1 9.4 5.9A1.1 1.1 0 1 1 11.6 5.9Z", sw),
  waveform: (sw) => S("M2 6.5L2 9.5 M4.4 4.5L4.4 11.5 M6.8 2L6.8 14 M9.2 5L9.2 11 M11.6 3.5L11.6 12.5 M14 6.5L14 9.5", sw),
  folder: (sw) => S("M1.5 4.5Q1.5 3 3 3L6 3L7.6 4.6L13 4.6Q14.5 4.6 14.5 6.1L14.5 11.5Q14.5 13 13 13L3 13Q1.5 13 1.5 11.5Z M1.5 6.6L14.5 6.6", sw),
  doc: (sw) => S("M4 1.5L9.5 1.5L13 5L13 13Q13 14.5 11.5 14.5L4.5 14.5Q3 14.5 3 13L3 3Q3 1.5 4.5 1.5 M9.5 1.5L9.5 5L13 5", sw),
  display: (sw) => S("M2.5 2.5L13.5 2.5Q15 2.5 15 4L15 10Q15 11.5 13.5 11.5L2.5 11.5Q1 11.5 1 10L1 4Q1 2.5 2.5 2.5Z M5.5 14L10.5 14 M8 11.5L8 14", sw),
  rectangle: (sw) => S("M2.5 3.5L13.5 3.5Q15 3.5 15 5L15 11Q15 12.5 13.5 12.5L2.5 12.5Q1 12.5 1 11L1 5Q1 3.5 2.5 3.5Z", sw),
  "rectangle.on.rectangle": (sw) => S("M5.5 5L13 5Q14.5 5 14.5 6.5L14.5 12Q14.5 13.5 13 13.5L5.5 13.5Q4 13.5 4 12L4 6.5Q4 5 5.5 5Z M1.5 9.5L1.5 4Q1.5 2.5 3 2.5L11 2.5", sw),
  "square.stack": (sw) => S("M4 6L12 6Q13.5 6 13.5 7.5L13.5 12.5Q13.5 14 12 14L4 14Q2.5 14 2.5 12.5L2.5 7.5Q2.5 6 4 6Z M4 3.8L12 3.8 M5.5 1.7L10.5 1.7", sw),
  magnifyingglass: (sw) => S("M11.5 7A4.5 4.5 0 1 1 2.5 7A4.5 4.5 0 1 1 11.5 7Z M10.3 10.3L14 14", sw),
  "text.bubble": (sw) => S("M3 2L13 2Q14.5 2 14.5 3.5L14.5 9.5Q14.5 11 13 11L7 11L3.8 14L3.8 11L3 11Q1.5 11 1.5 9.5L1.5 3.5Q1.5 2 3 2Z M4.5 5L11.5 5 M4.5 8L9.5 8", sw),
  "captions.bubble": (sw) => S("M3 2L13 2Q14.5 2 14.5 3.5L14.5 9.5Q14.5 11 13 11L7 11L3.8 14L3.8 11L3 11Q1.5 11 1.5 9.5L1.5 3.5Q1.5 2 3 2Z M7 5.2Q6.4 4.6 5.6 4.6Q4.2 4.6 4.2 6.5Q4.2 8.4 5.6 8.4Q6.4 8.4 7 7.8 M11.8 5.2Q11.2 4.6 10.4 4.6Q9 4.6 9 6.5Q9 8.4 10.4 8.4Q11.2 8.4 11.8 7.8", sw),
  keyboard: (sw) => S("M2.5 3.5L13.5 3.5Q15 3.5 15 5L15 11Q15 12.5 13.5 12.5L2.5 12.5Q1 12.5 1 11L1 5Q1 3.5 2.5 3.5Z M3.5 6L3.5 6 M6 6L6 6 M8.5 6L8.5 6 M11 6L11 6 M12.5 6L12.5 6 M4.5 8L4.5 8 M7 8L7 8 M9.5 8L9.5 8 M12 8L12 8 M5 10.2L11 10.2", sw),
  gearshape: (sw) => S(GEAR, sw),
  "wand.and.sparkles": (sw) => <>{S("M2 14L10 6", sw * 1.25)}{F(sparkle(12, 3.5, 2.6))}{F(sparkle(5.6, 3, 1.6))}{F(sparkle(13, 10, 1.6))}</>,
  "wand.and.stars": (sw) => <>{S("M2 14L10 6", sw * 1.25)}{F(sparkle(12, 3.5, 2.6))}{F(sparkle(5.6, 3, 1.6))}</>,
  sparkles: () => <>{F(sparkle(9.5, 6.5, 5))}{F(sparkle(3.6, 3, 2))}{F(sparkle(4, 12.5, 1.8))}</>,
  clock: (sw) => S("M14.5 8A6.5 6.5 0 1 1 1.5 8A6.5 6.5 0 1 1 14.5 8Z M8 4L8 8L10.8 9.6", sw),
  "clock.arrow.circlepath": (sw) => S("M2.6 9.8A5.8 5.8 0 1 0 2.4 6.4 M1 4.4L2.4 6.6L4.6 5.4 M8.3 5L8.3 8.4L10.6 9.7", sw),
  paintbrush: (sw) => S("M14 2L8 8.6 M8 8.6L7 7.6 M7.4 8.2Q5.6 8 4.6 9.4Q4 10.3 3.8 12Q3.6 13.4 2 14Q5.4 14.4 7 13Q8.5 11.6 8 9.4", sw),
  "sun.max": (sw) => S("M10.8 8A2.8 2.8 0 1 1 5.2 8A2.8 2.8 0 1 1 10.8 8Z M8 1.2L8 2.6 M8 13.4L8 14.8 M1.2 8L2.6 8 M13.4 8L14.8 8 M3.2 3.2L4.2 4.2 M11.8 11.8L12.8 12.8 M3.2 12.8L4.2 11.8 M11.8 4.2L12.8 3.2", sw),
  "circle.lefthalf.filled": (sw) => <>{S("M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8Z", sw)}{F("M8 2A6 6 0 0 0 8 14Z")}</>,
  drop: (sw) => S("M8 1.8Q12.8 7.4 12.8 10Q12.8 14.6 8 14.6Q3.2 14.6 3.2 10Q3.2 7.4 8 1.8Z", sw),
  "thermometer.medium": (sw) => <>{S("M6.4 9.6L6.4 3.4A1.6 1.6 0 0 1 9.6 3.4L9.6 9.6A3 3 0 1 1 6.4 9.6Z", sw)}<circle cx="8" cy="11.9" r="1.5" fill="currentColor" /><path d="M8 7L8 11" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" vectorEffect="non-scaling-stroke" /></>,
  eyedropper: (sw) => S("M10.5 2.5Q12 1 13.5 2.5Q15 4 13.5 5.5L12 7L9 4Z M10.5 5.5L3.5 12.5L3 14.5L3.5 13L5 13L12 6", sw),
  "camera.filters": (sw) => S("M11.6 6A3.6 3.6 0 1 1 4.4 6A3.6 3.6 0 1 1 11.6 6Z M9.6 10.4A3.6 3.6 0 1 1 2.4 10.4A3.6 3.6 0 1 1 9.6 10.4Z M13.6 10.4A3.6 3.6 0 1 1 6.4 10.4A3.6 3.6 0 1 1 13.6 10.4Z", sw),
  "speaker.wave.2": (sw) => S("M2 6L4.6 6L8 3L8 13L4.6 10L2 10Z M10.3 5.8Q11.4 8 10.3 10.2 M12.4 4Q14.6 8 12.4 12", sw),
  "gauge.with.dots.needle.33percent": (sw) => <>{S("M14.5 8A6.5 6.5 0 1 1 1.5 8A6.5 6.5 0 1 1 14.5 8Z M8 9L5.4 5.6", sw)}<circle cx="8" cy="9" r="1.2" fill="currentColor" /></>,
  "slider.horizontal.3": (sw) => S("M2 4L14 4 M2 8L14 8 M2 12L14 12 M5 2.6L5 5.4 M10.5 6.6L10.5 9.4 M7 10.6L7 13.4", sw),
  "music.note": (sw) => <>{S("M6.5 12L6.5 2.5L13 1.5L13 10", sw)}<ellipse cx="4.8" cy="12.2" rx="2" ry="1.6" fill="currentColor" /><ellipse cx="11.3" cy="10.2" rx="2" ry="1.6" fill="currentColor" /></>,
  "person.wave.2": (sw) => S("M9.4 5A1.9 1.9 0 1 1 5.6 5A1.9 1.9 0 1 1 9.4 5Z M3.5 14Q3.5 9 7.5 9Q11.5 9 11.5 14 M12.4 3.4Q13.6 5 12.4 6.6 M14.2 2Q16 5 14.2 8", sw),
  lightbulb: (sw) => S("M6 11.5Q6 9.6 4.8 8.4Q3.5 7.1 3.5 5.5Q3.5 1.5 8 1.5Q12.5 1.5 12.5 5.5Q12.5 7.1 11.2 8.4Q10 9.6 10 11.5Z M6.3 13.5L9.7 13.5", sw),
  highlighter: (sw) => S("M10.5 2L14 5.5L7.5 12L4 8.5Z M4 8.5L2.5 12.5L3.5 13.5L7.5 12 M2 14.5L6 14.5", sw),
  "a.square": (sw) => S("M3.5 1.5L12.5 1.5Q14.5 1.5 14.5 3.5L14.5 12.5Q14.5 14.5 12.5 14.5L3.5 14.5Q1.5 14.5 1.5 12.5L1.5 3.5Q1.5 1.5 3.5 1.5Z M5 11.5L8 4L11 11.5 M6.1 9L9.9 9", sw),
  "textformat.size": (sw) => S("M1.5 12.5L4.5 5L7.5 12.5 M2.5 10L6.5 10 M8 12.5L11.5 3L15 12.5 M9.2 9.5L13.8 9.5", sw),
  "circle.dashed": (sw) => S("M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8Z", sw, { strokeDasharray: "2 2.2" }),
  "circle.dotted": (sw) => S("M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8Z", sw, { strokeDasharray: "0.1 2.6" }),
  "square.fill": () => <rect x="2" y="2" width="12" height="12" rx="2.5" fill="currentColor" />,
  "circle.fill": () => <circle cx="8" cy="8" r="6" fill="currentColor" />,
  circle: (sw) => S("M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8Z", sw),
  "arrow.triangle.branch": (sw) => S("M4 14L4 2 M4 9Q4 6 8 6L12 6 M10 4L12 6L10 8", sw),
  "info.circle": (sw) => S("M14.5 8A6.5 6.5 0 1 1 1.5 8A6.5 6.5 0 1 1 14.5 8Z M8 7.2L8 11.5 M8 4.8L8 4.9", sw),
  "minus.circle": (sw) => S("M14.5 8A6.5 6.5 0 1 1 1.5 8A6.5 6.5 0 1 1 14.5 8Z M5 8L11 8", sw),
  "plus.circle": (sw) => S("M14.5 8A6.5 6.5 0 1 1 1.5 8A6.5 6.5 0 1 1 14.5 8Z M5 8L11 8 M8 5L8 11", sw),
  "arrow.clockwise": (sw) => S("M13.3 8.5A5.4 5.4 0 1 1 11.6 4 M12.2 1.6L12 4.4L9.2 4.2", sw),
  "window.minimize": (sw) => S("M3 8L13 8", sw),
  "window.maximize": (sw) => S("M3.5 3.5L12.5 3.5L12.5 12.5L3.5 12.5Z", sw),
  "window.restore": (sw) => S("M3.5 5.5L10.5 5.5L10.5 12.5L3.5 12.5Z M5.5 5.5L5.5 3.5L12.5 3.5L12.5 10.5L10.5 10.5", sw),
  "window.close": (sw) => S("M3.5 3.5L12.5 12.5 M12.5 3.5L3.5 12.5", sw),
  line: (sw) => S("M2 8L14 8", sw),
};

const WEIGHT: Record<Weight, number> = { light: 1.0, regular: 1.2, medium: 1.35, semibold: 1.6, bold: 1.85, heavy: 2.1 };

/** Every symbol `Glyph` can draw. */
export const SYMBOL_NAMES: string[] = [...LINE_ICONS, "textformat", "solid", ...Object.keys(SYMBOLS)];

export interface GlyphProps {
  /** A line icon, "textformat"/"solid", or an SF Symbol name from `SYMBOL_NAMES`. */
  symbol: string;
  /** The point size an SF Symbol would be drawn at (line icons are sized to match, as in Editroom). */
  size?: number;
  weight?: Weight;
  style?: CSSProperties;
  className?: string;
  title?: string;
}

/**
 * An icon by SF Symbol name, drawn from the app's own line set where it has one (Theme.swift `Glyph`).
 * Unknown names draw nothing (and warn in development) rather than crash.
 */
export function Glyph({ symbol, size = 12, weight = "medium", style, className, title }: GlyphProps) {
  const id = useId().replace(/:/g, "");
  const wrap = (node: ReactNode) =>
    title ? <span title={title} style={{ display: "inline-flex" }}>{node}</span> : node;
  if (lineSet.has(symbol)) {
    return wrap(<LineIcon name={symbol as LineIconName} size={size * 1.2} style={style} className={className} />);
  }
  if (symbol === "solid") return wrap(<SolidIcon width={size * 1.15} height={size * 0.86} style={style} />);
  if (symbol === "textformat") return wrap(<TextFrameIcon width={size * 1.15} height={size * 0.86} style={style} />);
  const draw = SYMBOLS[symbol];
  if (!draw) {
    if (import.meta.env.DEV) console.warn(`Glyph: no icon named "${symbol}"`);
    return null;
  }
  // SF Symbols' strokes grow with size; at 13 pt a medium symbol's stroke is about 1.35 pt.
  const sw = (WEIGHT[weight] * size) / 13;
  const box = size * 1.2;
  return wrap(
    <svg width={box} height={box} viewBox="0 0 16 16" style={{ ...svgBase, ...style }} className={className} aria-hidden>
      {draw(sw, `g${id}`)}
    </svg>,
  );
}
