// Scrolling the Media panel to an item: after a hand import (§1.3 `mediaReveal`) and for Clip ›
// Reveal in Media (⇧F). The Library watches `useReveal` and scrolls the item into view.

import { create } from "zustand";
import type { Id, MediaAsset } from "../../model";
import { store } from "../../store";

export const useReveal = create<{ target?: Id; nonce: number }>(() => ({ nonce: 0 }));

export function requestReveal(asset: Id) {
  useReveal.setState((s) => ({ target: asset, nonce: s.nonce + 1 }));
}

/** The file of the earliest selected clip that has one. */
export function revealableAsset(): MediaAsset | undefined {
  const s = store();
  const clips = s.project.clips.filter((c) => s.selection.has(c.id) && c.assetID).sort((a, b) => a.start - b.start);
  for (const c of clips) {
    const a = s.project.assets.find((x) => x.id === c.assetID);
    if (a) return a;
  }
  return undefined;
}

/** Reveal in Media: the clip's file is picked and scrolled to; the timeline's selection stays. */
export function revealInMedia(asset: Id | undefined = revealableAsset()?.id) {
  if (!asset) return;
  store().set({ mediaSelection: new Set([asset]) });
  requestReveal(asset);
}
