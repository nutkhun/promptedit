// What the prompt box needs from Editroom's `MagicMention` and `MagicTimes`: which runs of text are
// mentions (`@playhead`, `@selected`, `@in-out`, `@<file>`, `@clip:<label>`, `@marker:<name>`) or
// times Magic reads as places, for showing them strong; and the @ list. The brief itself is written
// in Rust (src-tauri/src/magic/mentions.rs), from the same rules.

import type { Clip, Id, MediaAsset, Project } from "../../model";
import { projectDuration } from "../../timing";

export interface ClipLabel { id: Id; name: string; kind: Clip["kind"]; track: string; start: number }
export interface MarkerLabel { id: Id; name: string; time: number; tint: string }

const trackOrder = (p: Project, id: Id) => {
  const v = p.videoTracks.findIndex((t) => t.id === id);
  if (v >= 0) return p.videoTracks.length - v;
  return p.videoTracks.length + 1 + Math.max(0, p.audioTracks.findIndex((t) => t.id === id));
};

const trackName = (p: Project, id: Id) => {
  const v = p.videoTracks.findIndex((t) => t.id === id);
  return v >= 0 ? `V${v + 1}` : `A${p.audioTracks.findIndex((t) => t.id === id) + 1}`;
};

export function clipName(p: Project, c: Clip): string {
  if (c.kind === "text") return (c.text?.string ?? "").replace(/\n/g, " ") || "Text";
  if (c.kind === "solid") return "Solid";
  return p.assets.find((a) => a.id === c.assetID)?.name ?? "Missing";
}

/** Timeline clips as `@clip:` names them; a video's own sound isn't listed apart from it. */
export function clipLabels(p: Project): ClipLabel[] {
  const videoLinks = new Set(p.clips.filter((c) => c.kind !== "audio").map((c) => c.linkID).filter(Boolean));
  const clips = p.clips
    .filter((c) => !(c.kind === "audio" && c.linkID && videoLinks.has(c.linkID)))
    .sort((a, b) => a.start - b.start || trackOrder(p, a.trackID) - trackOrder(p, b.trackID));
  const seen = new Map<string, number>();
  return clips.map((c) => {
    let b = clipName(p, c).trim();
    if (c.kind === "text" && [...b].length > 24) b = [...b].slice(0, 22).join("").trim() + "…";
    const n = (seen.get(b.toLowerCase()) ?? 0) + 1;
    seen.set(b.toLowerCase(), n);
    return { id: c.id, name: n === 1 ? b : `${b}·${n}`, kind: c.kind, track: trackName(p, c.trackID), start: c.start };
  });
}

export function markerLabels(p: Project): MarkerLabel[] {
  const seen = new Map<string, number>();
  return [...(p.markers ?? [])].sort((a, b) => a.time - b.time).map((m) => {
    const tint = m.tint ?? "yellow";
    const b = m.name.trim() || `${tint.charAt(0).toUpperCase()}${tint.slice(1)} marker`;
    const n = (seen.get(b.toLowerCase()) ?? 0) + 1;
    seen.set(b.toLowerCase(), n);
    return { id: m.id, name: n === 1 ? b : `${b}·${n}`, time: m.time, tint };
  });
}

/** A clock for the @ list: m:ss.s. */
export const clock = (t: number) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
};

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
const bare = (name: string) => name.replace(/\.[^.\s]+$/, "");

/** Every mention's [start, end) in the text, longest name first, whole names only. */
export function findMentions(text: string, p: Project): [number, number][] {
  if (!text.includes("@")) return [];
  const names: string[] = ["playhead", "selected", "in-out"];
  for (const a of p.assets) {
    names.push(a.name);
    if (bare(a.name) && bare(a.name) !== a.name) names.push(bare(a.name));
  }
  const markers = markerLabels(p).map((m) => m.name);
  const clips = clipLabels(p).map((c) => c.name);
  const byLen = (v: string[]) => [...v].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  let i = 0;
  while ((i = text.indexOf("@", i)) >= 0) {
    const at = i;
    i += 1;
    if (isWord(text[at - 1])) continue; // not "me@example.com"
    let from = i;
    let pool = byLen([...names, ...markers]);
    if (lower.startsWith("marker:", i)) { from += 7; pool = byLen(markers); }
    else if (lower.startsWith("media:", i)) { from += 6; pool = byLen(names.slice(3)); }
    else if (lower.startsWith("clip:", i)) { from += 5; pool = byLen(clips); }
    for (const n of pool) {
      if (!lower.startsWith(n.toLowerCase(), from)) continue;
      const end = from + n.length;
      if (isWord(text[end])) continue;
      out.push([at, end]);
      i = end;
      break;
    }
  }
  return out;
}

