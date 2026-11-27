// Every keyboard-shortcut action (docs/spec/04-ui.md §4.1): titles, groups, default keys per
// platform, the person's changes (persisted), how a key press finds its action, and what each action
// does. Menus (native on macOS, in-window on Windows), the Settings › Shortcuts editor and the
// window's key handler all read this one table.
//
// Key combos are stored platform-neutrally: `command` is the primary modifier (⌘ on macOS, Ctrl on
// Windows/Linux), `option` is ⌥/Alt, and `control` is ⌃ (macOS only; Windows has no separate key for
// it, so recorded Ctrl presses there become `command`). Saved shortcuts round-trip between platforms.

import { create } from "zustand";
import { isMac } from "./api";
import { store } from "./store";
import type { Clip, Id } from "./model";
import { clipEnd, editPoints, isLocked, linked, playRange, playsSource, previousTouching, projectDuration, snapFrame, unlocked } from "./timing";
import * as files from "./ui/shell/files";
import * as playback from "./ui/shell/playback";
import { revealInMedia, revealableAsset } from "./ui/shell/reveal";
import { removePickedMedia } from "./ui/shell/media";
import { useCaptions } from "./timeline/captions";
import { deleteSelectedCaptions } from "./captions/actions";

// ---- Key combos ----

export interface KeyCombo {
  /** A lowercased character ("s", "=", "\\") or a named key (see `NAMED_KEYS`). */
  key: string;
  command?: boolean;
  shift?: boolean;
  option?: boolean;
  control?: boolean;
}

export const NAMED_KEYS = [
  "space", "delete", "forwardDelete", "left", "right", "up", "down", "home", "end", "return", "tab", "pageUp", "pageDown",
] as const;

const cmd = (key: string, more: Partial<KeyCombo> = {}): KeyCombo => ({ key, command: true, ...more });
const k = (key: string, more: Partial<KeyCombo> = {}): KeyCombo => ({ key, ...more });

export const sameCombo = (a: KeyCombo, b: KeyCombo) =>
  a.key === b.key && !!a.command === !!b.command && !!a.shift === !!b.shift && !!a.option === !!b.option && !!a.control === !!b.control;

/** Plain and ⌥/⇧ keys are typing in a text field; ⌘ (Ctrl) and ⌃ ones never are. */
export const typesText = (c: KeyCombo) => !c.command && !c.control;

