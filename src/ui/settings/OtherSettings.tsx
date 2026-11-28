// Settings › Magic and Settings › Updates (docs/spec/04-ui.md §1.8).
//
// Magic's switches live here; the AI-app rows (Connect Claude / ChatGPT…) belong to the Magic module
// and appear when it provides `src/ui/magic/MagicSettings.tsx` exporting `AgentSettings`.

import type { ComponentType } from "react";
import { useStore } from "../../store";
import { Switch } from "../buttons";
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

// Settings › Updates lives with the updater (src/ui/updates), which keeps what it shows current.
export { UpdateSettings } from "../updates/UpdateSettings";