/** Clock times ("0:05", "00:00:05:12") always; "5s" only in a span ("between 5s and 8s"). */
export function recognisedTimes(text: string): [number, number][] {
  const found: { s: number; e: number; unit: boolean }[] = [];
  const patterns: [RegExp, boolean][] = [
    [/(?<![\d:.])\d{1,2}:\d{2}:\d{2}[;:]\d{2}(?![\d:])/g, false],
    [/(?<![\d:.])\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?![\d:])/g, false],
    [/(?<![\d:.])\d{1,3}:\d{2}(?:\.\d+)?(?![\d:])/g, false],
    [/(?<![\d:.])\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\b/gi, true],
  ];
  for (const [re, unit] of patterns) {
    for (const m of text.matchAll(re)) {
      const s = m.index ?? 0, e = s + m[0].length;
      if (found.some((f) => f.s < e && s < f.e)) continue;
      found.push({ s, e, unit });
    }
  }
  found.sort((a, b) => a.s - b.s);
  const out: [number, number][] = found.filter((f) => !f.unit).map((f) => [f.s, f.e]);
  for (let k = 0; k + 1 < found.length; k++) {
    const a = found[k], b = found[k + 1];
    if (!(a.unit || b.unit) || b.s < a.e) continue;
    const gap = text.slice(a.e, b.s).trim().toLowerCase();
    const before = text.slice(Math.max(0, a.s - 12), a.s).toLowerCase();
    if (["and", "to", "-", "–", "—", "through", "until", "till"].includes(gap) && (before.endsWith("between ") || before.endsWith("from "))) {
      out.push([a.s, a.e], [b.s, b.e]);
    }
  }
  return out;
}

/** One row of the @ list. */
export interface MentionOption {
  /** What goes after "@" when picked. */
  insert: string;
  /** Shown as "@" + label. */
  label: string;
  detail?: string;
  /** Picking it opens a sub-list (media:, clip:, marker:) instead of finishing. */
  opens?: boolean;
  disabled?: boolean;
  tint?: string;
  icon?: string;
}

const kindWords: Record<string, MediaAsset["kind"][]> = {
  video: ["video"], videos: ["video"], audio: ["audio"], sound: ["audio"], music: ["audio"],
  photo: ["image"], photos: ["image"], image: ["image"], images: ["image"],
};

const duration = (a: MediaAsset) => (a.kind === "image" ? "Photo" : clock(a.duration));

