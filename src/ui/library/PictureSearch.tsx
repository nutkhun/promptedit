// Media search by what's in the picture (src/scenes.ts): the first time someone searches for something
// no clip is named, and the picture model isn't here, an offer to look at the clips on this computer
// (the model downloads once, only on "Download"); then the download's progress, and how many clips are
// still being looked at, so an empty result reads as "not yet" rather than "nothing".

import { useEffect } from "react";
import type { MediaAsset } from "../../model";
import { changeSettings, downloadModel, followScenes, lookingCount, refreshSettings, useScenes } from "../../scenes";
import { Glyph } from "../icons";
import "./pictureSearch.css";

/** Settings and the library's tagging states, followed while the Media panel is open. */
export function usePictureSearch(assets: MediaAsset[]) {
  const ids = assets.filter((a) => a.kind !== "audio").map((a) => a.id).join(",");
  useEffect(() => { void refreshSettings(); }, []);
  useEffect(() => { followScenes(ids ? ids.split(",") : []); }, [ids]);
}

export function PictureSearchNote({ word, wanted }: { word: string; wanted: boolean }) {
  const settings = useScenes((s) => s.settings);
  const model = useScenes((s) => s.model);
  const unavailable = useScenes((s) => s.unavailable);
  const looking = useScenes((s) => lookingCount(s.states));
  if (unavailable || !settings?.enabled) return null;

  if (model?.state === "downloading") {
    const pct = Math.floor(model.progress * 100);
    return (
      <div className="pe-picture-note" role="status">
        <Glyph symbol="photo" size={11} />
        <span className="say">Downloading picture model… {pct}%</span>
        <span className="bar" role="progressbar" aria-valuenow={pct}><span style={{ width: `${Math.max(4, pct)}%` }} /></span>
      </div>
    );
  }
  if (model?.state === "ready") {
    if (!looking) return null;
    return (
      <div className="pe-picture-note quiet" role="status">
        <Glyph symbol="photo" size={11} />
        <span className="say">Looking at what's in your clips… {looking} to go</span>
      </div>
    );
  }
  // Missing or failed: offered when the search looks for something in the picture.
  if (!wanted || settings.declined) return null;
  const failed = model?.state === "failed" ? model.message : undefined;
  return (
    <div className="pe-picture-offer">
      <div className="head">
        <Glyph symbol="photo" size={11} />
        <span>Find “{word}” in your clips?</span>
      </div>
      <div className="text">
        {failed ? `The download didn't finish: ${failed} ` : ""}
        PromptEdit can look at what's in your videos and photos, on this computer — nothing is uploaded.
        It needs a picture model ({settings.model.sizeMB} MB), downloaded once.
      </div>
      <div className="actions">
        <button type="button" className="pe-picture-not-now" onClick={() => void changeSettings({ declined: true })}>Not Now</button>
        <button type="button" className="pe-picture-download" onClick={() => void downloadModel()}>{failed ? "Try Again" : "Download"}</button>
      </div>
    </div>
  );
}