const DOM_NAMED: Record<string, string> = {
  " ": "space", Backspace: "delete", Delete: "forwardDelete", ArrowLeft: "left", ArrowRight: "right",
  ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end", Enter: "return", Tab: "tab",
  PageUp: "pageUp", PageDown: "pageDown",
};
// Physical keys for punctuation, for when ⌥ turns the character into something else (⌥= is "≠").
const CODE_CHARS: Record<string, string> = {
  Equal: "=", Minus: "-", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

/** The combo a key press makes; undefined for Escape (never assignable) and bare modifier presses. */
export function comboFromEvent(e: KeyboardEvent): KeyCombo | undefined {
  if (e.key === "Escape" || ["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Dead"].includes(e.key)) return undefined;
  let key = DOM_NAMED[e.key];
  if (!key) {
    // Letters and digits by physical key, so ⌥F is "f" (not "ƒ") and Ctrl+Shift+D is "d".
    const letter = /^Key([A-Z])$/.exec(e.code);
    const digit = /^Digit(\d)$/.exec(e.code);
    if (letter) key = letter[1].toLowerCase();
    else if (digit && !e.shiftKey) key = digit[1];
    else if (e.altKey && CODE_CHARS[e.code]) key = e.shiftKey ? e.key.toLowerCase() : CODE_CHARS[e.code];
    else if (e.key.length === 1) key = e.key.toLowerCase();
    else return undefined;
  }
  const primary = isMac ? e.metaKey : e.ctrlKey;
  return {
    key,
    command: primary || undefined,
    shift: e.shiftKey || undefined,
    option: e.altKey || undefined,
    control: (isMac && e.ctrlKey) || undefined,
  };
}

const MAC_KEYS: Record<string, string> = {
  space: "Space", delete: "⌫", forwardDelete: "⌦", left: "←", right: "→", up: "↑", down: "↓", home: "Home",
  end: "End", return: "↩", tab: "⇥", pageUp: "Page Up", pageDown: "Page Down",
};
const WIN_KEYS: Record<string, string> = {
  space: "Space", delete: "Backspace", forwardDelete: "Del", left: "←", right: "→", up: "↑", down: "↓",
  home: "Home", end: "End", return: "Enter", tab: "Tab", pageUp: "Page Up", pageDown: "Page Down",
};

/** "⇧⌘S" on macOS, "Ctrl+Shift+S" on Windows. */
export function displayCombo(c: KeyCombo, mac = isMac): string {
  if (mac) {
    return (c.control ? "⌃" : "") + (c.option ? "⌥" : "") + (c.shift ? "⇧" : "") + (c.command ? "⌘" : "") +
      (MAC_KEYS[c.key] ?? c.key.toUpperCase());
  }
  const parts: string[] = [];
  if (c.command || c.control) parts.push("Ctrl");
  if (c.option) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(WIN_KEYS[c.key] ?? c.key.toUpperCase());
  return parts.join("+");
}

/** The primary modifier's name in prose ("⌘I" / "Ctrl+I"). */
export const primaryKey = (key: string) => displayCombo(cmd(key));

/** An Electron/Tauri accelerator string ("CmdOrCtrl+Shift+S") for a native menu item. */
export function accelerator(c: KeyCombo): string | undefined {
  const names: Record<string, string> = {
    space: "Space", delete: "Backspace", forwardDelete: "Delete", left: "Left", right: "Right", up: "Up", down: "Down",
    home: "Home", end: "End", return: "Enter", tab: "Tab", pageUp: "PageUp", pageDown: "PageDown",
    "=": "Equal", "-": "Minus", "+": "Plus", "\\": "Backslash", ",": "Comma", ".": "Period", "/": "Slash",
  };
  const key = names[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : undefined);
  if (!key) return undefined;
  return [c.command && "CmdOrCtrl", c.control && "Ctrl", c.option && "Alt", c.shift && "Shift", key].filter(Boolean).join("+");
}

// ---- Actions ----

export type Group = "File" | "Edit" | "Playback" | "Tools" | "Clip" | "Mark" | "View";
export const GROUPS: Group[] = ["File", "Edit", "Playback", "Tools", "Clip", "Mark", "View"];

export interface ActionDef {
  id: ActionId;
  title: string;
  group: Group;
  /** Shown in a menu (which shows its first shortcut). */
  inMenu: boolean;
  /** Default keys; `win` where Windows differs. */
  mac: KeyCombo[];
  win?: KeyCombo[];
}

const ACTIONS_LIST = [
  { id: "new", title: "New", group: "File", inMenu: true, mac: [cmd("n")] },
  { id: "open", title: "Open…", group: "File", inMenu: true, mac: [cmd("o")] },
  { id: "save", title: "Save", group: "File", inMenu: true, mac: [cmd("s")] },
  { id: "saveAs", title: "Save As…", group: "File", inMenu: true, mac: [cmd("s", { shift: true })] },
  { id: "importMedia", title: "Import Media…", group: "File", inMenu: true, mac: [cmd("i")] },
  { id: "export", title: "Export…", group: "File", inMenu: true, mac: [cmd("e")] },
  { id: "undo", title: "Undo", group: "Edit", inMenu: true, mac: [cmd("z")] },
  // Windows people also expect Ctrl+Y.
  { id: "redo", title: "Redo", group: "Edit", inMenu: true, mac: [cmd("z", { shift: true })], win: [cmd("z", { shift: true }), cmd("y")] },
  { id: "playPause", title: "Play / Pause", group: "Playback", inMenu: false, mac: [k("space")] },
  { id: "stepBack", title: "Back One Frame", group: "Playback", inMenu: false, mac: [k("left")] },
  { id: "stepForward", title: "Forward One Frame", group: "Playback", inMenu: false, mac: [k("right")] },
  { id: "previousEdit", title: "Previous Edit", group: "Playback", inMenu: false, mac: [k("up"), k("left", { shift: true })] },
  { id: "nextEdit", title: "Next Edit", group: "Playback", inMenu: false, mac: [k("down"), k("right", { shift: true })] },
  { id: "goToStart", title: "Go to Start", group: "Playback", inMenu: false, mac: [k("home")] },
  { id: "goToEnd", title: "Go to End", group: "Playback", inMenu: false, mac: [k("end")] },
  { id: "loop", title: "Loop Playback", group: "Playback", inMenu: false, mac: [k("l")] },
  { id: "fullScreenViewer", title: "Full Screen Viewer", group: "Playback", inMenu: false, mac: [k("f")] },
  { id: "selectTool", title: "Select Tool", group: "Tools", inMenu: false, mac: [k("v"), k("a")] },
  { id: "cutTool", title: "Cut Tool", group: "Tools", inMenu: false, mac: [k("c")] },
  { id: "split", title: "Split at Playhead", group: "Clip", inMenu: true, mac: [cmd("k")] },
  { id: "addDissolve", title: "Add Dissolve", group: "Clip", inMenu: true, mac: [cmd("d")] },
  { id: "detachAudio", title: "Detach Audio", group: "Clip", inMenu: true, mac: [cmd("l", { shift: true })] },
  { id: "duplicate", title: "Duplicate", group: "Clip", inMenu: true, mac: [cmd("d", { shift: true })] },
  { id: "freezeFrame", title: "Freeze Frame", group: "Clip", inMenu: true, mac: [k("f", { option: true })] },
  { id: "reverse", title: "Reverse", group: "Clip", inMenu: true, mac: [k("r", { option: true })] },
  { id: "copyGrade", title: "Copy Grade", group: "Clip", inMenu: true, mac: [cmd("c", { option: true })] },
  { id: "pasteGrade", title: "Paste Grade", group: "Clip", inMenu: true, mac: [cmd("v", { option: true })] },
  { id: "delete", title: "Delete", group: "Clip", inMenu: true, mac: [k("delete"), k("forwardDelete")] },
  { id: "rippleDelete", title: "Ripple Delete", group: "Clip", inMenu: true, mac: [k("delete", { shift: true }), k("forwardDelete", { shift: true })] },
  { id: "rippleTrimStart", title: "Ripple Trim Start to Playhead", group: "Clip", inMenu: true, mac: [k("q")] },
  { id: "rippleTrimEnd", title: "Ripple Trim End to Playhead", group: "Clip", inMenu: true, mac: [k("w")] },
  { id: "addText", title: "Add Text", group: "Clip", inMenu: true, mac: [cmd("t")] },
  // As in Final Cut Pro (Reveal in Browser).
  { id: "revealInMedia", title: "Reveal in Media", group: "Clip", inMenu: true, mac: [k("f", { shift: true })] },
  { id: "addMarker", title: "Add Marker", group: "Mark", inMenu: true, mac: [k("m")] },
  { id: "setIn", title: "Set In", group: "Mark", inMenu: true, mac: [k("i")] },
  { id: "setOut", title: "Set Out", group: "Mark", inMenu: true, mac: [k("o")] },
  { id: "clearInOut", title: "Clear In and Out", group: "Mark", inMenu: true, mac: [k("x", { shift: true })] },
  { id: "zoomIn", title: "Zoom In", group: "View", inMenu: true, mac: [cmd("="), k("="), k("+", { shift: true })] },
  { id: "zoomOut", title: "Zoom Out", group: "View", inMenu: true, mac: [cmd("-"), k("-")] },
  { id: "zoomToFit", title: "Zoom to Fit", group: "View", inMenu: true, mac: [cmd("0"), k("z", { shift: true }), k("\\")] },
  { id: "snapping", title: "Snapping", group: "View", inMenu: true, mac: [k("s")] },
  { id: "sticky", title: "Sticky Edges", group: "View", inMenu: true, mac: [k("r")] },
  { id: "skimming", title: "Skimming", group: "View", inMenu: true, mac: [k("k")] },
  { id: "audioScrubbing", title: "Audio Scrubbing", group: "View", inMenu: true, mac: [k("s", { shift: true })] },
] as const satisfies readonly (Omit<ActionDef, "id"> & { id: string })[];

export type ActionId = (typeof ACTIONS_LIST)[number]["id"];
export const ACTIONS: readonly ActionDef[] = ACTIONS_LIST as unknown as ActionDef[];
export const ACTION: Record<ActionId, ActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<ActionId, ActionDef>;

export const defaultsFor = (a: ActionId, mac = isMac): KeyCombo[] => (mac ? ACTION[a].mac : (ACTION[a].win ?? ACTION[a].mac));

// ---- Shortcuts in use (defaults + the person's changes) ----

/** Same key as Editroom's UserDefaults: `shortcuts` = {actionRawValue: [KeyCombo]}, only changed actions. */
const SHORTCUTS_KEY = "shortcuts";

interface ShortcutState {
  changed: Partial<Record<ActionId, KeyCombo[]>>;
  /** While Settings is recording a shortcut, no shortcut does anything (§4.1 rule 1). */
  recording?: ActionId;
}

function loadChanged(): ShortcutState["changed"] {
  try {
    const saved = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "{}") as Record<string, KeyCombo[]>;
    const out: ShortcutState["changed"] = {};
    for (const [id, combos] of Object.entries(saved)) if (id in ACTION && Array.isArray(combos)) out[id as ActionId] = combos;
    return out;
  } catch {
    return {};
  }
}

