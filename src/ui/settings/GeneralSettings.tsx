// Settings › General (docs/spec/04-ui.md §1.8): theme (each a miniature of the editor in its colours),
// Media layout, how times show, the speech model and language for captions, and Auto-save.

import type { ReactNode } from "react";
import { primaryKey } from "../../commands";
import { useStore, type Theme } from "../../store";
import { Segmented, Switch } from "../buttons";
import { CaptionSettingsRows } from "../../captions/CaptionSettings";

/** The few colours a theme miniature needs (Theme.swift palettes). */
interface Mini { bg: string; panel: string; lane: string; video: string; audio: string; clipStroke: string; text: string; textDim: string; ink: string; accent: string }
const MINI: Record<Exclude<Theme, "auto">, Mini> = {
  dark: { bg: "#0A0A0A", panel: "#111111", lane: "#0D0D0D", video: "#1E1E1E", audio: "#151515", clipStroke: "#2C2C2C", text: "#F2F2F0", textDim: "#9A9A96", ink: "255,255,255", accent: "#FF4A1C" },
  grey: { bg: "#1C1C1C", panel: "#232323", lane: "#1F1F1F", video: "#333333", audio: "#2A2A2A", clipStroke: "#444444", text: "#F2F2F0", textDim: "#A6A6A2", ink: "255,255,255", accent: "#FF4A1C" },
  amber: { bg: "#100B06", panel: "#18120A", lane: "#130E08", video: "#2E2316", audio: "#21180D", clipStroke: "#45341F", text: "#F7E7CF", textDim: "#B39B7C", ink: "255,232,204", accent: "#FFA43A" },
  light: { bg: "#E3E3E0", panel: "#F4F4F2", lane: "#EAEAE7", video: "#6A6A67", audio: "#73736F", clipStroke: "#5A5A57", text: "#1C1C1B", textDim: "#5F5F5B", ink: "0,0,0", accent: "#F0451A" },
};
const THEMES: [Theme, string][] = [["auto", "Auto"], ["dark", "Dark"], ["grey", "Grey"], ["amber", "Amber"], ["light", "Light"]];

/** The editor in miniature (SettingsView.swift `ThemePreview`), on a 100 × 56 grid. */
function Miniature({ p }: { p: Mini }) {
  const top = 56 * 0.11, split = 56 * 0.56;
  const clips: [number, number][] = [[0.04, 0.2], [0.25, 0.28], [0.54, 0.16]];
  return (
    <svg viewBox="0 0 100 56" preserveAspectRatio="none" width="100%" height="100%" aria-hidden>
      <rect width="100" height="56" fill={p.bg} />
      <rect width="100" height={top} fill={p.panel} />
      <rect x="84" y={top * 0.25} width="12" height={top * 0.5} rx={top * 0.25} fill={p.text} />
      <rect y={top} width="22" height={split - top} fill={p.panel} />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x="2.5" y={top + 3.4 + i * 6.2} width="8" height="3.9" rx="0.8" fill={p.video} />
          <rect x="12" y={top + 4.8 + i * 6.2} width="8" height="1" rx="0.5" fill={p.textDim} opacity="0.7" />
        </g>
      ))}
      <rect x="29" y={top + 2.8} width="42" height={split - top - 6.7} fill="#000" />
      <circle cx="50" cy={split - 3.6 + 1.4} r="1.4" fill={p.text} />
      <rect x="78" y={top} width="22" height={split - top} fill={p.panel} />
      {[0, 1, 2].map((i) => <rect key={i} x="81" y={top + 4.5 + i * 5} width="16" height="1" rx="0.5" fill={`rgba(${p.ink},0.12)`} />)}
      <rect y={split} width="100" height="3.9" fill={p.panel} />
      {[0, 1, 2].map((i) => <rect key={i} y={split + 5 + i * 6.7} width="100" height="5.6" fill={p.lane} />)}
      {clips.map(([x, w], i) => (
        <g key={i}>
          <rect x={x * 100} y={split + 5} width={w * 100} height="5.6" rx="1" fill={p.video} stroke={p.clipStroke} strokeWidth="0.4" />
          <rect x={x * 100} y={split + 11.7} width={w * 100} height="5.6" rx="1" fill={p.audio} stroke={p.clipStroke} strokeWidth="0.4" />
        </g>
      ))}
      <rect x="4" y={split + 18.4} width="66" height="5.6" rx="1" fill={p.audio} stroke={p.clipStroke} strokeWidth="0.4" />
      <rect x="36" y={split} width="0.6" height={56 - split} fill={p.accent} />
    </svg>
  );
}

function ThemeChoice({ theme, name, selected, onPick }: { theme: Theme; name: string; selected: boolean; onPick: () => void }) {
  return (
    <button type="button" className={`pe-theme-choice${selected ? " selected" : ""}`} onClick={onPick} aria-pressed={selected}>
      <span className="ring">
        <span className="mini">
          {theme === "auto" ? (
            <>
              <Miniature p={MINI.light} />
              <span className="right-half"><Miniature p={MINI.dark} /></span>
            </>
          ) : (
            <Miniature p={MINI[theme]} />
          )}
        </span>
      </span>
      <span className="name">{name}</span>
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pe-settings-section">
      <div className="pe-settings-label">{title}</div>
      <div className="pe-settings-box">{children}</div>
    </div>
  );
}

export function SettingRow({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="pe-settings-row">
      <div className="text">
        <div className="title">{title}</div>
        {detail && <div className="detail">{detail}</div>}
      </div>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

export function GeneralSettings() {
  const theme = useStore((s) => s.theme);
  const mediaLayout = useStore((s) => s.mediaLayout);
  const timeStyle = useStore((s) => s.timeStyle);
  const autosave = useStore((s) => s.autosave);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <div className="pe-settings-page pe-general">
      <Section title="Theme">
        <div className="pe-theme-row">
          {THEMES.map(([t, name]) => <ThemeChoice key={t} theme={t} name={name} selected={theme === t} onPick={() => setSetting("theme", t)} />)}
        </div>
      </Section>
      <Section title="View">
        <SettingRow title="Media">
          <Segmented options={[["thumbnails", "Thumbnails"], ["list", "List"]]} value={mediaLayout} onChange={(v) => setSetting("mediaLayout", v)} />
        </SettingRow>
        <div className="pe-settings-divider" />
        <SettingRow title="Show time as">
          <Segmented mono options={[["timecode", "00:00:05:15"], ["simple", "0:05.50"]]} value={timeStyle} onChange={(v) => setSetting("timeStyle", v)} />
        </SettingRow>
      </Section>
      <Section title="Captions">
        <CaptionSettingsRows Row={SettingRow} />
      </Section>
      <Section title="Saving">
        <SettingRow title="Auto-save" detail={autosave ? "Saved projects save themselves as you edit." : `Projects change only when you save (${primaryKey("s")}).`}>
          <Switch on={autosave} label="Auto-save" onChange={(v) => setSetting("autosave", v)} />
        </SettingRow>
      </Section>
    </div>
  );
}
