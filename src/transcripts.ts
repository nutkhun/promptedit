// Speech to text in the backend (src-tauri/src/transcribe; docs/spec/05-captions-contract.md):
// typed wrappers for its commands, and its two events. Events only exist in the Tauri window; in
// a browser (dev server) the listeners do nothing and the UI polls the state commands instead.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call, inTauri } from "./api";
import type { Id } from "./model";

/** What's said in a file, in file seconds; punctuation stays on the word before it. */
export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}
export interface Transcript {
  words: TranscriptWord[];
  /** Whisper's language code ("en"), or "" when nothing was said. */
  language: string;
}

export type TranscriptState =
  | { state: "none" }
  | { state: "queued" }
  | { state: "needsModel" }
  | { state: "working"; progress: number } // 0…1
  | { state: "ready"; words: number }
  | { state: "failed"; message: string };

export type ModelState =
  | { state: "missing" }
  | { state: "downloading"; progress: number } // 0…1
  | { state: "ready" }
  | { state: "failed"; message: string };

export type SpeechModelId = "fast" | "balanced" | "best";

export interface SpeechModelInfo {
  id: SpeechModelId;
  label: string;
  sizeMB: number;
  downloaded: boolean;
}

export interface TranscriptionSettings {
  model: SpeechModelId;
  /** "auto" (detect) or a language code whisper knows ("en", "de", …). */
  language: string;
  models: SpeechModelInfo[];
}

/** The cached transcript, or null; never starts work. */
export const transcriptGet = (asset: Id) => call<Transcript | null>("transcript_get", { asset });

/** Queues the file to be heard (one at a time; nothing happens if it's heard or being heard; a
 *  failed one is tried again). Without the speech model it waits as `needsModel`, and starts by
 *  itself once the model is downloaded. */
export const transcribe = (asset: Id) => call<TranscriptState>("transcribe", { asset });

export const transcriptState = (asset: Id) => call<TranscriptState>("transcript_state", { asset });

export const transcriptionSettingsGet = () => call<TranscriptionSettings>("transcription_settings_get", {});

export const transcriptionSettingsSet = (change: { model?: SpeechModelId; language?: string }) =>
  call<TranscriptionSettings>("transcription_settings_set", change);

/** Starts downloading a model (the chosen one by default); follow it with the state or event. */
export const transcriptionModelDownload = (model?: SpeechModelId) =>
  call<ModelState>("transcription_model_download", model ? { model } : {});

/** The chosen model's state. */
export const transcriptionModelState = () => call<ModelState>("transcription_model_state", {});

export const TRANSCRIPT_STATE_EVENT = "transcript-state";
export const MODEL_STATE_EVENT = "transcription-model";

export type TranscriptStateEvent = TranscriptState & { asset: Id };
/** `model` says which model it's about: usually the chosen one, unless another is downloading. */
export type ModelStateEvent = ModelState & { model: SpeechModelId };

const noop: UnlistenFn = () => {};

/** A file's transcription moved on (queued, progress, ready, failed). Tauri only. */
export async function onTranscriptState(handler: (e: TranscriptStateEvent) => void): Promise<UnlistenFn> {
  if (!inTauri) return noop;
  return listen<TranscriptStateEvent>(TRANSCRIPT_STATE_EVENT, (e) => handler(e.payload));
}

/** A speech model's download moved on, or the chosen model changed. Tauri only. */
export async function onModelState(handler: (e: ModelStateEvent) => void): Promise<UnlistenFn> {
  if (!inTauri) return noop;
  return listen<ModelStateEvent>(MODEL_STATE_EVENT, (e) => handler(e.payload));
}