export const useShortcuts = create<ShortcutState>(() => ({ changed: loadChanged() }));

function saveChanged(changed: ShortcutState["changed"]) {
  useShortcuts.setState({ changed });
  try {
    if (Object.keys(changed).length === 0) localStorage.removeItem(SHORTCUTS_KEY);
    else localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(changed));
  } catch { /* storage unavailable: changes last this session */ }
}

export const shortcuts = {
  combos: (a: ActionId): KeyCombo[] => useShortcuts.getState().changed[a] ?? defaultsFor(a),
  isChanged: (a: ActionId) => useShortcuts.getState().changed[a] !== undefined,
  /** The action a combo runs, if any. */
  actionFor(c: KeyCombo): ActionId | undefined {
    return ACTIONS.find((a) => shortcuts.combos(a.id).some((x) => sameCombo(x, c)))?.id;
  },
  /** Gives an action one shortcut; another action using it loses it (§4.1 rule 8). Returns that action. */
  set(a: ActionId, c: KeyCombo): ActionId | undefined {
    const changed = { ...useShortcuts.getState().changed };
    let taken: ActionId | undefined;
    for (const other of ACTIONS) {
      if (other.id === a) continue;
      const list = shortcuts.combos(other.id);
      if (list.some((x) => sameCombo(x, c))) {
        changed[other.id] = list.filter((x) => !sameCombo(x, c));
        taken = other.id;
      }
    }
    changed[a] = [c];
    saveChanged(changed);
    return taken;
  },
  clear(a: ActionId) { saveChanged({ ...useShortcuts.getState().changed, [a]: [] }); },
  reset(a: ActionId) {
    const changed = { ...useShortcuts.getState().changed };
    delete changed[a];
    saveChanged(changed);
  },
  resetAll() { saveChanged({}); },
  /** The combo a menu item shows: its first, unless it's a plain multi-character key (§4.1 rule 6). */
  menuCombo(a: ActionId): KeyCombo | undefined {
    const c = shortcuts.combos(a)[0];
    if (!c) return undefined;
    if (!c.command && !c.control && !c.option && c.key.length > 1) return undefined;
    return c;
  },
  /** "⌘K" for tooltips and menus, or "" when it has none. */
  label(a: ActionId): string {
    const c = shortcuts.combos(a)[0];
    return c ? displayCombo(c) : "";
  },
  /** "Split at Playhead (⌘K)". */
  help(a: ActionId, title: string = ACTION[a].title): string {
    const l = shortcuts.combos(a).map((c) => displayCombo(c));
    return l.length ? `${title} (${l.slice(0, 2).join(" or ")})` : title;
  },
};

