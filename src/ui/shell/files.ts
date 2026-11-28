// Projects and media files: New / Open / Save / Save As (.room), Import (files, or a folder to link),
// files opened from the OS or dropped on the window (docs/spec/04-ui.md §1.9, §6.3), recent projects,
// auto-save and the recovery copy, and reopening the last session (docs/spec/01-model.md §1.3–§1.4).
//
// Native dialogs come from tauri-plugin-dialog. In a plain browser (the dev server, tests) there are no
// file dialogs, so a prompt asks for absolute paths instead.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { api, call, inTauri, isMac } from "../../api";
import type { Id, ImportResult, MediaAsset, Probe, Snapshot } from "../../model";
import { store } from "../../store";
import { showAlert } from "../Alerts";
import { offerToLocateFolders, resetFolders, showImported, syncFolders } from "../library/folders";

export const PROJECT_EXTENSIONS = ["room", "cutplay"];
/** What the open panel offers (§6.2): common formats plus those FFmpeg converts. */
export const MEDIA_EXTENSIONS = [
  "mp4", "mov", "m4v", "mkv", "webm", "avi", "flv", "wmv", "mts", "m2ts", "ts", "mxf", "ogv", "3gp", "mpg", "mpeg",
  "vob", "f4v", "hevc", "wav", "mp3", "m4a", "aac", "aif", "aiff", "caf", "ogg", "opus", "flac",
  "jpg", "jpeg", "png", "heic", "heif", "gif", "tif", "tiff", "bmp", "webp",
];

const extOf = (path: string) => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
export const isProjectFile = (path: string) => PROJECT_EXTENSIONS.includes(extOf(path));
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const dirName = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

// ---- Recent projects and the last session (§4.2 Open Recent, §5 lastSession) ----

const RECENTS_KEY = "recentProjects";
const LAST_SESSION_KEY = "lastSession";
const loadRecents = (): string[] => {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]"); } catch { return []; }
};
export const useRecents = create<{ paths: string[] }>(() => ({ paths: loadRecents() }));
function persistRecents(paths: string[]) {
  useRecents.setState({ paths });
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(paths)); } catch { /* ignore */ }
}
function noteRecent(path: string) {
  persistRecents([path, ...useRecents.getState().paths.filter((p) => p !== path)].slice(0, 10));
  try { localStorage.setItem(LAST_SESSION_KEY, path); } catch { /* ignore */ }
}
export const clearRecents = () => persistRecents([]);
export const lastSession = (): string | null => { try { return localStorage.getItem(LAST_SESSION_KEY); } catch { return null; } };
const forgetSession = () => { try { localStorage.removeItem(LAST_SESSION_KEY); } catch { /* ignore */ } };
const setLastSession = (v: string) => { try { localStorage.setItem(LAST_SESSION_KEY, v); } catch { /* ignore */ } };

// ---- The recovery copy (§1.3: `lastSession` "untitled", `recoveryFor`) ----

/** `lastSession` for untitled work kept in the recovery copy. */
const UNTITLED = "untitled";
const RECOVERY_FOR_KEY = "recoveryFor";
/** The project file the recovery copy holds unsaved changes to (Auto-save off). */
const recoveryFor = (): string | null => { try { return localStorage.getItem(RECOVERY_FOR_KEY); } catch { return null; } };
function setRecoveryFor(path: string | null) {
  try { if (path) localStorage.setItem(RECOVERY_FOR_KEY, path); else localStorage.removeItem(RECOVERY_FOR_KEY); } catch { /* ignore */ }
}
/** The project last written to the recovery copy: an unchanged project isn't written again. */
let lastRecovered: unknown = null;

async function writeRecovery() {
  const s = store();
  if (lastRecovered === s.project) return true;
  try {
    s.apply(await call<Snapshot>("recovery_save"));
    lastRecovered = store().project;
    return true;
  } catch (e) {
    console.warn("recovery copy", e);
    return false;
  }
}

async function discardRecovery() {
  lastRecovered = null;
  setRecoveryFor(null);
  try { await call("recovery_discard"); } catch { /* nothing to remove */ }
}

