// The menu bar (docs/spec/04-ui.md §4.2), described once. On macOS it becomes the native menu bar
// (src-tauri/src/menu.rs builds it from this description); on Windows and in the browser the title bar
// draws it in the window (MenuBar.tsx), since the window has its own title bar there.
//
// Shortcuts shown in menus follow §4.1 rule 6 (no plain multi-character keys), and on macOS only
// combos with ⌘/⌃/⌥ go to the native menu: a bare-key key equivalent (M, I, O…) would be taken by the
// menu before a text field could type it, so the window's key handler runs those instead (rule 3).

import { getVersion } from "@tauri-apps/api/app";
import { inTauri, isMac } from "../../api";
import { ACTION, accelerator, can, checked, clipActions, displayCombo, enabled, perform, shortcuts, type ActionId, type KeyCombo } from "../../commands";
import type { Clip } from "../../model";
import { store } from "../../store";
import { showAlert } from "../Alerts";
import { baseName, clearRecents, openProjectPath, useRecents } from "./files";
import { revealInMedia } from "./reveal";

export type MenuNode =
  | { kind: "item"; id: string; text: string; enabled: boolean; checked?: boolean; combo?: KeyCombo; run: () => void }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; enabled?: boolean; items: MenuNode[] }
  /** macOS standard items (text-field Cut/Copy/Paste, Hide, Quit, window items…). */
  | { kind: "predefined"; which: Predefined; text?: string };
export type Predefined = "cut" | "copy" | "paste" | "selectAll" | "hide" | "hideOthers" | "showAll" | "quit" | "minimize" | "zoom" | "fullscreen" | "closeWindow";

export interface TopMenu { text: string; items: MenuNode[] }

const SEP: MenuNode = { kind: "separator" };
const item = (id: string, text: string, run: () => void, on = true, combo?: KeyCombo, isChecked?: boolean): MenuNode =>
  ({ kind: "item", id, text, run, enabled: on, combo, checked: isChecked });
/** A menu item for a shortcut action: its title, shortcut, enabled and ticked state. */
const act = (a: ActionId, text: string = ACTION[a].title): MenuNode =>
  item(`action.${a}`, text, () => perform(a), enabled(a), shortcuts.menuCombo(a), checked(a));

const selectedClips = (): Clip[] => { const s = store(); return s.project.clips.filter((c) => s.selection.has(c.id)); };

export async function aboutPromptEdit() {
  let version = "development build";
  if (inTauri) {
    try { version = `Version ${await getVersion()}`; } catch { /* keep the fallback */ }
  }
  await showAlert({
    title: "PromptEdit",
    text: `${version}\nFast video editing for Mac and PC.\n\nUses FFmpeg, licensed under the LGPL 2.1.`,
  });
}

/** Check for Updates…: the updater module listens for this event; without one, says so. */
export function checkForUpdates() {
  const handled = !window.dispatchEvent(new CustomEvent("promptedit:check-updates", { cancelable: true }));
  if (!handled) void showAlert({ title: "Check for Updates", text: "This build doesn't check for updates." });
}

const settings = () => store().set({ settingsOpen: true });

