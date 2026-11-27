// App state: the project snapshot from Rust plus everything that is view-only
// (selection, playhead, tools, timeline view). Edits go through `edit()`, never mutate locally.

import { create } from "zustand";
import { api } from "./api";
import type { Edit, Id, Probe, Project, Snapshot } from "./model";
import { projectDuration, snapFrame } from "./timing";

export type Tool = "select" | "cut";
export type Theme = "auto" | "dark" | "grey" | "amber" | "light";

export interface View {
  /** Points (CSS px) per second. */
  pps: number;
  scrollX: number;
  scrollY: number;
  rowHeight: number;
}

const settingsKey = "promptedit.settings";
interface Settings {
  theme: Theme;
  thumbnails: boolean;
  sticky: boolean;
  skimming: boolean;
  audioScrubbing: boolean;
  timeStyle: "timecode" | "simple";
  playFromSkimmer: boolean;
}
const defaultSettings: Settings = {
  theme: "dark", thumbnails: true, sticky: false, skimming: true, audioScrubbing: true,
  timeStyle: "timecode", playFromSkimmer: true,
};
function loadSettings(): Settings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey) ?? "{}") };
  } catch {
    return defaultSettings;
  }
}

export interface State extends Settings {
  project: Project;
  title: string;
  file?: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** ffprobe results by asset id (codec, rotation…), filled on import/open. */
  probes: Record<Id, Probe>;

  selection: Set<Id>;
  mediaSelection: Set<Id>;
  playhead: number;
  playing: boolean;
  loop: boolean;
  /** Hover time on the timeline while skimming, or a library hover-scrub. */
  skim?: { time: number } | { asset: Id; time: number };
  tool: Tool;
  /** Snapping is never saved: on at every launch. */
  snapping: boolean;
  view: View;
  exportOpen: boolean;
  settingsOpen: boolean;
  error?: string;
  /** Copied clips (⌘C) and grade (⌥⌘C). */
  clipboard: Project["clips"];
  copiedGrade?: { grade: Project["clips"][number]["grade"] };

  apply: (s: Snapshot) => void;
  edit: (e: Edit, live?: boolean) => Promise<void>;
  commitLive: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  seek: (t: number) => void;
  select: (ids: Iterable<Id>) => void;
  setView: (v: Partial<View>) => void;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  set: (s: Partial<State>) => void;
}

export const useStore = create<State>((set, get) => ({
  ...loadSettings(),
  project: {
    width: 1920, height: 1080, fps: 30, settingsLocked: false, videoTracks: [], audioTracks: [], clips: [], assets: [],
  },
  title: "Untitled",
  dirty: false,
  canUndo: false,
  canRedo: false,
  probes: {},
  selection: new Set(),
  mediaSelection: new Set(),
  playhead: 0,
  playing: false,
  loop: false,
  tool: "select",
  snapping: true,
  view: { pps: 80, scrollX: 0, scrollY: 0, rowHeight: 62 },
  exportOpen: false,
  settingsOpen: false,
  clipboard: [],

  apply: (s) => {
    const ids = new Set(s.project.clips.map((c) => c.id));
    let selection = new Set([...get().selection].filter((id) => ids.has(id)));
    if (s.outcome?.selection) selection = new Set(s.outcome.selection);
    const playhead = s.outcome?.seek != null ? Math.max(0, s.outcome.seek) : get().playhead;
    set({
      project: s.project, title: s.title, file: s.file, dirty: s.dirty, canUndo: s.canUndo, canRedo: s.canRedo,
      selection, playhead,
    });
  },
  edit: async (e, live = false) => {
    try {
      get().apply(await api.edit(e, live));
    } catch (err) {
      set({ error: String(err) });
    }
  },
  commitLive: async () => get().apply(await api.commitLive()),
  undo: async () => get().apply(await api.undo()),
  redo: async () => get().apply(await api.redo()),
  seek: (t) => {
    const p = get().project;
    set({ playhead: Math.max(0, snapFrame(p, Math.min(t, Math.max(projectDuration(p), t)))) });
  },
  select: (ids) => set({ selection: new Set(ids), mediaSelection: new Set() }),
  setView: (v) => set({ view: { ...get().view, ...v } }),
  setSetting: (k, v) => {
    set({ [k]: v } as Partial<State>);
    const s = get();
    const out: Partial<Settings> = {};
    for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) (out as Record<string, unknown>)[key] = s[key];
    try { localStorage.setItem(settingsKey, JSON.stringify(out)); } catch { /* private mode */ }
  },
  set: (s) => set(s),
}));

/** Non-React access, for engine code and event handlers. */
export const store = () => useStore.getState();
