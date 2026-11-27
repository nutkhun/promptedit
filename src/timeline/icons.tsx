// The app's line icons used by the timeline, ported from Editroom's Theme.swift `LineIcon` paths
// (16-pt grid, 1.3 pt round strokes).

const PATHS: Record<string, string> = {
  cursorarrow: "M3 2L13 8.2L8.6 9.1L11.1 13.5L9.5 14.4L7 10L3.6 12Z",
  scissors:
    "M6.3 12A2.3 2.3 0 1 1 1.7 12A2.3 2.3 0 1 1 6.3 12Z M14.3 12A2.3 2.3 0 1 1 9.7 12A2.3 2.3 0 1 1 14.3 12Z M5.6 10.4L13 2 M10.4 10.4L3 2",
  eye: "M1.5 8Q8 1 14.5 8Q8 15 1.5 8Z M10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8Z",
  "eye.slash": "M1.5 8Q8 1 14.5 8Q8 15 1.5 8Z M10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8Z M2.5 13.5L13.5 2.5",
  lock: "M4.5 7H11.5Q13 7 13 8.5V13Q13 14.5 11.5 14.5H4.5Q3 14.5 3 13V8.5Q3 7 4.5 7Z M5.2 7V5A2.8 2.8 0 0 1 10.8 5V7",
  "arrow.left.and.right": "M1.5 8H14.5 M4.5 5L1.5 8L4.5 11 M11.5 5L14.5 8L11.5 11",
  trash: "M2.5 4.5H13.5 M6 4.5V3H10V4.5 M4 4.5L4.7 13.5H11.3L12 4.5",
};

export function LineIcon({ name, size }: { name: keyof typeof PATHS | string; size: number }) {
  // Line icons are drawn at 1.2× the size a system symbol would be (Glyph in Theme.swift).
  const s = size * 1.2;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
