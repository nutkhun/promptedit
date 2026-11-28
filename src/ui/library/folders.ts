// Linked folders in the Media panel (docs/spec/04-ui.md §1.3, §6.3; Editroom EditorModel `mediaFolder`,
// `folderSelection`, `syncFolders`, `showImported`, `locateFolder`): which folder is open, which folders
// are picked, keeping Media in step with the disk (src-tauri/src/folders), and Locate… for a missing one.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { call, inTauri } from "../../api";
import type { Id, ImportResult, Probe, Snapshot } from "../../model";
import { store, useStore } from "../../store";
import { showAlert } from "../Alerts";
import { requestReveal } from "../shell/reveal";
import { contains, MediaTree, nameOf } from "./tree";

interface FolderState {
  /** The folder open in the Media panel (its path); null for the top. */
  open: string | null;
  /** Folders picked in the panel, by path, alongside the picked items (`mediaSelection`). */
  picked: Set<string>;
  /** Bumped after every look at the disk, so the panel checks again what's missing. */
  looked: number;
}

export const useMediaFolders = create<FolderState>(() => ({ open: null, picked: new Set(), looked: 0 }));
const fs = () => useMediaFolders.getState();

export const treeOf = () => new MediaTree(store().project);

// ---- Picking ----

/**
 * Folder picks go with Media's item picks: whenever something else lets go of those or picks something
 * else (a click on the timeline, Esc, Select All, Reveal in Media, a delete), the folders are let go too.
 * Changes made here say so, so they don't count.
 */
let ownWrite = false;
useStore.subscribe((s, prev) => {
  if (s.mediaSelection !== prev.mediaSelection && !ownWrite && fs().picked.size) useMediaFolders.setState({ picked: new Set() });
});

/** Sets Media's picks: items and folders together. */
export function setPicks(items: Iterable<Id>, folders: Iterable<string> = []) {
  ownWrite = true;
  try {
    store().set({ mediaSelection: new Set(items) });
  } finally {
    ownWrite = false;
  }
  useMediaFolders.setState({ picked: new Set(folders) });
}

/** One thing in the panel's order: an item (`a:<id>`) or a folder (`f:<path>`). */
export type PickKey = `a:${string}` | `f:${string}`;
export const assetKey = (id: Id): PickKey => `a:${id}`;
export const folderKey = (path: string): PickKey => `f:${path}`;
let anchor: PickKey | null = null;

/** A click on an item or folder: picks it (⇧ range, ⌘/Ctrl toggle) across folders and items in `order`. */
export function clickPick(key: PickKey, order: PickKey[], e: { shiftKey: boolean; toggle: boolean }) {
  const now = new Set<PickKey>([...store().mediaSelection].map(assetKey));
  for (const f of fs().picked) now.add(folderKey(f));
  let next: Set<PickKey>;
  if (e.shiftKey && anchor && order.includes(anchor)) {
    const [i, j] = [order.indexOf(anchor), order.indexOf(key)].sort((x, y) => x - y);
    next = new Set(order.slice(i, j + 1));
  } else if (e.toggle) {
    next = now;
    if (next.has(key)) next.delete(key); else next.add(key);
    anchor = key;
  } else {
    next = new Set([key]);
    anchor = key;
  }
  const keys = [...next];
  // One thing selected at a time (Swift `clickMedia`): Delete then means these, not the timeline's clips.
  if (store().selection.size) store().set({ selection: new Set() });
  setPicks(keys.filter((k) => k.startsWith("a:")).map((k) => k.slice(2)), keys.filter((k) => k.startsWith("f:")).map((k) => k.slice(2)));
}

/** Opens a folder in the panel (null: the top). What was picked is let go. */
export function openFolder(folder: string | null) {
  setPicks([]);
  useMediaFolders.setState({ open: folder });
}

/** After the library changed under the panel: back up to the nearest folder that's still there. */
export function backUpFolder() {
  const { open } = fs();
  if (open === null) return;
  const up = treeOf().nearest(open);
  if (up !== open) useMediaFolders.setState({ open: up });
}

/** A new project: the top of the panel, nothing picked. */
export function resetFolders() {
  anchor = null;
  useMediaFolders.setState({ open: null, picked: new Set() });
}

// ---- After an import (§1.3 "After a manual import the new items are picked and scrolled into view") ----

/**
 * A hand import shows what came in (Swift `showImported`): a folder brought in that was already inside a
 * linked one opens; new linked folders are picked at the top of the panel and scrolled to; otherwise the
 * folder the first file landed in opens, with the files that landed there picked.
 */
export function showImported(r: ImportResult) {
  const tree = treeOf();
  if (r.opened && tree.exists(r.opened)) {
    openFolder(r.opened);
    return;
  }
  const roots = (r.linked ?? []).filter((p) => tree.isRoot(p));
  const assets = store().project.assets.filter((a) => r.added.includes(a.id));
  if (roots.length) {
    useMediaFolders.setState({ open: null });
    setPicks(assets.filter((a) => tree.folderOf(a) === null).map((a) => a.id), roots);
    anchor = folderKey(roots[0]);
    requestReveal(roots[0]);
    return;
  }
  const first = assets[0];
  if (!first) return;
  const place = tree.folderOf(first);
  useMediaFolders.setState({ open: place });
  setPicks(assets.filter((a) => tree.folderOf(a) === place).map((a) => a.id));
  anchor = assetKey(first.id);
  requestReveal(first.id);
}

// ---- Keeping Media in step with the disk ----

interface SyncResult {
  snapshot: Snapshot;
  added: Id[];
  removed: Id[];
  moved: Id[];
  probes: [Id, Probe][];
  failed: string[];
  retry: boolean;
}

