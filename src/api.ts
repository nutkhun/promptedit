// Calls into the Rust backend (src-tauri/src/lib.rs). One function per command.

import { invoke as tauriInvoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Edit, Id, ImportResult, MediaAsset, Probe, Snapshot } from "./model";

/** Running inside the Tauri window (otherwise: a browser talking to the dev server). */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The browser dev server (src-tauri/src/bin/devserver.rs). */
export const DEV_SERVER = (import.meta.env.VITE_DEV_SERVER as string | undefined) ?? "http://127.0.0.1:1430";

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) return tauriInvoke<T>(cmd, args);
  const r = await fetch(`${DEV_SERVER}/invoke/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await r.json();
  if (!r.ok) throw body;
  return body as T;
}

/** For commands added by other modules (engine, MCP). */
export const call = invoke;

export const api = {
  getProject: () => invoke<Snapshot>("get_project"),
  newProject: () => invoke<Snapshot>("new_project"),
  openProject: (path: string) => invoke<Snapshot>("open_project", { path }),
  saveProject: (path?: string) => invoke<Snapshot>("save_project", { path: path ?? null }),
  edit: (edit: Edit, live = false) => invoke<Snapshot>("edit", { edit, live }),
  commitLive: () => invoke<Snapshot>("commit_live"),
  discardLive: () => invoke<Snapshot>("discard_live"),
  undo: () => invoke<Snapshot>("undo"),
  redo: () => invoke<Snapshot>("redo"),
  importMedia: (paths: string[]) => invoke<ImportResult>("import_media", { paths }),
  probeMedia: (path: string) => invoke<Probe>("probe_media", { path }),
  transcodeMedia: (asset: Id) => invoke<Snapshot>("transcode_media", { asset }),
};

/** A URL the webview can fetch (with Range requests) for a file on disk. */
export const fileURL = (path: string) =>
  inTauri ? convertFileSrc(path) : `${DEV_SERVER}/file?path=${encodeURIComponent(path)}`;

/** The file the engine should read for an asset: its playable copy, if it has one. */
export const mediaPath = (a: MediaAsset) => a.playablePath ?? a.path;

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