// ---- What's possible with what's picked (menu enabled states) ----

const S = () => store();
const selectedClips = (): Clip[] => { const s = S(); return s.project.clips.filter((c) => s.selection.has(c.id)); };
const gradable = (): Clip[] => {
  const s = S();
  const ids = unlocked(s.project, s.selection);
  return s.project.clips.filter((c) => ids.has(c.id) && c.kind !== "audio");
};
function dissolveTarget(): Clip | undefined {
  const s = S(), p = s.project;
  const cuts = p.clips.filter((c) => c.kind !== "audio" && !isLocked(p, c.trackID) && previousTouching(p, c) !== undefined);
  const picked = cuts.filter((c) => s.selection.has(c.id) || s.selection.has(previousTouching(p, c)!.id));
  return picked.sort((a, b) => Math.abs(a.start - s.playhead) - Math.abs(b.start - s.playhead))[0];
}
function freezeTarget(): Clip | undefined {
  const s = S(), p = s.project, t = snapFrame(p, s.playhead);
  return p.clips.find((c) => s.selection.has(c.id) && c.kind === "video" && !c.freeze && !isLocked(p, c.trackID) && t >= c.start && t < clipEnd(c));
}
function rippleTrimmable(): boolean {
  const s = S(), p = s.project, t = s.playhead;
  return p.clips.some((c) => c.start < t && clipEnd(c) > t && !isLocked(p, c.trackID));
}
const standardFps = (fps: number) => {
  if (!(fps > 1)) return 30;
  const rates = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120];
  return rates.reduce((best, r) => (Math.abs(r - fps) < Math.abs(best - fps) ? r : best), 30);
};

