// The speech model, downloaded once on first use and never without asking
// (docs/spec/05-captions-contract.md "When transcription starts"): the first Add Captions asks, with
// the download's size; progress shows in the title bar; transcription starts once it's in.

import { showAlert } from "../ui/Alerts";
import { transcriptionModelDownload, transcriptionSettingsGet, type ModelState, type SpeechModelInfo } from "../transcripts";
import { refreshModel, setModel, useTranscripts } from "./store";

/** Asked this session (whatever the answer): files that need the model don't ask again on their own. */
let asked = false;
let asking: Promise<boolean> | undefined;

export const formatSize = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`);

export const needsDownload = (m: ModelState | undefined) => m?.state === "missing" || m?.state === "failed";

/** The chosen model, from the settings (undefined when the backend can't say). */
async function chosenModel(): Promise<SpeechModelInfo | undefined> {
  try {
    const s = await transcriptionSettingsGet();
    return s.models.find((m) => m.id === s.model);
  } catch {
    return undefined;
  }
}

/**
 * Asks to download the speech model and starts it on "Download". Resolves true when the model is
 * there or on its way. `force` asks even if this session already asked (an explicit Add Captions).
 */
export function offerModelDownload(force = false): Promise<boolean> {
  if (asking) return asking;
  if (asked && !force) return Promise.resolve(false);
  asking = (async () => {
    try {
      const model = await chosenModel();
      const size = model ? ` (${model.label}, ${formatSize(model.sizeMB)})` : "";
      asked = true;
      const failed = useTranscripts.getState().model;
      const choice = await showAlert({
        title: "Download the speech model?",
        text: (failed?.state === "failed" ? `The last download didn't finish: ${failed.message}\n\n` : "") +
          `Captions come from what's said in your clips. PromptEdit listens on this computer, so nothing you ` +
          `say is sent anywhere; it needs a speech model for that${size}, downloaded once.\n\n` +
          "You can choose a faster or more accurate model in Settings › General.",
        buttons: ["Download", "Cancel"],
      });
      if (choice !== 0) return false;
      setModel(await transcriptionModelDownload(model?.id));
      return true;
    } catch (err) {
      await showAlert({ title: "Download the speech model", text: `The download couldn't start: ${String(err)}` });
      return false;
    } finally {
      asking = undefined;
    }
  })();
  return asking;
}

/**
 * Before captioning: makes sure the model is there or coming. False when the person said no (or
 * there's no transcription backend, which never blocks captioning: seeded or cached words still show).
 */
export async function modelReadyOrComing(): Promise<boolean> {
  const m = await refreshModel();
  if (!needsDownload(m)) return true;
  return offerModelDownload(true);
}
