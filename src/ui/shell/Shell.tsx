// The app shell: everything window-wide that isn't a panel. Mounted once (App.tsx), it
// - installs the keyboard shortcuts and the clip clipboard (src/commands.ts),
// - keeps the menu bar current (native on macOS; the title bar draws it on Windows),
// - catches files dropped on the window or opened from the OS (§3.12, §6.3),
// - reopens the last session at launch (§1.10), auto-saves (§5), and asks before the window closes,
// - keeps the window title, and draws pop-up menus and alerts.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, inTauri, isMac } from "../../api";
import { installKeyboard, setNativeMenuActive, useShortcuts } from "../../commands";
import { store, useStore } from "../../store";
import { AlertLayer } from "../Alerts";
import { MenuLayer } from "../menu";
import { buildMenus, nativeSpec } from "./menuModel";
import { autosaveNow, confirmDiscard, handleOpen, importFiles, restoreLastSession, useRecents } from "./files";

// Development builds: the store on `window` for tests and the console.
if (import.meta.env.DEV) (window as unknown as { __promptedit: unknown }).__promptedit = { store };

export function Shell() {
  useEffect(() => installKeyboard(), []);
  useNativeMenu();
  useFileDrops();
  useLaunch();
  useAutosave();
  useWindowTitle();
  return (
    <>
      <MenuLayer />
      <AlertLayer />
    </>
  );
}

/** macOS: the menu bar is native, rebuilt (coalesced) whenever what it shows could have changed. */
function useNativeMenu() {
  useEffect(() => {
    if (!(inTauri && isMac)) return;
    let actions = new Map<string, () => void>();
    let last = "";
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const built = nativeSpec(buildMenus());
        actions = built.actions;
        const json = JSON.stringify(built.spec);
        if (json === last) return;
        last = json;
        try {
          setNativeMenuActive(await call<boolean>("set_app_menu", { menus: built.spec }));
        } catch (e) {
          console.error("menu", e);
          setNativeMenuActive(false);
        }
      }, 60);
    };
    refresh();
    const unsubs = [useStore.subscribe(refresh), useShortcuts.subscribe(refresh), useRecents.subscribe(refresh)];
    const un = listen<string>("menu", (e) => actions.get(e.payload)?.());
    return () => {
      window.clearTimeout(timer);
      unsubs.forEach((u) => u());
      un.then((f) => f());
    };
  }, []);
}

/**
 * Files dragged onto the window. Over an element marked `data-file-drop-target` (the timeline), the
 * drop is handed to it as a `promptedit:file-drop` event ({ paths, x, y }) so it can place the files
 * where they land; anywhere else they're imported into Media, which shows its drop overlay meanwhile.
 */
function useFileDrops() {
  useEffect(() => {
    const target = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-file-drop-target]") ?? null;
    if (inTauri) {
      let last: HTMLElement | null = null;
      const leaveLast = (now: HTMLElement | null) => {
        if (last && last !== now) last.dispatchEvent(new CustomEvent("promptedit:file-leave"));
        last = now;
      };
      const un = getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        const dpr = window.devicePixelRatio || 1;
        if (p.type === "leave") { leaveLast(null); store().set({ dropHover: false }); return; }
        const x = p.position.x / dpr, y = p.position.y / dpr;
        const over = target(x, y);
        if (p.type === "drop") last = null; else leaveLast(over);
        if (p.type === "enter" || p.type === "over") {
          if (store().dropHover === !!over) store().set({ dropHover: !over });
          over?.dispatchEvent(new CustomEvent("promptedit:file-drag", { detail: { x, y, paths: p.type === "enter" ? p.paths : undefined } }));
          return;
        }
        store().set({ dropHover: false });
        if (over) over.dispatchEvent(new CustomEvent("promptedit:file-drop", { detail: { paths: p.paths, x, y } }));
        else void handleOpen(p.paths);
      });
      return () => { un.then((f) => f()); };
    }
    // In a browser there are no file paths to import, but the drop overlay still shows.
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const hit = target(e.clientX, e.clientY);
      if (store().dropHover === !!hit) store().set({ dropHover: !hit });
    };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) store().set({ dropHover: false }); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      store().set({ dropHover: false });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
}

/**
 * Launch: opened with files → a new project with them; otherwise the last session's project reopens.
 * Files opened later (Finder, Dock) are handled in this window. The window asks before closing.
 */
let launched = false;
function useLaunch() {
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    // Once per window load (the shell remounts when the viewer goes full screen).
    const first = !launched;
    launched = true;
    if (first) (async () => {
      const files = await call<string[]>("take_open_files").catch(() => [] as string[]);
      if (cancelled) return;
      if (files.length) await handleOpen(files);
      // The last project, or untitled work from the recovery copy (files.ts).
      else await restoreLastSession();
    })();
    const opened = listen("open-files", async () => {
      const files = await call<string[]>("take_open_files").catch(() => [] as string[]);
      if (files.length) await handleOpen(files);
    });
    const w = getCurrentWindow();
    // Closing the window quits: untitled work stays in the recovery copy and reopens next time.
    const closing = w.onCloseRequested(async (e) => {
      if (!(await confirmDiscard({ quitting: true }))) e.preventDefault();
      else await autosaveNow();
    });
    const quit = () => void w.close();
    window.addEventListener("promptedit:quit", quit);
    return () => {
      cancelled = true;
      opened.then((f) => f());
      closing.then((f) => f());
      window.removeEventListener("promptedit:quit", quit);
    };
  }, []);
}

/**
 * Auto-save ~2 s after the last change, never mid-drag (files.ts `autosaveNow`): a saved project writes
 * itself (Auto-save on), or its changes wait in the recovery copy (off); untitled work goes to the recovery copy.
 */
function useAutosave() {
  useEffect(() => {
    let timer: number | undefined;
    let pointerDown = false;
    const down = () => { pointerDown = true; };
    const up = () => { pointerDown = false; schedule(); };
    const schedule = () => {
      window.clearTimeout(timer);
      const s = store();
      if (!s.dirty) return;
      timer = window.setTimeout(async () => {
        if (pointerDown || !store().dirty) return;
        try { await autosaveNow(); } catch { /* the next explicit save reports it */ }
      }, 2000);
    };
    const un = useStore.subscribe((s, prev) => {
      if (s.project !== prev.project || s.dirty !== prev.dirty || s.autosave !== prev.autosave) schedule();
    });
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    return () => {
      un();
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
    };
  }, []);
}

/** The OS window title (taskbar, Mission Control): "<project> — PromptEdit". */
function useWindowTitle() {
  const title = useStore((s) => s.title);
  const dirty = useStore((s) => s.dirty);
  useEffect(() => {
    const text = `${title}${dirty && !isMac ? " •" : ""} — PromptEdit`;
    document.title = text;
    if (inTauri) void getCurrentWindow().setTitle(text).catch(() => {});
  }, [title, dirty]);
}

/** For other modules: import files without picking them (an agent's import). */
export const importQuietly = (paths: string[]) => importFiles(paths, { reveal: false });
