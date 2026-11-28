// The update flow (docs/spec/04-ui.md §6.1), as Editroom's Sparkle setup behaves:
// - automatic checks once a day, the first a second after launch, silent unless an update is found
//   (and not one the person skipped);
// - Check for Updates… (menu, Settings) shows every step: checking, "You're up to date!", errors;
// - an update found is offered in the update alert (what's new listed under it): Install Update ·
//   Remind Me Later · Skip This Version, with "Automatically download and install updates in the
//   future", which makes later automatic checks download the update first and offer it ready;
// - Install Update downloads it (progress, Cancel), then Ready to Install › Install and Relaunch.
//
// The plugin doesn't keep any of these settings, so they're stored here (localStorage, the same keys
// Settings › Updates has always used).

import { create } from "zustand";
import { confirmDiscard } from "../shell/files";
import { loadBackend, type AvailableUpdate, type UpdaterBackend } from "./backend";
import { checkDue, isSkipped } from "./notes";

export type UpdateStep =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  /** The update alert. `downloaded`: fetched in the background already, so it installs at once. */
  | { kind: "found"; update: AvailableUpdate; downloaded: boolean }
  | { kind: "downloading"; update: AvailableUpdate; received: number; total: number | null }
  | { kind: "ready"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate }
  | { kind: "error"; text: string; detail: string };

export interface UpdatesState {
  /** The updater has said whether it runs (until then, Check for Updates… says this build doesn't). */
  loaded: boolean;
  enabled: boolean;
  currentVersion: string;
  step: UpdateStep;
  /** Whether the step is on screen (a background check or download isn't). */
  shown: boolean;
  /** A check is running (Settings' Check for Updates… is disabled meanwhile). */
  checking: boolean;
  lastCheck: number | null;
  automatic: boolean;
  autoDownload: boolean;
}

const KEY = {
  lastCheck: "updates.lastCheck",
  automatic: "updates.automatic",
  skipped: "updates.skippedVersion",
  autoDownload: "updates.autoDownload",
} as const;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ }
}

const storedLastCheck = () => { const v = Number(read(KEY.lastCheck)); return Number.isFinite(v) && v > 0 ? v : null; };

export const useUpdates = create<UpdatesState>(() => ({
  loaded: false,
  enabled: false,
  currentVersion: "Development",
  step: { kind: "idle" },
  shown: false,
  checking: false,
  lastCheck: storedLastCheck(),
  automatic: read(KEY.automatic) !== "false",
  autoDownload: read(KEY.autoDownload) === "true",
}));

const set = (s: Partial<UpdatesState>) => useUpdates.setState(s);
const get = () => useUpdates.getState();

let backend: UpdaterBackend | null = null;

/** Lets go of an update; it may have been let go of already. */
const release = (update: AvailableUpdate | null) => { update?.close().catch(() => {}); };
/** Bumped whenever the person walks away from a step (Cancel), so late results are dropped. */
let generation = 0;

/** Loads the updater and starts the automatic checks. Returns a function that stops them. */
export function startUpdates(): () => void {
  let stopped = false;
  let timer: number | undefined;
  let interval: number | undefined;
  void (async () => {
    const b = await loadBackend();
    const [enabled, currentVersion] = await Promise.all([b.enabled(), b.currentVersion().catch(() => "Development")]);
    if (stopped) return;
    backend = b;
    set({ loaded: true, enabled, currentVersion });
    if (!enabled) return;
    // A second after launch, so nothing holds up the editor window; then hourly, to see if a day has passed.
    timer = window.setTimeout(() => void automaticCheck(), 1000);
    interval = window.setInterval(() => void automaticCheck(), 60 * 60 * 1000);
  })();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(interval);
  };
}

export function setAutomatic(on: boolean) {
  write(KEY.automatic, String(on));
  set({ automatic: on });
}

export function setAutoDownload(on: boolean) {
  write(KEY.autoDownload, String(on));
  set({ autoDownload: on });
}

/** A check finished. `mine`: whether it's still the one that counts (a newer one may be running). */
function checked(mine: boolean) {
  const now = Date.now();
  write(KEY.lastCheck, String(now));
  set(mine ? { lastCheck: now, checking: false } : { lastCheck: now });
}