export const can = {
  delete: () => S().selection.size > 0 || S().mediaSelection.size > 0 || useCaptions.getState().selection.size > 0,
  split: () => { const s = S(); return s.project.clips.some((c) => c.start < s.playhead && clipEnd(c) > s.playhead && !isLocked(s.project, c.trackID)); },
  addDissolve: () => dissolveTarget() !== undefined,
  detachAudio: () => selectedClips().some((c) => c.linkID != null),
  duplicate: () => { const s = S(); return unlocked(s.project, linked(s.project, s.selection)).size > 0; },
  freezeFrame: () => freezeTarget() !== undefined,
  reverse: () => { const s = S(); return selectedClips().some((c) => playsSource(c) && !isLocked(s.project, c.trackID)); },
  copyGrade: () => gradable().length === 1,
  pasteGrade: () => S().copiedGrade !== undefined && gradable().length > 0,
  rippleTrim: rippleTrimmable,
  revealInMedia: () => revealableAsset() !== undefined,
  clearMarkers: () => (S().project.markers ?? []).length > 0,
  clearInOut: () => S().project.inPoint != null || S().project.outPoint != null,
  selectAll: () => S().project.clips.length > 0,
  /** The selected video's asset, for Match Sequence to Clip, when the sequence doesn't already match it. */
  matchable() {
    const s = S(), p = s.project;
    const clip = p.clips.find((c) => s.selection.has(c.id) && c.kind === "video");
    const a = clip?.assetID ? p.assets.find((x) => x.id === clip.assetID) : undefined;
    if (!a || a.width <= 0) return undefined;
    return sequenceMatches(a.id) ? undefined : a;
  },
  export: () => projectDuration(S().project) > 0,
};

/** Whether the sequence already has a video's frame size and rate. */
export function sequenceMatches(asset: Id): boolean {
  const p = S().project;
  const a = p.assets.find((x) => x.id === asset);
  return !!a && a.width === p.width && a.height === p.height && standardFps(a.fps) === p.fps;
}
export { standardFps };

// ---- Doing them ----

const playheadEdit = () => S().playhead;
const sel = () => [...S().selection];

