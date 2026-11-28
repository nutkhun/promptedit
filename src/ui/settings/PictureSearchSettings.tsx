// Settings › General › Picture search: whether clips are looked at for what's in them (search by
// "beach", "dog", "night"; src/scenes.ts), and the picture model: downloaded or not, with a button to
// download it now rather than at the first search.

import { useEffect } from "react";
import { PillButton, Switch } from "../buttons";
import { changeSettings, downloadModel, refreshSettings, useScenes } from "../../scenes";

type Row = ({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) => React.ReactElement;

export function PictureSearchRows({ Row }: { Row: Row }) {
  const settings = useScenes((s) => s.settings);
  const model = useScenes((s) => s.model);
  const unavailable = useScenes((s) => s.unavailable);
  useEffect(() => { void refreshSettings(); }, []);

  if (!settings) {
    return (
      <Row title="What's in the picture" detail={unavailable ? "Picture search isn't available in this build." : "…"}>
        <span />
      </Row>
    );
  }
  const state = model ?? settings.model.state;
  const status = state.state === "downloading" ? `Downloading… ${Math.floor(state.progress * 100)}%`
    : state.state === "ready" ? "Downloaded"
    : state.state === "failed" ? `Didn't download: ${state.message}`
    : `Downloads when you first search for something in the picture (${settings.model.sizeMB} MB)`;
  return (
    <>
      <Row title="What's in the picture"
        detail={settings.enabled
          ? "Media search finds clips by what they show (“beach”, “dog”, “night”), and AI agents can too. Clips are looked at on this computer; nothing is uploaded."
          : "Off: Media search matches names and what's said only."}>
        <Switch on={settings.enabled} label="Look at what's in clips" onChange={(v) => void changeSettings({ enabled: v })} />
      </Row>
      <div className="pe-settings-divider" />
      <Row title="Picture model" detail={`${settings.model.label} · ${status}`}>
        {(state.state === "missing" || state.state === "failed") && (
          <PillButton onClick={() => void downloadModel()}>{state.state === "failed" ? "Try Again" : "Download"}</PillButton>
        )}
      </Row>
    </>
  );
}