/** Errors as Sparkle words them, with the updater's own message under it. */
function failed(text: string, e: unknown) {
  set({ step: { kind: "error", text, detail: errorText(e) }, shown: true });
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e) ?? "");

/** The once-a-day check. Quiet: only an update that hasn't been skipped is shown. */
async function automaticCheck() {
  const s = get();
  if (!backend || !s.enabled || !s.automatic || s.checking || s.step.kind !== "idle") return;
  if (!checkDue(s.lastCheck, Date.now())) return;
  const mine = ++generation;
  set({ checking: true });
  let update: AvailableUpdate | null = null;
  try {
    update = await backend.check();
  } catch (e) {
    console.warn("Update check failed:", e);
  }
  checked(mine === generation);
  if (mine !== generation || get().step.kind !== "idle") { release(update); return; }
  if (!update || isSkipped(update.version, read(KEY.skipped))) { release(update); return; }
  if (get().autoDownload) {
    // Fetched first, out of sight; then offered ready to install.
    set({ step: { kind: "downloading", update, received: 0, total: null }, shown: false });
    void download(update, mine, true);
  } else {
    set({ step: { kind: "found", update, downloaded: false }, shown: true });
  }
}

/** Check for Updates…: shows each step. If an update is already on its way, shows where it's got to. */
export async function checkNow() {
  const s = get();
  if (!backend || !s.enabled) return;
  if (s.step.kind !== "idle") { set({ shown: true }); return; }
  const mine = ++generation;
  set({ step: { kind: "checking" }, shown: true, checking: true });
  try {
    const update = await backend.check();
    checked(mine === generation);
    if (mine !== generation) { release(update); return; }
    // A check you start yourself offers a skipped version too, as Sparkle does.
    set({ step: update ? { kind: "found", update, downloaded: false } : { kind: "upToDate" } });
  } catch (e) {
    checked(mine === generation);
    if (mine === generation) failed("An error occurred in retrieving update information. Please try again later.", e);
  }
}

async function download(update: AvailableUpdate, mine: number, background: boolean) {
  try {
    await update.download((received, total) => {
      if (mine === generation) set({ step: { kind: "downloading", update, received, total } });
    });
  } catch (e) {
    if (mine !== generation) return;
    release(update);
    if (background) { console.warn("Update download failed:", e); set({ step: { kind: "idle" }, shown: false }); return; }
    failed("An error occurred while downloading the update. Please try again later.", e);
    return;
  }
  if (mine !== generation) { release(update); return; }
  set(background
    ? { step: { kind: "found", update, downloaded: true }, shown: true }
    : { step: { kind: "ready", update } });
}

/** The update alert's choices. */
export async function chooseInstall() {
  const step = get().step;
  if (step.kind !== "found") return;
  if (step.downloaded) return installAndRelaunch();
  const mine = ++generation;
  set({ step: { kind: "downloading", update: step.update, received: 0, total: null }, shown: true });
  await download(step.update, mine, false);
}

export function chooseRemindLater() {
  const step = get().step;
  if (step.kind === "found") release(step.update);
  dismiss();
}

export function chooseSkip() {
  const step = get().step;
  if (step.kind !== "found") return;
  write(KEY.skipped, step.update.version);
  release(step.update);
  dismiss();
}

/** Installs the downloaded update and starts the new version. Unsaved changes are asked about first. */
export async function installAndRelaunch() {
  const step = get().step;
  if (step.kind !== "ready" && !(step.kind === "found" && step.downloaded)) return;
  const update = step.update;
  // The app quits to install (on Windows the installer closes it), so the project is saved or let go first.
  set({ shown: false });
  if (!(await confirmDiscard())) { set({ shown: true }); return; }
  set({ step: { kind: "installing", update }, shown: true });
  try {
    await update.install();
    write(KEY.skipped, null);
    await backend?.relaunch();
  } catch (e) {
    failed("An error occurred while installing the update. Please try again later.", e);
  }
}

/** Cancel (checking or downloading), OK, or closing an error: back to nothing on screen. */
export function dismiss() {
  const step = get().step;
  generation++;
  if (step.kind === "downloading" || step.kind === "ready") release(step.update);
  set({ step: { kind: "idle" }, shown: false, checking: false });
}

/** For tests: what's stored. */
export const storageKeys = KEY;