/**
 * Auto-save (Swift `autosaveNow`), run ~2 s after the last change and when the window closes. A saved
 * project with Auto-save on is written in place. With Auto-save off its changes wait in the recovery copy.
 * Untitled work goes to the recovery copy (and reopens at the next launch); untitled and empty, the copy
 * is removed.
 */
export async function autosaveNow() {
  // The backend commits any live change before it writes (save_project, recovery_save). Not committing
  // here keeps the project object unchanged when there's nothing new, so this doesn't run again and again.
  const now = store();
  const empty = now.project.clips.length === 0 && now.project.assets.length === 0;
  if (now.file && now.autosave) {
    if (!now.dirty) return;
    await saveQuietly();
    setLastSession(now.file);
  } else if (now.file) {
    if (!now.dirty) return;
    if (await writeRecovery()) {
      setRecoveryFor(now.file);
      setLastSession(now.file);
    }
  } else if (empty) {
    await discardRecovery();
    if (lastSession() === UNTITLED) forgetSession();
  } else if (now.dirty && (await writeRecovery())) {
    setRecoveryFor(null);
    setLastSession(UNTITLED);
  }
}

/** Unsaved changes are let go: the recovery copy is removed (Swift `dropUnsaved`). */
async function dropUnsaved() {
  await discardRecovery();
  if (!store().file && lastSession() === UNTITLED) forgetSession();
}

/**
 * Launch: reopens what was being worked on last time — the project file, or untitled work from the
 * recovery copy (still unsaved). Unsaved changes to that file from last time (Auto-save off) are put back
 * over it, still unsaved.
 */
export async function restoreLastSession() {
  const last = lastSession();
  if (!last) return;
  if (last === UNTITLED) {
    try {
      applyFresh(await call<Snapshot>("recovery_open", { file: null }));
      lastRecovered = store().project;
    } catch { forgetSession(); }
    return;
  }
  if (!(await call<boolean>("path_exists", { path: last }).catch(() => false))) return;
  await openProjectPath(last, false);
  if (recoveryFor() === last && store().file === last) {
    try {
      applyFresh(await call<Snapshot>("recovery_open", { file: last }));
      lastRecovered = store().project;
    } catch { setRecoveryFor(null); }
  }
}

// ---- Dialogs ----

