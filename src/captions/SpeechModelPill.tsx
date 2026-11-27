// The title bar's speech model download progress (next to export progress): shown while the model
// downloads after the first Add Captions, and when the download failed (click to try again).

import { Glyph } from "../ui/icons";
import { offerModelDownload } from "./speechModel";
import { useTranscripts } from "./store";
import "./captions.css";

export function SpeechModelPill() {
  const model = useTranscripts((s) => s.model);
  if (model?.state === "downloading") {
    const pct = Math.floor(model.progress * 100);
    return (
      <div className="pe-speech-pill" title="Downloading the speech model, for captions" role="progressbar" aria-valuenow={pct}>
        <Glyph symbol="captions.bubble" size={11} />
        <span className="bar"><span style={{ width: Math.max(3, 56 * model.progress) }} /></span>
        <span className="mono status">{pct}%</span>
      </div>
    );
  }
  if (model?.state === "failed") {
    return (
      <button type="button" className="pe-speech-pill failed" title={`The speech model didn't download: ${model.message}`}
        onClick={() => void offerModelDownload(true)}>
        <Glyph symbol="exclamationmark.triangle.fill" size={11} style={{ color: "var(--error)" }} />
        <span className="word">Speech model</span>
      </button>
    );
  }
  return null;
}
