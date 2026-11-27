// Settings (docs/spec/04-ui.md §1.8): General, Shortcuts, Magic, Updates, on a 600 × 640 panel.
//
// Editroom opens Settings as its own window. PromptEdit shows it as a panel over the editor instead:
// one webview keeps every setting live in the same store without syncing windows, and it behaves the
// same on macOS and Windows. Esc or the close button (or ⌘, / Ctrl+, again) closes it; the editor's
// bare-key shortcuts stay off while it's open (§4.1 rule 4).

import { useEffect } from "react";
import { useStore } from "../store";
import { IconButton } from "./buttons";
import { Glyph } from "./icons";
import { GeneralSettings } from "./settings/GeneralSettings";
import { MagicSettings, UpdateSettings } from "./settings/OtherSettings";
import { ShortcutSettings } from "./settings/ShortcutSettings";
import { useShortcuts } from "../commands";
import "./settings/settings.css";

type Tab = "general" | "shortcuts" | "magic" | "updates";
const TABS: [Tab, string, string][] = [
  ["general", "General", "gearshape"], ["shortcuts", "Shortcuts", "keyboard"],
  ["magic", "Magic", "wand.and.sparkles"], ["updates", "Updates", "arrow.down.circle"],
];

export function SettingsWindow() {
  const saved = useStore((s) => s.settingsTab) as string;
  const setSetting = useStore((s) => s.setSetting);
  const set = useStore((s) => s.set);
  // General used to be called Appearance.
  const tab: Tab = saved === "appearance" ? "general" : (TABS.find(([t]) => t === saved)?.[0] ?? "shortcuts");
  const close = () => set({ settingsOpen: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useShortcuts.getState().recording || document.querySelector(".pe-menu, .pe-alert")) return;
      if (e.key === "Escape") {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" && (t as HTMLInputElement).value) return; // Esc clears a search first
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const name = TABS.find(([t]) => t === tab)![1];
  return (
    <div className="pe-settings-scrim" data-modal-open onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="pe-settings" role="dialog" aria-label="Settings">
        <div className="pe-settings-tabs">
          {TABS.map(([t, label, symbol]) => (
            <button key={t} type="button" data-tab={t} className={`pe-settings-tab${t === tab ? " selected" : ""}`} onClick={() => setSetting("settingsTab", t)}>
              <span className="icon"><Glyph symbol={symbol} size={20} weight="regular" /></span>
              <span>{label}</span>
            </button>
          ))}
          <IconButton className="pe-settings-close" symbol="xmark" size={24} help="Close (Esc)" onClick={close} />
        </div>
        <div className="pe-settings-page-title">{name}</div>
        <div className="pe-settings-content">
          {tab === "general" && <GeneralSettings />}
          {tab === "shortcuts" && <ShortcutSettings />}
          {tab === "magic" && <MagicSettings />}
          {tab === "updates" && <UpdateSettings />}
        </div>
      </div>
    </div>
  );
}