async function askPaths(message: string): Promise<string[]> {
  const typed = window.prompt(`${message}\n(Absolute paths; separate several with commas.)`);
  return typed ? typed.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

async function pickOpen(o: { title: string; filters: { name: string; extensions: string[] }[]; multiple: boolean; directory?: boolean }): Promise<string[]> {
  if (!inTauri) return askPaths(o.title);
  const r = await openDialog({ title: o.title, multiple: o.multiple, directory: o.directory ?? false, filters: o.directory ? undefined : o.filters });
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/** Folder chooser ("Choose", can create folders): the export sheet's Location. */
export async function pickFolder(defaultPath?: string): Promise<string | undefined> {
  if (!inTauri) return (await askPaths("Folder for exports"))[0];
  const r = await openDialog({ directory: true, multiple: false, defaultPath, title: "Choose", canCreateDirectories: true });
  return typeof r === "string" ? r : undefined;
}

// ---- Applying a snapshot that replaced the whole project ----

function applyFresh(s: Snapshot) {
  const st = store();
  st.set({ selection: new Set(), mediaSelection: new Set(), playhead: 0, skim: undefined, probes: {}, clipboard: [] });
  resetFolders();
  st.apply(s);
  // ffprobe details (rotation, codec) for the engine, in the background.
  void probeAll(s.project.assets);
  // Linked folders brought up to date with the disk; one that's gone is offered to be located.
  void syncFolders().then(() => offerToLocateFolders());
}

async function probeAll(assets: MediaAsset[]) {
  for (const a of assets) {
    try {
      const probe = await api.probeMedia(a.playablePath ?? a.path);
      store().set({ probes: { ...store().probes, [a.id]: probe } });
    } catch { /* missing file: shown offline by the engine */ }
  }
}

// ---- Before closing a project ----

/**
 * Before the project is replaced (New, Open, a project file dropped). With Auto-save on, a saved project is
 * already on disk; untitled work asks before it's thrown away. Off: unsaved changes ask Save / Cancel /
 * Don't Save. Returns whether to go ahead.
 */
export async function confirmDiscard({ quitting = false }: { quitting?: boolean } = {}): Promise<boolean> {
  const s = store();
  if (s.autosave) {
    // Quitting keeps untitled work in the recovery copy, which reopens next time.
    if (quitting || !s.dirty || s.project.clips.length === 0) return true;
    if (s.file) { await autosaveNow(); return true; }
    const r = await showAlert({
      title: "Discard unsaved changes?", text: `Your changes to “${s.title}” will be lost.`, buttons: ["Discard", "Cancel"],
    });
    if (r === 0) await dropUnsaved();
    return r === 0;
  }
  await s.commitLive();
  if (!s.dirty || (s.project.clips.length === 0 && s.project.assets.length === 0)) return true;
  const r = await showAlert({
    title: `Save changes to “${s.title}”?`, text: "Your changes will be lost if you don't save them.",
    buttons: ["Save", "Cancel", "Don't Save"], cancel: 1,
  });
  if (r === 0) return save();
  if (r === 2) await dropUnsaved();
  return r === 2;
}

// ---- File menu ----

export async function newProject() {
  if (!(await confirmDiscard())) return;
  applyFresh(await api.newProject());
  await discardRecovery();
  forgetSession();
}

export async function openProjectDialog() {
  const [path] = await pickOpen({ title: "Open", multiple: false, filters: [{ name: "PromptEdit Project", extensions: PROJECT_EXTENSIONS }] });
  if (path) await openProjectPath(path, true);
}

/** Opens a project file. `confirmed`: the save/discard question was already asked. */
export async function openProjectPath(path: string, ask = true) {
  if (ask && !(await confirmDiscard())) return;
  try {
    applyFresh(await api.openProject(path));
    noteRecent(path);
  } catch (e) {
    await showAlert({ title: "Open", text: typeof e === "string" ? e : `Couldn't open ${baseName(path)}.` });
    persistRecents(useRecents.getState().paths.filter((p) => p !== path));
  }
}

/** Writes the project file; the recovery copy goes once the work is safely in a file (Swift `write(to:)`). */
async function writeProject(path?: string) {
  const wasUntitled = !store().file;
  store().apply(await api.saveProject(path));
  if (wasUntitled || recoveryFor()) await discardRecovery();
}

async function saveQuietly() {
  try { await writeProject(); } catch { /* reported by the next explicit save */ }
}

/** Save: to the current file, or ask where (Save As) the first time. Returns whether it saved. */
export async function save(): Promise<boolean> {
  const s = store();
  if (!s.file) return saveAs();
  try {
    await writeProject();
    noteRecent(s.file);
    return true;
  } catch (e) {
    await showAlert({ title: "Save", text: String(e) });
    return false;
  }
}

export async function saveAs(): Promise<boolean> {
  const s = store();
  let path: string | null | undefined;
  if (inTauri) {
    path = await saveDialog({
      title: "Save As", defaultPath: s.file ?? `${s.title}.room`,
      filters: [{ name: "PromptEdit Project", extensions: ["room"] }],
    });
  } else {
    path = (await askPaths("Save project as (.room)"))[0];
  }
  if (!path) return false;
  if (!isProjectFile(path)) path += ".room";
  try {
    await writeProject(path);
    noteRecent(path);
    return true;
  } catch (e) {
    await showAlert({ title: "Save", text: String(e) });
    return false;
  }
}

// ---- Import (§1.3, §1.9, §6.3) ----

export async function importDialog() {
  const paths = await pickOpen({
    title: "Import Media", multiple: true,
    filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }, { name: "All Files", extensions: ["*"] }],
  });
  if (paths.length) await importFiles(paths);
}

