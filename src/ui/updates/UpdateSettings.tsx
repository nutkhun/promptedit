// Settings › Updates (docs/spec/04-ui.md §1.8): "Software Update" (installed version, last checked,
// the automatic-checks checkbox, Check for Updates…) and "Release Notes" (View GitHub Releases).

import { openUrl } from "@tauri-apps/plugin-opener";
import { inTauri } from "../../api";
import { PillButton } from "../buttons";
import { checkForUpdates } from "../shell/menuModel";
import { setAutomatic, useUpdates } from "./controller";

export const RELEASES_URL = "https://github.com/nutkhun/promptedit/releases";

export function UpdateSettings() {
  const version = useUpdates((s) => s.currentVersion);
  const enabled = useUpdates((s) => s.enabled);
  const automatic = useUpdates((s) => s.automatic);
  const checking = useUpdates((s) => s.checking);
  const last = useUpdates((s) => s.lastCheck);
  const checked = last ? new Date(last).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never";
  return (
    <div className="pe-settings-page pe-settings-scroll pe-updates">
      <div className="pe-card">
        <div className="card-title">Software Update</div>
        <div className="kv"><span className="k">Installed version</span><span className="v">{version}</span></div>
        <div className="kv"><span className="k">Last checked</span><span className="v">{checked}</span></div>
        <div className="pe-settings-divider" />
        <label className={`pe-check${enabled ? "" : " off"}`}>
          <input type="checkbox" checked={enabled && automatic} disabled={!enabled} onChange={(e) => setAutomatic(e.target.checked)} />
          <span>Check for updates automatically</span>
        </label>
        {/* Through the menu's command, so a build without the updater answers the same way. */}
        <div><PillButton disabled={checking} onClick={checkForUpdates}>Check for Updates…</PillButton></div>
        {!enabled && <div className="faint">This build doesn't check for updates.</div>}
      </div>
      <div className="pe-card">
        <div className="card-title">Release Notes</div>
        <div className="dim">Each update lists what's new before you install it. Every version's notes are on GitHub.</div>
        <div>
          <PillButton onClick={() => { if (inTauri) void openUrl(RELEASES_URL); else window.open(RELEASES_URL, "_blank", "noopener"); }}>
            View GitHub Releases
          </PillButton>
        </div>
      </div>
    </div>
  );
}
