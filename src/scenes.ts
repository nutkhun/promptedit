// What's in the picture (src-tauri/src/scenes; Editroom's SceneTags, docs/spec/02-engine.md §17):
// typed wrappers for the backend's commands and events, a small store of every file's tags, the
// picture model's download and the files still being looked at, and search-word matching, the
// same as the backend's `scenes::words` (the alias table comes from the backend, so it's in one place).

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { call, inTauri } from "./api";
import type { Id } from "./model";
import type { ModelState } from "./transcripts";

export type { ModelState };

export interface SceneTag {
  name: string;
  /** 0…1, at the frame where it's surest. */
  confidence: number;
  /** Seconds in the file where it shows. */
  times: number[];
}
export interface SceneTags { tags: SceneTag[] }

export type SceneState =
  | { state: "none" }
  | { state: "queued" }
  | { state: "needsModel" }
  | { state: "working"; progress: number }
  | { state: "ready"; tags: number }
  | { state: "failed"; message: string };

export interface SceneSettings {
  /** Look at imported files in the background (once the model is here). */
  enabled: boolean;
  /** "Not now" was chosen in Media search's prompt: don't offer it there again. */
  declined: boolean;
  model: { label: string; sizeMB: number; state: ModelState };
}

// ---- Commands ----

export const sceneTagsGet = (asset: Id) => call<SceneTags | null>("scene_tags_get", { asset });
/** Every library item's tags that are on disk, by asset id. */
export const sceneTagsAll = () => call<Record<Id, SceneTags>>("scene_tags_all", {});
export const sceneTagsQueue = (asset: Id) => call<SceneState>("scene_tags_queue", { asset });
export const sceneTagsState = (asset: Id) => call<SceneState>("scene_tags_state", { asset });
export const sceneSettingsGet = () => call<SceneSettings>("scene_settings_get", {});
export const sceneSettingsSet = (change: { enabled?: boolean; declined?: boolean }) => call<SceneSettings>("scene_settings_set", change);
/** Starts the download; once it's in, everything in the library is looked at. */
export const sceneModelDownload = () => call<ModelState>("scene_model_download", {});
export const sceneModelState = () => call<ModelState>("scene_model_state", {});
export const sceneAliases = () => call<Record<string, string[]>>("scene_aliases", {});

export const SCENE_STATE_EVENT = "scene-tags-state";
export const SCENE_MODEL_EVENT = "scene-model";

// ---- Matching (Editroom `SceneTags.shows`, `matching`) ----

let aliases: Record<string, string[]> = {};

/** "pools" → "pool", but not "glass" or short words ("bus"). */
export const singular = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** The same word in another form ("laughing" and "laughter"), for longer words. */
export function sameStem(a: string, b: string): boolean {
  if (a.length < 5 || b.length < 5) return false;
  const stem = (w: string) => {
    for (const end of ["ing", "ter", "ers", "er", "ed", "es", "s"]) {
      if (w.length > end.length + 3 && w.endsWith(end)) { w = w.slice(0, -end.length); break; }
    }
    return w.endsWith("e") && w.length > 4 ? w.slice(0, -1) : w;
  };
  return stem(a) === stem(b);
}

const wordsOf = (tag: string) => [...tag.split(" "), ...(aliases[tag] ?? [])];

function tagMatches(tag: string, w: string, typing: boolean): boolean {
  return wordsOf(tag).some((p) => p === w || singular(p) === w || (typing && p.startsWith(w)) || sameStem(p, w));
}

/** The tags that show this word: its own words, everyday words for it, plural or not, the same stem,
 *  and while `typing`, the start of one ("po" for "pool"). */
export function matchingTags(t: SceneTags, word: string, typing = false): SceneTag[] {
  const w = singular(word.toLowerCase());
  if (w.length < 2) return [];
  return t.tags.filter((tag) => tagMatches(tag.name, w, typing));
}

export const shows = (t: SceneTags, word: string, typing = false) => matchingTags(t, word, typing).length > 0;

/** For tests: the alias table without the backend. */
export function setAliases(a: Record<string, string[]>) { aliases = a; }

// ---- Store ----

interface ScenesState {
  /** By asset: its tags, once read (absent: none on disk). */
  tags: Record<Id, SceneTags>;
  /** By asset: files being looked at, or waiting their turn. */
  states: Record<Id, SceneState>;
  settings?: SceneSettings;
  model?: ModelState;
  /** The backend has no picture search (an older build): search matches names only. */
  unavailable: boolean;
  /** Bumped whenever tags arrive, so search results are redone. */
  version: number;
}

export const useScenes = create<ScenesState>(() => ({ tags: {}, states: {}, unavailable: false, version: 0 }));
const get = () => useScenes.getState();

