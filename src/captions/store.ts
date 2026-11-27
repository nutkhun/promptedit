// What's said in the project's files, as the captions see it: each file's transcript (fetched from
// the backend's cache), where its transcription has got to, and the speech model's download. Follows
// the backend's `transcript-state` / `transcription-model` events in the app, and polls the state
// commands once a second in the browser dev build (docs/spec/05-captions-contract.md).

import { create } from "zustand";
import { inTauri } from "../api";
import type { Id } from "../model";
import {
  onModelState, onTranscriptState, transcribe, transcriptGet, transcriptionModelState, transcriptState,
  type ModelState, type Transcript, type TranscriptState,
} from "../transcripts";

interface TranscriptsState {
  /** By asset: the transcript, null when the backend has none (yet), absent while not asked. */
  transcripts: Record<Id, Transcript | null>;
  /** By asset: transcription progress, for files asked about. */
  states: Record<Id, TranscriptState>;
  model?: ModelState;
  /** The backend has no transcription commands (an older backend): captions show what's seeded only. */
  unavailable: boolean;
  /** Bumped whenever a transcript arrives, so layouts are redone. */
  version: number;
}

export const useTranscripts = create<TranscriptsState>(() => ({ transcripts: {}, states: {}, unavailable: false, version: 0 }));
const get = () => useTranscripts.getState();

/** Files whose transcript was seeded by a test: the backend never overwrites them. */
const seeded = new Set<Id>();
const fetching = new Map<Id, Promise<void>>();

export const transcriptOf = (asset: Id): Transcript | undefined => get().transcripts[asset] ?? undefined;

function setTranscript(asset: Id, t: Transcript | null) {
  useTranscripts.setState((s) => ({ transcripts: { ...s.transcripts, [asset]: t }, version: s.version + 1 }));
}

function setState(asset: Id, st: TranscriptState) {
  const prev = get().states[asset];
  if (prev && JSON.stringify(prev) === JSON.stringify(st)) return;
  useTranscripts.setState((s) => ({ states: { ...s.states, [asset]: st } }));
  // Heard: the words are in the backend's cache now.
  if (st.state === "ready" && prev?.state !== "ready") void fetchTranscript(asset, true);
  schedulePoll();
}

/** The dev server's and Tauri's answers to a command they don't have. */
const UNKNOWN_COMMAND = /unknown command|command \S+ not found/i;

/**
 * A call failed. A backend without the transcription commands (an older build) turns captions'
 * backend use off for the session; any other failure is about that file (missing, unreadable), so
 * it reads as failed and nothing else changes.
 */
function backendFailed(err: unknown, asset?: Id) {
  if (UNKNOWN_COMMAND.test(String(err))) {
    if (!get().unavailable) {
      console.warn("Transcription isn't available from the backend:", err);
      useTranscripts.setState({ unavailable: true });
    }
    return;
  }
  console.warn("Transcription:", err);
  if (asset !== undefined) {
    useTranscripts.setState((s) => ({
      states: { ...s.states, [asset]: { state: "failed", message: String(err) } },
      transcripts: asset in s.transcripts ? s.transcripts : { ...s.transcripts, [asset]: null },
    }));
  }
}

/** Reads the file's cached transcript (cheap; never starts work). `again` re-reads one already read. */
export function fetchTranscript(asset: Id, again = false): Promise<void> {
  if (seeded.has(asset) || get().unavailable) return Promise.resolve();
  if (!again && asset in get().transcripts) return Promise.resolve();
  const running = fetching.get(asset);
  if (running) return running;
  const job = transcriptGet(asset)
    .then((t) => { if (!seeded.has(asset)) setTranscript(asset, t ?? null); })
    .catch((err) => backendFailed(err, asset))
    .finally(() => fetching.delete(asset));
  fetching.set(asset, job);
  return job;
}

/** Asks for the file to be transcribed (queued in the backend; a no-op when it's ready or under way). */
export async function requestTranscription(asset: Id): Promise<TranscriptState | undefined> {
  if (seeded.has(asset) || get().unavailable) return undefined;
  try {
    const st = await transcribe(asset);
    setState(asset, st);
    return st;
  } catch (err) {
    backendFailed(err, asset);
    return undefined;
  }
}

/** The speech model's state, read now. */
export async function refreshModel(): Promise<ModelState | undefined> {
  if (get().unavailable) return undefined;
  try {
    const m = await transcriptionModelState();
    setModel(m);
    return m;
  } catch (err) {
    backendFailed(err);
    return undefined;
  }
}

const modelListeners = new Set<(m: ModelState) => void>();
/** Called on every change of the model's state (download progress, ready, failed). */
export function onModelChange(f: (m: ModelState) => void): () => void {
  modelListeners.add(f);
  return () => { modelListeners.delete(f); };
}

export function setModel(m: ModelState) {
  const prev = get().model;
  if (prev && JSON.stringify(prev) === JSON.stringify(m)) return;
  useTranscripts.setState({ model: m });
  for (const f of modelListeners) f(m);
  schedulePoll();
}

/** Still being heard (or waiting to be): what the timeline shows as "Listening for what's said…". */
export function pending(asset: Id): boolean {
  const s = get();
  if (seeded.has(asset)) return false;
  const st = s.states[asset];
  if (st?.state === "queued" || st?.state === "working") return true;
  if (st?.state === "needsModel") return s.model?.state === "downloading";
  // Not read yet.
  return !s.unavailable && !(asset in s.transcripts);
}

// ---- Following the backend ----

let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** In the browser there are no events: while anything is under way, ask again each second. */
function schedulePoll() {
  if (inTauri || pollTimer !== undefined || get().unavailable) return;
  const s = get();
  const busy = Object.entries(s.states).filter(([, st]) => st.state === "queued" || st.state === "working");
  const downloading = s.model?.state === "downloading";
  if (!busy.length && !downloading) return;
  pollTimer = setTimeout(async () => {
    pollTimer = undefined;
    const now = get();
    const ids = Object.entries(now.states).filter(([, st]) => st.state === "queued" || st.state === "working").map(([id]) => id);
    await Promise.all(ids.map(async (id) => {
      try { setState(id, await transcriptState(id)); } catch (err) { backendFailed(err, id); }
    }));
    if (now.model?.state === "downloading") await refreshModel();
    schedulePoll();
  }, 1000);
}

let following = false;
/** Starts following the backend's events (Tauri). Once. */
export function followBackend() {
  if (following || !inTauri) return;
  following = true;
  void onTranscriptState(({ asset, ...st }) => setState(asset, st as TranscriptState));
  // The event also says which model it's about; the state is what the title bar and prompts follow.
  void onModelState(({ model: _which, ...m }) => setModel(m as ModelState));
}

// ---- Tests ----

/**
 * Puts a transcript in place without the backend (dev builds only, for UI tests while the speech
 * backend isn't there): `window.__peSeedTranscript(assetId, [{ start, end, text }, …])`.
 */
export function seedTranscript(asset: Id, words: Transcript["words"], language = "en") {
  seeded.add(asset);
  const sorted = words.slice().sort((a, b) => a.start - b.start);
  useTranscripts.setState((s) => ({
    transcripts: { ...s.transcripts, [asset]: { words: sorted, language } },
    states: { ...s.states, [asset]: { state: "ready", words: sorted.length } },
    version: s.version + 1,
  }));
}