function applySync(r: SyncResult) {
  const s = store();
  if (r.probes.length) {
    const probes: Record<Id, Probe> = { ...s.probes };
    for (const [id, p] of r.probes) probes[id] = p;
    s.set({ probes });
  }
  s.apply(r.snapshot);
  if (r.removed.length && [...s.mediaSelection].some((id) => r.removed.includes(id))) {
    setPicks([...store().mediaSelection].filter((id) => !r.removed.includes(id)), fs().picked);
  }
  backUpFolder();
  useMediaFolders.setState((st) => ({ looked: st.looked + 1 }));
}

async function reportFailed(failed: string[]) {
  if (!failed.length) return;
  const names = failed.map(nameOf);
  await showAlert({
    title: "Import",
    text: `Couldn't import ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}.`,
  });
}

let syncing: Promise<void> | null = null;
let again = false;
let retryTimer: number | undefined;

/**
 * Brings Media up to date with the linked folders on disk: files added come in, files deleted go (unless
 * a clip uses them: those stay, shown missing), renames are followed. Not undoable. Runs when the window
 * comes back to the front, when a project opens, and when a watched folder changes.
 */
export function syncFolders(): Promise<void> {
  if (!store().project.folders?.length) return Promise.resolve();
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      const r = await call<SyncResult>("sync_folders");
      applySync(r);
      window.clearTimeout(retryTimer);
      // Something was still being written (or dragged): looked at again shortly.
      if (r.retry) retryTimer = window.setTimeout(() => void syncFolders(), 1500);
      await reportFailed(r.failed);
    } catch (e) {
      console.warn("folder sync", e);
    } finally {
      syncing = null;
    }
    if (again) {
      again = false;
      await syncFolders();
    }
  })();
  return syncing;
}

/**
 * Follows the linked folders while the panel is up: the backend watches them (FSEvents,
 * ReadDirectoryChangesW, inotify) and counts changes. The app sends an event as they happen; the counter
 * is also polled each second, which is all the browser dev server has. Coming back to the window syncs too.
 */
export function useFolderWatch() {
  useEffect(() => {
    let last: number | undefined;
    let debounce: number | undefined;
    const soon = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void syncFolders(), 250);
    };
    const poll = async () => {
      try {
        const g = await call<number>("folder_changes");
        if (last !== undefined && g !== last) soon();
        last = g;
      } catch { /* an older backend */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    const focus = () => void syncFolders();
    window.addEventListener("focus", focus);
    const un = inTauri ? listen<number>("media-folders-changed", (e) => { last = e.payload; soon(); }) : null;
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(debounce);
      window.removeEventListener("focus", focus);
      un?.then((f) => f());
    };
  }, []);
}

// ---- Locate…, Reload Folder from Disk ----

/** Asks where a linked folder that's gone missing is now; everything in it is found there. */
export async function locateFolder(id: Id) {
  const f = store().project.folders?.find((x) => x.id === id);
  if (!f) return;
  const name = nameOf(f.path);
  let path: string | undefined;
  if (inTauri) {
    const r = await openDialog({ title: `Locate the folder “${name}”`, directory: true, multiple: false });
    path = typeof r === "string" ? r : undefined;
  } else {
    path = window.prompt(`Locate the folder “${name}” (absolute path)`) ?? undefined;
  }
  if (!path) return;
  try {
    const r = await call<SyncResult>("locate_media_folder", { id, path });
    const open = fs().open;
    // The folder open in the panel moves with it.
    if (open !== null && contains(f.path, open)) useMediaFolders.setState({ open: path + open.slice(f.path.length) });
    applySync(r);
    await reportFailed(r.failed);
  } catch (e) {
    await showAlert({ title: "Locate", text: String(e) });
  }
}

/** Reload Folder from Disk: follows renames, brings in new files, and reads everything in it again. */
export async function reloadFolder(folder: string) {
  try {
    const r = await call<SyncResult>("reload_media_folder", { path: folder });
    applySync(r);
    await reportFailed(r.failed);
  } catch (e) {
    await showAlert({ title: "Reload", text: String(e) });
  }
}

/**
 * After a project opens: a linked folder that's gone, with things in it, is offered to be located once
 * for everything in it (§1.9 "The folder “name” is missing").
 */
export async function offerToLocateFolders() {
  const p = store().project;
  for (const f of p.folders ?? []) {
    if (await call<boolean>("path_exists", { path: f.path }).catch(() => true)) continue;
    const n = new MediaTree(p).countUnder(f.path);
    if (!n) continue;
    const r = await showAlert({
      title: `The folder “${nameOf(f.path)}” is missing`,
      text: `${n} item${n === 1 ? " in it can't" : "s in it can't"} be found. Locate the folder and everything in it is found again.`,
      buttons: ["Locate…", "Not Now"], cancel: 1,
    });
    if (r === 0) await locateFolder(f.id);
    return;
  }
}

/** Whether these paths are on disk, checked again after every look at the disk and when the window comes back. */
export function useMissing(paths: string[]): Set<string> {
  const looked = useMediaFolders((s) => s.looked);
  const key = paths.join("\n");
  const [missing, setMissing] = useStateSet();
  useEffect(() => {
    let live = true;
    const check = async () => {
      const gone = new Set<string>();
      await Promise.all(paths.map(async (p) => {
        if (!(await call<boolean>("path_exists", { path: p }).catch(() => true))) gone.add(p);
      }));
      if (live) setMissing(gone);
    };
    void check();
    window.addEventListener("focus", check);
    return () => { live = false; window.removeEventListener("focus", check); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, looked]);
  return missing;
}

function useStateSet(): [Set<string>, (s: Set<string>) => void] {
  const [s, set] = useState<Set<string>>(new Set());
  return [s, (n) => set((old) => (old.size === n.size && [...n].every((x) => old.has(x)) ? old : n))];
}
