// A scripted updater for trying the update UI in a browser development build (and for the
// Playwright screenshots of each step). Set before the page loads, e.g. with `page.addInitScript`:
//
//   window.__PROMPTEDIT_UPDATER_MOCK__ = {
//     update: { version: "0.2.0", notes: "Faster export\nCaptions in Thai" },  // null: up to date
//     size: 84_000_000, downloadMs: 4000, stallAt: 0.4,  // hold the download bar at 40%
//     fail: "download",                                  // or "check" / "install"
//   };
//
// `window.__PROMPTEDIT_UPDATER_MOCK__.log` records what the UI asked for (check, download, install,
// relaunch) so a test can assert on it.

import type { AvailableUpdate, UpdaterBackend } from "./backend";

export interface UpdaterMock {
  enabled?: boolean;
  currentVersion?: string;
  update?: { version: string; notes?: string } | null;
  size?: number;
  checkMs?: number;
  downloadMs?: number;
  /** Stop the download's progress at this fraction (0–1) and never finish. */
  stallAt?: number;
  fail?: "check" | "download" | "install";
  log?: string[];
}

declare global {
  interface Window { __PROMPTEDIT_UPDATER_MOCK__?: UpdaterMock }
}

const config = (): UpdaterMock => window.__PROMPTEDIT_UPDATER_MOCK__ ?? {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (what: string) => { const c = config(); (c.log ??= []).push(what); };

export function mockBackend(): UpdaterBackend {
  return {
    enabled: async () => config().enabled ?? true,
    currentVersion: async () => config().currentVersion ?? "0.1.0",
    async check() {
      note("check");
      const c = config();
      await wait(c.checkMs ?? 600);
      if (c.fail === "check") throw new Error("error sending request for url (https://github.com/nutkhun/promptedit/releases/latest/download/latest.json)");
      if (!c.update) return null;
      const update: AvailableUpdate = {
        version: c.update.version,
        currentVersion: c.currentVersion ?? "0.1.0",
        notes: c.update.notes ?? "",
        async download(onProgress) {
          note("download");
          const total = c.size ?? 84_000_000, steps = 40, ms = c.downloadMs ?? 2000;
          for (let i = 1; i <= steps; i++) {
            await wait(ms / steps);
            const fraction = i / steps;
            if (c.stallAt !== undefined && fraction > c.stallAt) return new Promise<void>(() => {});
            if (c.fail === "download" && fraction > 0.5) throw new Error("signature verification failed");
            onProgress(Math.round(total * fraction), total);
          }
        },
        async install() {
          note("install");
          await wait(400);
          if (c.fail === "install") throw new Error("failed to move the new app into place: permission denied");
        },
        close: async () => { note("close"); },
      };
      return update;
    },
    relaunch: async () => { note("relaunch"); },
  };
}