/**
 * Import Folder…: a folder is linked — everything in it comes in, and Media keeps following it on disk.
 * (Editroom's one panel takes files and folders; the system pickers here take one or the other.)
 */
export async function importFolderDialog() {
  const paths = await pickOpen({ title: "Import Folder", multiple: true, directory: true, filters: [] });
  if (paths.length) await importFiles(paths);
}

/**
 * Brings files into Media. A hand import picks what came in and scrolls to it; an agent's (`reveal:
 * false`) leaves the panel alone. The first video brought into a project offers to match the sequence.
 */
export async function importFiles(paths: string[], { reveal = true }: { reveal?: boolean } = {}): Promise<Id[]> {
  if (!paths.length) return [];
  const st = store();
  st.set({ importing: st.importing + 1 });
  let r: ImportResult;
  try {
    r = await api.importMedia(paths);
  } catch (e) {
    await showAlert({ title: "Import", text: String(e) });
    return [];
  } finally {
    store().set({ importing: Math.max(0, store().importing - 1) });
  }
  const s = store();
  const probes: Record<Id, Probe> = { ...s.probes };
  for (const [id, p] of r.probes) probes[id] = p;
  s.set({ probes });
  s.apply(r.snapshot);
  // A hand import shows what came in: its folder opens, and the new items or folder are picked.
  if (reveal) showImported(r);
  if (r.failed.length) {
    const names = r.failed.map(baseName);
    await showAlert({
      title: "Import",
      text: names.length === 1
        ? `“${names[0]}” couldn't be imported. It may not be a video, audio or image file PromptEdit can read.`
        : `${names.length} files couldn't be imported:\n${names.slice(0, 8).join("\n")}${names.length > 8 ? "\n…" : ""}`,
    });
  } else if (r.empty?.length) {
    await showAlert({ title: "Import", text: `There's no media in “${r.empty[r.empty.length - 1]}”.` });
  }
  const firstVideo = r.snapshot.project.assets.find((a) => r.added.includes(a.id) && a.kind === "video");
  if (firstVideo) await offerMatch(firstVideo);
  return r.added;
}

const fpsLabel = (fps: number) => `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`;
const standard = (fps: number) => {
  if (!(fps > 1)) return 30;
  const rates = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120];
  return rates.reduce((b, r) => (Math.abs(r - fps) < Math.abs(b - fps) ? r : b), 30);
};

/** Asked once, on the first video brought into a project: adopt its frame size and rate? */
async function offerMatch(a: MediaAsset) {
  const p = store().project;
  if (p.settingsLocked || a.width <= 0 || a.height <= 0) return;
  const fps = standard(a.fps);
  // Asked once whatever the answer: the sequence's settings are settled from here on.
  try { store().apply(await call<Snapshot>("set_settings_locked", { locked: true })); } catch { /* older backend */ }
  if (a.width === p.width && a.height === p.height && fps === p.fps) return;
  const r = await showAlert({
    title: `Match the sequence to “${a.name}”?`,
    text: `${a.width} × ${a.height} · ${fpsLabel(fps)}\nThe sequence is currently ${p.width} × ${p.height} · ${fpsLabel(p.fps)}.`,
    buttons: ["Match", "Keep Current"], cancel: 1,
  });
  if (r === 0) await store().edit({ op: "matchSequence", asset: a.id });
}

/** Files handed over from outside (Finder/Explorer, the Dock, a window drop): a project opens, anything else imports. */
export async function handleOpen(paths: string[]) {
  const project = paths.find(isProjectFile);
  if (project) await openProjectPath(project, true);
  const media = paths.filter((p) => !isProjectFile(p));
  if (media.length) await importFiles(media);
}

/** "Show in Finder" / "Show in Explorer". */
export const showInFolderLabel = isMac ? "Show in Finder" : "Show in Explorer";
export async function showInFolder(path: string) {
  try { await call("reveal_path", { path }); } catch { /* not available in the browser */ }
}

// Development builds: the session functions for tests and the console (the dev server has no app launch).
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __promptedit_files: unknown }).__promptedit_files = { autosaveNow, restoreLastSession, confirmDiscard };
