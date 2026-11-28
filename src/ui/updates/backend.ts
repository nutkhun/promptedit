// The updater as the update UI sees it. In the app it's `tauri-plugin-updater` (checks
// https://github.com/nutkhun/promptedit/releases/latest/download/latest.json, verifies the download's
// signature, installs) and `tauri-plugin-process` (relaunch). A development build in a browser can
// stand in a scripted one (mock.ts) to try every step of the UI without a release.

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { call, inTauri } from "../../api";

/** An update the feed offers. */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  /** The release notes (plain text, a change a line). */
  notes: string;
  /** Downloads it and checks its signature; `onProgress` gets bytes so far and the size, if known. */
  download(onProgress: (received: number, total: number | null) => void): Promise<void>;
  /** Installs what `download` fetched. On Windows the installer takes over and the app quits here. */
  install(): Promise<void>;
  /** Lets go of it (and any downloaded bytes) without installing. */
  close(): Promise<void>;
}

export interface UpdaterBackend {
  /** Whether this build checks for updates at all (it carries the update signing key). */
  enabled(): Promise<boolean>;
  currentVersion(): Promise<string>;
  /** The update on offer, or null when this is the newest version. */
  check(): Promise<AvailableUpdate | null>;
  relaunch(): Promise<void>;
}

/** How long a check waits for GitHub before giving up. */
const CHECK_TIMEOUT_MS = 30_000;

const tauriBackend: UpdaterBackend = {
  enabled: () => call<boolean>("updates_enabled").catch(() => false),
  currentVersion: () => getVersion(),
  async check() {
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? "",
      async download(onProgress) {
        let received = 0, total: number | null = null;
        await update.download((e) => {
          if (e.event === "Started") total = e.data.contentLength ?? null;
          else if (e.event === "Progress") received += e.data.chunkLength;
          onProgress(received, total);
        });
      },
      install: () => update.install(),
      close: () => update.close(),
    };
  },
  relaunch: () => relaunch(),
};

/** Without an updater: a browser, or a build that doesn't check. */
const noBackend: UpdaterBackend = {
  enabled: async () => false,
  currentVersion: async () => "Development",
  check: async () => null,
  relaunch: async () => {},
};

/**
 * The updater to use. A development build in a browser uses the scripted one when a test has set
 * `window.__PROMPTEDIT_UPDATER_MOCK__` (see mock.ts); it isn't in release builds at all.
 */
export async function loadBackend(): Promise<UpdaterBackend> {
  if (inTauri) return tauriBackend;
  if (import.meta.env.DEV && "__PROMPTEDIT_UPDATER_MOCK__" in window) return (await import("./mock")).mockBackend();
  return noBackend;
}