export const clipActions = {
  split: () => S().edit({ op: "splitAtPlayhead", selection: sel(), playhead: playheadEdit() }),
  addDissolve: () => S().edit({ op: "addDissolve", selection: sel(), playhead: playheadEdit() }),
  detachAudio: () => S().edit({ op: "detachAudio", ids: sel() }),
  duplicate: () => S().edit({ op: "duplicate", ids: sel() }),
  freezeFrame: () => S().edit({ op: "freezeFrame", selection: sel(), playhead: playheadEdit() }),
  reverse: () => S().edit({ op: "reverse", selection: sel() }),
  copyGrade() {
    const c = gradable()[0];
    if (c) S().set({ copiedGrade: { grade: c.grade } });
  },
  pasteGrade() {
    const g = S().copiedGrade;
    const ids = gradable().map((c) => c.id);
    if (g && ids.length) S().edit({ op: "pasteGrade", ids, grade: g.grade ?? null });
  },
  async delete(ripple: boolean) {
    // Media's picks come before the timeline's, as in Editroom.
    if (S().mediaSelection.size > 0) return removePickedMedia();
    const s = S();
    // Captions picked (and no clips): their words are left out.
    if (s.selection.size === 0 && useCaptions.getState().selection.size > 0) return deleteSelectedCaptions();
    if (s.selection.size === 0) return;
    await s.edit({ op: "delete", ids: sel(), ripple });
  },
  rippleTrim: (head: boolean) => S().edit({ op: "rippleTrim", selection: sel(), playhead: playheadEdit(), head }),
  addText: () => S().edit({ op: "addAtPlayhead", payloads: [{ type: "text" }], playhead: playheadEdit() }),
  addSolid: () => S().edit({ op: "addAtPlayhead", payloads: [{ type: "solid" }], playhead: playheadEdit() }),
  addMarker: () => S().edit({ op: "addMarker", playhead: playheadEdit() }),
  clearMarkers: () => S().edit({ op: "clearMarkers" }),
  setIn: () => S().edit({ op: "setIn", playhead: playheadEdit() }),
  setOut: () => S().edit({ op: "setOut", playhead: playheadEdit() }),
  clearInOut: () => S().edit({ op: "clearInOut" }),
  closeAllGaps: () => {
    const p = S().project;
    return S().edit({ op: "closeAllGaps", tracks: [...p.videoTracks, ...p.audioTracks].map((t) => t.id) });
  },
  addTrack: (kind: "video" | "audio") => S().edit({ op: "addTrack", kind }),
  matchSequence() {
    const a = can.matchable();
    if (a) S().edit({ op: "matchSequence", asset: a.id });
  },
  selectAll() {
    const s = S();
    s.set({ selection: new Set(s.project.clips.map((c) => c.id)), mediaSelection: new Set() });
  },
  /** ⌘C on the timeline: the selected clips and their linked partners. */
  copy(): boolean {
    const s = S();
    const ids = unlocked(s.project, linked(s.project, s.selection));
    const clips = s.project.clips.filter((c) => ids.has(c.id));
    if (!clips.length) return false;
    s.set({ clipboard: clips.map((c) => structuredClone(c)) });
    return true;
  },
  /** ⌘V: fresh, still-linked copies at the playhead (overwrite), as one undo step. */
  paste(): boolean {
    const s = S();
    if (!s.clipboard.length) return false;
    s.edit({ op: "insert", clips: s.clipboard, at: s.playhead });
    return true;
  },
};

