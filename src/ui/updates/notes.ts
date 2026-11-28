// Pure helpers for updates: what's new, version order, download sizes, when to check.
// Kept free of React and Tauri so they're unit-tested (notes.test.ts).

/**
 * What's new in an update, a change a line (docs/spec/04-ui.md §6.1). The release notes are plain
 * text, one change per line; a leading bullet ("• ", "- ", "* ") is taken off and blank lines
 * dropped, the same as Editroom's `<changes>` (but "-5%" or "**bold**" keep their first character).
 * Markdown headings ("## What's new") aren't changes either: GitHub's release editor adds them, and
 * the alert has its own heading.
 */
export function changeLines(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^(?:•\s*|[-*]\s+)+/, "").trim())
    .filter((line) => line.length > 0);
}

interface Parsed { core: number[]; pre: (string | number)[] }

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return null;
  return {
    core: [m[1], m[2] ?? "0", m[3] ?? "0"].map(Number),
    pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/**
 * Semantic-version order: negative if `a` is older than `b`, 0 if the same, positive if newer.
 * A pre-release is older than its release (1.2.0-beta.2 < 1.2.0); build metadata is ignored; a
 * leading "v" (a tag name) is allowed. Versions that don't parse compare as text, so they're at
 * least consistent.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether an automatic check passes this update by: the person chose Skip This Version for it (or
 * for a newer one). A check they start themselves always offers it, as Sparkle does.
 */
export function isSkipped(version: string, skipped: string | null | undefined): boolean {
  return !!skipped && compareVersions(version, skipped) <= 0;
}

/** How often automatic checks run: once a day, Sparkle's default. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether an automatic check is due, given when the last one ran (ms since the epoch). */
export function checkDue(lastCheck: number | null, now: number, interval = CHECK_INTERVAL_MS): boolean {
  // A last check in the future means the clock moved back: check rather than wait for it.
  return lastCheck === null || now - lastCheck >= interval || lastCheck > now;
}

/** "12.3 MB", in decimal units like Finder and Explorer. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The progress line under the download bar: "12.3 MB of 80 MB", or just what's arrived. */
export function downloadProgressText(received: number, total: number | null): string {
  return total ? `${formatBytes(Math.min(received, total))} of ${formatBytes(total)}` : formatBytes(received);
}
