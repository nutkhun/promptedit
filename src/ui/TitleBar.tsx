// The title bar (docs/spec/04-ui.md §1.1): project title with an unsaved-changes dot in the centre;
// export progress, the Magic button and the Export pill on the right.
//
// macOS: the window's own title bar is transparent ("Overlay") and the traffic lights sit over the left
// end of this bar, as Editroom's unified toolbar does. Windows: the system frame is off and this bar is
// the whole title bar — the menus at the left (there's no global menu bar on Windows, and a native one
// would add a second row), window buttons at the right after Export, and the empty space drags the
// window (double-click maximises), so the editor keeps Editroom's one-row look on both platforms.

import { useEffect, useState, type ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri, isMac } from "../api";
import { shortcuts } from "../commands";
import { useStore } from "../store";
import { PillButton } from "./buttons";
import { ExportProgressPill } from "./export/ExportProgress";
import { Glyph } from "./icons";
import { MenuBar } from "./shell/MenuBar";
import "./titlebar.css";

// The Magic builder's button, when it exists (src/ui/magic/MagicButton.tsx exporting `MagicButton`).
const magicModules = import.meta.glob<{ MagicButton?: ComponentType }>("./magic/MagicButton.tsx", { eager: true });
const MagicButtonImpl = Object.values(magicModules)[0]?.MagicButton;

export function TitleBar() {
  const title = useStore((s) => s.title);
  const dirty = useStore((s) => s.dirty);
  const magicEnabled = useStore((s) => s.magicEnabled);
  const set = useStore((s) => s.set);
  const nativeChrome = isMac;
  return (
    <div className={`pe-titlebar${nativeChrome ? " mac" : " win"}${inTauri ? " tauri" : ""}`} data-tauri-drag-region>
      {!nativeChrome && <MenuBar />}
      <div className="pe-title" data-tauri-drag-region>
        <span className="name" data-tauri-drag-region>{title}</span>
        {dirty && <span className="dirty" title="Unsaved changes" />}
      </div>
      <div className="pe-titlebar-actions">
        <ExportProgressPill />
        {magicEnabled && (MagicButtonImpl ? <MagicButtonImpl /> : <MagicPlaceholder />)}
        <PillButton prominent help={shortcuts.help("export", "Export")} onClick={() => set({ exportOpen: true })} className="pe-export-button">
          Export
        </PillButton>
      </div>
      {!nativeChrome && inTauri && <WindowControls />}
    </div>
  );
}

/** The Magic button's look until the Magic module is in (§1.1): disabled without media; opens nothing. */
function MagicPlaceholder() {
  const hasMedia = useStore((s) => s.project.assets.some((a) => a.kind !== "audio") || s.project.clips.length > 0);
  return (
    <button type="button" className="pe-magic" disabled={!hasMedia}
      title={hasMedia ? "Magic: have Claude or ChatGPT edit, or make a quick cut" : "Import some clips first"}
      onClick={() => window.dispatchEvent(new CustomEvent("promptedit:magic"))}>
      <Glyph symbol="wand.and.sparkles" size={11} weight="semibold" />
      <span>Magic</span>
    </button>
  );
}

/** Windows caption buttons: minimise, maximise/restore, close. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const update = () => void w.isMaximized().then(setMaximized).catch(() => {});
    update();
    const un = w.onResized(update);
    return () => { un.then((f) => f()); };
  }, []);
  const w = () => getCurrentWindow();
  return (
    <div className="pe-window-controls">
      <button type="button" title="Minimize" onClick={() => void w().minimize()}><Glyph symbol="window.minimize" size={10} weight="regular" /></button>
      <button type="button" title={maximized ? "Restore Down" : "Maximize"} onClick={() => void w().toggleMaximize()}>
        <Glyph symbol={maximized ? "window.restore" : "window.maximize"} size={10} weight="regular" />
      </button>
      <button type="button" className="close" title="Close" onClick={() => void w().close()}><Glyph symbol="window.close" size={10} weight="regular" /></button>
    </div>
  );
}