/** Runs an action, as its menu item or shortcut would. */
export function perform(a: ActionId): void {
  const s = S();
  switch (a) {
    case "new": void files.newProject(); break;
    case "open": void files.openProjectDialog(); break;
    case "save": void files.save(); break;
    case "saveAs": void files.saveAs(); break;
    case "importMedia": void files.importDialog(); break;
    case "export": if (!s.viewerOnly) s.set({ exportOpen: true }); break;
    case "undo": void s.undo(); break;
    case "redo": void s.redo(); break;
    case "playPause": playback.togglePlay(); break;
    case "stepBack": playback.step(-1); break;
    case "stepForward": playback.step(1); break;
    case "previousEdit": playback.jumpToEdit(false); break;
    case "nextEdit": playback.jumpToEdit(true); break;
    case "goToStart": playback.seekTo(0); break;
    case "goToEnd": playback.seekTo(projectDuration(s.project)); break;
    case "loop": s.set({ loop: !s.loop }); break;
    case "fullScreenViewer": void playback.toggleViewerFullScreen(); break;
    case "selectTool": s.set({ tool: "select" }); break;
    case "cutTool": s.set({ tool: "cut" }); break;
    case "split": void clipActions.split(); break;
    case "addDissolve": void clipActions.addDissolve(); break;
    case "detachAudio": void clipActions.detachAudio(); break;
    case "duplicate": void clipActions.duplicate(); break;
    case "freezeFrame": void clipActions.freezeFrame(); break;
    case "reverse": void clipActions.reverse(); break;
    case "copyGrade": clipActions.copyGrade(); break;
    case "pasteGrade": clipActions.pasteGrade(); break;
    case "delete": void clipActions.delete(false); break;
    case "rippleDelete": void clipActions.delete(true); break;
    case "rippleTrimStart": void clipActions.rippleTrim(true); break;
    case "rippleTrimEnd": void clipActions.rippleTrim(false); break;
    case "addText": void clipActions.addText(); break;
    case "revealInMedia": revealInMedia(); break;
    case "addMarker": void clipActions.addMarker(); break;
    case "setIn": void clipActions.setIn(); break;
    case "setOut": void clipActions.setOut(); break;
    case "clearInOut": void clipActions.clearInOut(); break;
    case "zoomIn": s.zoomBy(1.4); break;
    case "zoomOut": s.zoomBy(1 / 1.4); break;
    case "zoomToFit": s.zoomToFit(); break;
    case "snapping": s.set({ snapping: !s.snapping }); break;
    case "sticky": s.setSetting("sticky", !s.sticky); break;
    case "skimming": s.setSetting("skimming", !s.skimming); break;
    case "audioScrubbing": s.setSetting("audioScrubbing", !s.audioScrubbing); break;
  }
}

/** Whether an action can run now (menus grey out the rest). */
export function enabled(a: ActionId): boolean {
  switch (a) {
    case "undo": return S().canUndo;
    case "redo": return S().canRedo;
    case "addDissolve": return can.addDissolve();
    case "detachAudio": return can.detachAudio();
    case "duplicate": return can.duplicate();
    case "freezeFrame": return can.freezeFrame();
    case "reverse": return can.reverse();
    case "copyGrade": return can.copyGrade();
    case "pasteGrade": return can.pasteGrade();
    case "revealInMedia": return can.revealInMedia();
    case "delete": case "rippleDelete": return can.delete();
    case "rippleTrimStart": case "rippleTrimEnd": return can.rippleTrim();
    case "clearInOut": return can.clearInOut();
    default: return true;
  }
}

/** Ticked state of the View menu's toggles. */
export function checked(a: ActionId): boolean | undefined {
  const s = S();
  switch (a) {
    case "snapping": return s.snapping;
    case "sticky": return s.sticky;
    case "skimming": return s.skimming;
    case "audioScrubbing": return s.audioScrubbing;
    case "loop": return s.loop;
    default: return undefined;
  }
}

// ---- Dispatch (§4.1 rules 1–9) ----

/** Things that take the keyboard for themselves: Magic's show, an alert, a menu, the export sheet… */
const suspenders = new Set<string>();
/** While any reason is held, no shortcut fires (e.g. "magic" while the Magic show runs: §4.1 rule 2). */
export function suspendShortcuts(reason: string, on = true) {
  if (on) suspenders.add(reason); else suspenders.delete(reason);
}

/** A text field has the keys (inputs, text areas, editable text, menus' search fields). */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "range", "color", "submit", "reset", "file"].includes(type);
  }
  return false;
}

/** Overlays that keep bare keys away from the editor (§4.1 rule 4). */
function overlayOpen(): boolean {
  const s = S();
  return s.exportOpen || s.settingsOpen || suspenders.size > 0 || document.querySelector("[data-modal-open]") !== null;
}