export function buildMenus(): TopMenu[] {
  const s = store();
  const recents = useRecents.getState().paths;
  const sel = selectedClips();
  const captioned = sel.length > 0 && sel.every((c) => c.captioned);
  const hasSound = sel.some((c) => c.kind === "audio" || (c.kind === "video" && c.assetID && s.project.assets.find((a) => a.id === c.assetID)?.hasAudio));

  const file: MenuNode[] = [
    act("new"), act("open"),
    {
      kind: "submenu", text: "Open Recent", items: [
        ...recents.map((p, i) => item(`recent.${i}`, baseName(p).replace(/\.(room|cutplay)$/i, ""), () => void openProjectPath(p, true))),
        ...(recents.length ? [SEP] : []),
        item("recent.clear", "Clear Menu", clearRecents, recents.length > 0),
      ],
    },
    SEP, act("save"), act("saveAs"), SEP, act("importMedia"), act("export"),
  ];
  if (!isMac) file.push(SEP, item("app.settings", "Settings…", settings, true, { key: ",", command: true }), SEP, item("app.exit", "Exit", () => window.dispatchEvent(new CustomEvent("promptedit:quit"))));

  const edit: MenuNode[] = [
    act("undo"), act("redo"), SEP,
    // On macOS these must be the standard items, or text fields lose ⌘X/⌘C/⌘V; they fire the page's
    // clipboard events, which also carry clips (commands.ts installKeyboard).
    ...(isMac
      ? [{ kind: "predefined", which: "cut" } as MenuNode, { kind: "predefined", which: "copy" } as MenuNode, { kind: "predefined", which: "paste" } as MenuNode]
      : [
        item("edit.cut", "Cut", () => document.execCommand("cut"), true, { key: "x", command: true }),
        item("edit.copy", "Copy", () => document.execCommand("copy"), true, { key: "c", command: true }),
        item("edit.paste", "Paste", () => clipActions.paste(), s.clipboard.length > 0, { key: "v", command: true }),
      ]),
    act("delete"),
    item("edit.selectAll", "Select All", () => {
      const el = document.activeElement as HTMLInputElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.select();
      else clipActions.selectAll();
    }, true, { key: "a", command: true }),
  ];

  const clip: MenuNode[] = [
    act("split"), act("addDissolve"), act("detachAudio"), act("duplicate"), act("freezeFrame"), act("reverse"), SEP,
    act("copyGrade"), act("pasteGrade"), SEP,
    item("clip.matchSequence", "Match Sequence to Clip", clipActions.matchSequence, can.matchable() !== undefined),
    item(`action.revealInMedia`, "Reveal in Media", () => revealInMedia(), can.revealInMedia(), shortcuts.menuCombo("revealInMedia")),
    SEP, act("delete"), act("rippleDelete"), act("rippleTrimStart"), act("rippleTrimEnd"),
    item("clip.closeAllGaps", "Close All Gaps", () => void clipActions.closeAllGaps(), s.project.clips.length > 0),
    SEP, act("addText"),
    item("clip.addSolid", "Add Solid", () => void clipActions.addSolid()),
    item("clip.captions", captioned ? "Remove Captions" : "Add Captions", () =>
      void s.edit(captioned ? { op: "removeCaptions", ids: sel.map((c) => c.id) } : { op: "addCaptions", ids: sel.map((c) => c.id) }),
    !!hasSound),
    SEP,
    item("clip.addVideoTrack", "Add Video Track", () => void clipActions.addTrack("video")),
    item("clip.addAudioTrack", "Add Audio Track", () => void clipActions.addTrack("audio")),
  ];

  const mark: MenuNode[] = [
    act("addMarker"), item("mark.clearMarkers", "Clear All Markers", () => void clipActions.clearMarkers(), can.clearMarkers()),
    SEP, act("setIn"), act("setOut"), act("clearInOut"),
  ];

  const view: MenuNode[] = [
    act("zoomIn"), act("zoomOut"), act("zoomToFit"), SEP,
    item("view.filmstrips", "Filmstrips", () => s.setSetting("thumbnails", !s.thumbnails), true, undefined, s.thumbnails),
    act("snapping"), act("sticky"), act("skimming"), act("audioScrubbing"),
    ...(isMac ? [SEP, { kind: "predefined", which: "fullscreen" } as MenuNode] : []),
  ];

  const menus: TopMenu[] = [];
  if (isMac) {
    menus.push({
      text: "PromptEdit", items: [
        item("app.about", "About PromptEdit", aboutPromptEdit), item("app.updates", "Check for Updates…", checkForUpdates), SEP,
        item("app.settings", "Settings…", settings, true, { key: ",", command: true }), SEP,
        { kind: "predefined", which: "hide" }, { kind: "predefined", which: "hideOthers" }, { kind: "predefined", which: "showAll" }, SEP,
        { kind: "predefined", which: "quit", text: "Quit PromptEdit" },
      ],
    });
  }
  menus.push({ text: "File", items: file }, { text: "Edit", items: edit }, { text: "Clip", items: clip }, { text: "Mark", items: mark }, { text: "View", items: view });
  if (isMac) menus.push({ text: "Window", items: [{ kind: "predefined", which: "minimize" }, { kind: "predefined", which: "zoom" }] });
  else menus.push({ text: "Help", items: [item("app.updates", "Check for Updates…", checkForUpdates), SEP, item("app.about", "About PromptEdit", aboutPromptEdit)] });
  return menus;
}

/** For the in-window menu bar: the shortcut text an item shows. */
export const comboText = (c?: KeyCombo) => (c ? displayCombo(c) : undefined);

// ---- Native menu (macOS) ----

export interface NativeNode {
  kind: "item" | "separator" | "submenu" | "predefined";
  id?: string;
  text?: string;
  enabled?: boolean;
  checked?: boolean;
  accelerator?: string;
  which?: Predefined;
  items?: NativeNode[];
}

/** The description sent to `set_app_menu`, and the actions its ids run. */
export function nativeSpec(menus: TopMenu[]): { spec: NativeNode[]; actions: Map<string, () => void> } {
  const actions = new Map<string, () => void>();
  const conv = (n: MenuNode): NativeNode => {
    switch (n.kind) {
      case "separator": return { kind: "separator" };
      case "predefined": return { kind: "predefined", which: n.which, text: n.text };
      case "submenu": return { kind: "submenu", text: n.text, enabled: n.enabled ?? true, items: n.items.map(conv) };
      case "item": {
        actions.set(n.id, n.run);
        // Bare keys never become native key equivalents (see the note at the top).
        const accel = n.combo && (n.combo.command || n.combo.control || n.combo.option) ? accelerator(n.combo) : undefined;
        return { kind: "item", id: n.id, text: n.text, enabled: n.enabled, checked: n.checked, accelerator: accel };
      }
    }
  };
  return { spec: menus.map((m) => ({ kind: "submenu", text: m.text, enabled: true, items: m.items.map(conv) })), actions };
}