/** The @ list for what's typed after "@" (Editroom's `MentionOption.list`). */
export function mentionOptions(query: string, p: Project, selected: number, range: [number, number] | null, playhead: number): MentionOption[] {
  const q = query.toLowerCase();
  const files = (filter: string, prefix: string) => {
    const kinds = kindWords[filter.trim()];
    const list = p.assets.filter((a) => (kinds ? kinds.includes(a.kind) : true));
    const match = kinds ? list : rank(list.map((a) => [a.name, a] as const), filter);
    return match.slice(0, 40).map((a) => ({ insert: `${prefix}${a.name}`, label: `${prefix}${a.name}`, detail: duration(a), icon: a.kind }));
  };
  if (q.startsWith("media:")) return files(q.slice(6), "media:");
  if (q.startsWith("clip:")) {
    const f = q.slice(5).trim();
    const labels = clipLabels(p);
    const kindFilter = ["text", "title", "titles"].includes(f) ? ["text"] : f === "solid" ? ["solid"] : ["video", "videos"].includes(f) ? ["video"]
      : ["audio", "sound", "music"].includes(f) ? ["audio"] : ["photo", "photos", "image"].includes(f) ? ["image"] : null;
    const list = kindFilter ? labels.filter((l) => kindFilter.includes(l.kind)) : rank(labels.map((l) => [l.name, l] as const), f);
    return list.slice(0, 40).map((l) => ({ insert: `clip:${l.name}`, label: `clip:${l.name}`, detail: `${l.track} ${clock(l.start)}`, icon: l.kind }));
  }
  const markers = markerLabels(p);
  if (q.startsWith("marker:")) {
    return rank(markers.map((m) => [m.name, m] as const), q.slice(7)).map((m) => ({ insert: `marker:${m.name}`, label: `marker:${m.name}`, detail: clock(m.time), tint: m.tint }));
  }
  const specials: MentionOption[] = [
    { insert: "selected", label: "selected", detail: selected ? `${selected} clip${selected === 1 ? "" : "s"}` : "Select clips first", disabled: !selected, icon: "selected" },
    { insert: "playhead", label: "playhead", detail: clock(playhead), icon: "clock" },
    ...(range ? [{ insert: "in-out", label: "in-out", detail: `${clock(range[0])}–${clock(range[1])}`, icon: "range" }] : []),
    { insert: "media:", label: "media:", detail: "A file in your Media", opens: true, icon: "media" },
    ...(p.clips.length ? [{ insert: "clip:", label: "clip:", detail: "One clip on the timeline", opens: true, icon: "clip" }] : []),
    ...(markers.length ? [{ insert: "marker:", label: "marker:", detail: "A marker", opens: true, icon: "marker" }] : []),
  ];
  const base = specials.filter((o) => o.label.startsWith(q));
  if (!q) return base;
  // Typed letters also list matching markers and files.
  const more = [
    ...rank(markers.map((m) => [m.name, m] as const), q).map((m) => ({ insert: m.name, label: m.name, detail: clock(m.time), tint: m.tint })),
    ...rank(p.assets.map((a) => [a.name, a] as const), q).map((a) => ({ insert: a.name, label: a.name, detail: duration(a), icon: a.kind })),
  ];
  return [...base, ...more].slice(0, 40);
}

/** Prefix matches first, then (unless the query has a space) substring matches. */
function rank<T>(items: readonly (readonly [string, T])[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.map((x) => x[1]);
  const pre = items.filter(([n]) => n.toLowerCase().startsWith(q));
  const sub = q.includes(" ") ? [] : items.filter(([n]) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...pre, ...sub].map((x) => x[1]);
}

/** The open @ query before the caret: "@" not after a letter or digit, at most 60 characters back on the line. */
export function openQuery(text: string, caret: number): { at: number; query: string } | null {
  const line = text.slice(0, caret).split("\n").pop() ?? "";
  const i = line.lastIndexOf("@");
  if (i < 0 || line.length - i > 61) return null;
  if (isWord(line[i - 1])) return null;
  const query = line.slice(i + 1);
  // A finished mention followed by a space closes the list, unless it's a sub-list still being typed.
  if (/\s\s/.test(query) || (query.endsWith(" ") && !/^(media|clip|marker):/i.test(query))) return null;
  return { at: caret - (line.length - i), query };
}

/** Whether the project has an edit (non-audio clips): "What should change?" vs "What should it make?". */
export const hasEdit = (p: Project) => p.clips.some((c) => c.kind !== "audio");

export const pointersOf = (p: Project, selection: Set<Id>, playhead: number) => {
  const selected = p.clips
    .filter((c) => selection.has(c.id))
    .sort((a, b) => a.start - b.start || trackOrder(p, a.trackID) - trackOrder(p, b.trackID))
    .map((c) => c.id);
  let range: [number, number] | null = null;
  if (p.inPoint != null || p.outPoint != null) {
    const a = p.inPoint ?? 0, b = p.outPoint ?? projectDuration(p);
    if (Math.abs(b - a) >= 1 / p.fps) range = [Math.min(a, b), Math.max(a, b)];
  }
  return { playhead, selected, range };
};
