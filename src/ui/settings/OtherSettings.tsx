// Settings › Magic and Settings › Updates (docs/spec/04-ui.md §1.8).
//
// Magic's switches live here; the AI-app rows (Connect Claude / ChatGPT…) belong to the Magic module
// and appear when it provides `src/ui/magic/MagicSettings.tsx` exporting `AgentSettings`.

import { useEffect, useState, type ComponentType } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { inTauri } from "../../api";
import { useStore } from "../../store";
import { PillButton, Switch } from "../buttons";
import { checkForUpdates } from "../shell/menuModel";
import { Section, SettingRow } from "./GeneralSettings";

const agentModules = import.meta.glob<{ AgentSettings?: ComponentType }>("../magic/MagicSettings.tsx", { eager: true });
const AgentSettings = Object.values(agentModules)[0]?.AgentSettings;

export function MagicSettings() {
  const enabled = useStore((s) => s.magicEnabled);
  const showWork = useStore((s) => s.magicShowWork);
  const agents = useStore((s) => s.agentsEnabled);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <div className="pe-settings-page pe-settings-scroll">
      <Section title="Magic">
        <SettingRow title="Enable Magic" detail="Magic makes an edit for you: a quick cut on this computer, or one Claude or ChatGPT works out from what you ask. Off hides the Magic button.">
          <Switch on={enabled} label="Enable Magic" onChange={(v) => setSetting("magicEnabled", v)} />
        </SettingRow>
        <div className="pe-settings-divider" />
        <div style={{ opacity: enabled ? 1 : 0.4 }}>
          <SettingRow title="Show Magic at work" detail="Watch the cursors make the edit. Off, the edit appears at once, as one step you can undo.">
            <Switch on={showWork} disabled={!enabled} label="Show Magic at work" onChange={(v) => setSetting("magicShowWork", v)} />
          </SettingRow>
        </div>
      </Section>
      {AgentSettings ? <AgentSettings /> : (
        <Section title="Editing from other apps">
          <SettingRow title="Let AI apps edit in PromptEdit" detail="Claude, ChatGPT and other AI apps can make edits in the open project, each as a step you can undo.">
            <Switch on={agents} label="Let AI apps edit in PromptEdit" onChange={(v) => setSetting("agentsEnabled", v)} />
          </SettingRow>
        </Section>
      )}
    </div>
  );
}

const LAST_CHECK = "updates.lastCheck";
const AUTO_CHECK = "updates.automatic";

export function UpdateSettings() {
  const [version, setVersion] = useState("Development");
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem(AUTO_CHECK) !== "false"; } catch { return true; } });
  const last = (() => { try { return localStorage.getItem(LAST_CHECK); } catch { return null; } })();
  // The updater module answers this event; without one this build doesn't check.
  const [running] = useState(() => !window.dispatchEvent(new CustomEvent("promptedit:updater-present", { cancelable: true })));
  useEffect(() => { if (inTauri) getVersion().then(setVersion).catch(() => {}); }, []);
  const checked = last ? new Date(+last).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never";
  return (
    <div className="pe-settings-page pe-settings-scroll pe-updates">
      <div className="pe-card">
        <div className="card-title">Software Update</div>
        <div className="kv"><span className="k">Installed version</span><span className="v">{version}</span></div>
        <div className="kv"><span className="k">Last checked</span><span className="v">{checked}</span></div>
        <div className="pe-settings-divider" />
        <label className={`pe-check${running ? "" : " off"}`}>
          <input type="checkbox" checked={auto} disabled={!running}
            onChange={(e) => { setAuto(e.target.checked); try { localStorage.setItem(AUTO_CHECK, String(e.target.checked)); } catch { /* ignore */ } }} />
          <span>Check for updates automatically</span>
        </label>
        <div><PillButton onClick={checkForUpdates}>Check for Updates…</PillButton></div>
        {!running && <div className="faint">This build doesn't check for updates.</div>}
      </div>
      <div className="pe-card">
        <div className="card-title">Release Notes</div>
        <div className="dim">Each update lists what's new before you install it. Every version's notes are on GitHub.</div>
        <div>
          <PillButton onClick={() => {
            const url = "https://github.com/robbietilton/Editroom/releases";
            if (inTauri) void openUrl(url); else window.open(url, "_blank", "noopener");
          }}>View GitHub Releases</PillButton>
        </div>
      </div>
    </div>
  );
}