export const tagsOf = (asset: Id): SceneTags | undefined => get().tags[asset];

function failed(err: unknown) {
  if (/unknown command|command \S+ not found/i.test(String(err))) useScenes.setState({ unavailable: true });
  else console.warn("Picture search:", err);
}

let loading: Promise<void> | undefined;
let aliasesLoaded = false;

/** Reads every library item's tags from the backend's cache (cheap; never starts work). */
export function refreshTags(): Promise<void> {
  if (get().unavailable) return Promise.resolve();
  loading ??= (async () => {
    try {
      if (!aliasesLoaded) { aliases = await sceneAliases(); aliasesLoaded = true; }
      const all = await sceneTagsAll();
      useScenes.setState((s) => ({ tags: all, version: s.version + 1 }));
    } catch (err) {
      failed(err);
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

export async function refreshSettings(): Promise<SceneSettings | undefined> {
  if (get().unavailable) return undefined;
  try {
    const settings = await sceneSettingsGet();
    useScenes.setState({ settings });
    setModel(settings.model.state);
    return settings;
  } catch (err) {
    failed(err);
    return undefined;
  }
}

export async function changeSettings(change: { enabled?: boolean; declined?: boolean }) {
  try {
    const settings = await sceneSettingsSet(change);
    useScenes.setState({ settings });
  } catch (err) {
    failed(err);
  }
}

/** The person agreed: the model downloads, then every library item is looked at. */
export async function downloadModel() {
  try {
    setModel(await sceneModelDownload());
  } catch (err) {
    setModel({ state: "failed", message: String(err) });
  }
}

function setModel(m: ModelState) {
  const prev = get().model;
  if (prev && JSON.stringify(prev) === JSON.stringify(m)) return;
  useScenes.setState((s) => ({ model: m, settings: s.settings && { ...s.settings, model: { ...s.settings.model, state: m } } }));
  // Downloaded: the backend queued the whole library. The browser asks where each file is.
  if (m.state === "ready" && prev?.state === "downloading" && !inTauri) {
    for (const id of pollIds) void sceneTagsState(id).then((st) => setState(id, st)).catch(failed);
  }
  schedulePoll();
}

function setState(asset: Id, st: SceneState) {
  const prev = get().states[asset];
  if (prev && JSON.stringify(prev) === JSON.stringify(st)) return;
  useScenes.setState((s) => ({ states: { ...s.states, [asset]: st } }));
  // Done: its tags are on disk now.
  if (st.state === "ready" && prev?.state !== "ready") void refreshTags();
  schedulePoll();
}

/** How many files are still being looked at (or waiting their turn), for "Looking at your clips…". */
export const lookingCount = (states: Record<Id, SceneState>) =>
  Object.values(states).filter((s) => s.state === "queued" || s.state === "working").length;

// ---- Following the backend ----

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollIds: Id[] = [];

/** In the browser there are no events: while a download or tagging runs, ask again each second. */
function schedulePoll() {
  if (inTauri || pollTimer !== undefined || get().unavailable) return;
  const s = get();
  const busy = Object.entries(s.states).filter(([, st]) => st.state === "queued" || st.state === "working" || st.state === "needsModel");
  const downloading = s.model?.state === "downloading";
  if (!busy.length && !downloading) return;
  pollTimer = setTimeout(async () => {
    pollTimer = undefined;
    const ids = Object.entries(get().states).filter(([, st]) => st.state !== "ready" && st.state !== "failed" && st.state !== "none").map(([id]) => id);
    await Promise.all(ids.map(async (id) => {
      try { setState(id, await sceneTagsState(id)); } catch (err) { failed(err); }
    }));
    if (get().model?.state === "downloading") {
      try { setModel(await sceneModelState()); } catch (err) { failed(err); }
    }
    schedulePoll();
  }, 1000);
}

/**
 * Starts following the backend. In Tauri: its events. In the browser: the states of `assets`
 * (the library), asked for once and then polled while any is under way.
 */
export function followScenes(assets: Id[]) {
  if (inTauri) {
    if (following) return;
    following = true;
    void listen<SceneState & { asset: Id }>(SCENE_STATE_EVENT, (e) => {
      const { asset, ...st } = e.payload;
      setState(asset, st as SceneState);
    });
    void listen<ModelState>(SCENE_MODEL_EVENT, (e) => setModel(e.payload));
    return;
  }
  const fresh = assets.filter((id) => !pollIds.includes(id));
  pollIds = assets;
  for (const id of fresh) void sceneTagsState(id).then((st) => setState(id, st)).catch(failed);
}
let following = false;