/** True when the native (macOS) menu bar carries this combo, so it will run the action itself. */
let nativeMenu = false;
export function setNativeMenuActive(on: boolean) { nativeMenu = on; }

/**
 * The window's key handler. Returns true when it ran something. Exposed for tests; `installKeyboard`
 * attaches it to the window.
 */
export function handleKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  // 1. Settings is recording a shortcut: the key is for it.
  if (useShortcuts.getState().recording) return false;
  // 2. Magic's show (or another owner) has the keys.
  if (suspenders.size > 0) return false;
  const combo = comboFromEvent(e);
  const typing = isTypingTarget(e.target);
  // 3. In a text field plain/⌥/⇧ keys type, even when they're shortcuts (S, R, K, ⌫…).
  if (typing && (!combo || typesText(combo))) return false;

  // 7. Esc with no modifiers.
  if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (typing || overlayOpen()) return false;
    const s = S();
    if (s.viewerOnly) void playback.toggleViewerFullScreen();
    else s.set({ selection: new Set(), mediaSelection: new Set(), tool: "select" });
    return true;
  }
  if (!combo) return false;
  const a = shortcuts.actionFor(combo);
  if (!a) return false;
  const def = ACTION[a];
  // 4. Bare keys only in the editor, with nothing over it.
  if (typesText(combo) && overlayOpen()) return false;
  // ⌘ combos still work over the export sheet / Settings only for menu actions (as a Mac menu would).
  if (!typesText(combo) && overlayOpen() && !def.inMenu) return false;
  // 5. ⌘-combos of menu actions go through the native menu (so it flashes) when there is one.
  if (nativeMenu && def.inMenu && !typesText(combo)) {
    const first = shortcuts.menuCombo(a);
    if (first && sameCombo(first, combo)) return false;
  }
  if (!enabled(a)) return true; // swallow (no browser default), do nothing
  perform(a);
  return true;
}

/** Installs the window key handler and the clip clipboard (⌘X/⌘C/⌘V, ⌘A). Returns an uninstaller. */
export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // ⌘, opens Settings (the macOS menu has it as a key equivalent; elsewhere it's handled here).
    if (primary && !e.shiftKey && !e.altKey && e.key === "," && !nativeMenu && !useShortcuts.getState().recording && suspenders.size === 0) {
      const s = S();
      s.set({ settingsOpen: !s.settingsOpen });
      e.preventDefault();
      return;
    }
    // ⌘A selects all clips when no text field has the keys.
    if (primary && !e.shiftKey && !e.altKey && e.code === "KeyA" && !isTypingTarget(e.target) && !overlayOpen()) {
      clipActions.selectAll();
      e.preventDefault();
    }
    // Keep the browser's own shortcuts (print, find, reload with ⌘R…) out of an editor window.
    if (primary && !isTypingTarget(e.target) && ["KeyP", "KeyF", "KeyG", "KeyU"].includes(e.code)) e.preventDefault();
  };
  // Clip copy/paste rides on the DOM clipboard events, so the Edit menu's predefined Cut/Copy/Paste
  // (needed for text fields on macOS) and plain ⌘C/⌘V in a browser both reach it.
  const clip = (kind: "copy" | "cut" | "paste") => (e: ClipboardEvent) => {
    if (isTypingTarget(document.activeElement) || overlayOpen()) return;
    const s = S();
    if (kind === "paste") {
      if (clipActions.paste()) e.preventDefault();
      return;
    }
    if (s.selection.size === 0) return;
    if (clipActions.copy()) {
      e.preventDefault();
      if (kind === "cut") void s.edit({ op: "delete", ids: [...s.selection], ripple: false });
    }
  };
  const onCopy = clip("copy"), onCut = clip("cut"), onPaste = clip("paste");
  window.addEventListener("keydown", onKey);
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCut);
  document.addEventListener("paste", onPaste);
  return () => {
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("copy", onCopy);
    document.removeEventListener("cut", onCut);
    document.removeEventListener("paste", onPaste);
  };
}

/** Edit points for Previous/Next Edit (re-exported for the transport's tooltips and tests). */
export { editPoints, playRange };
