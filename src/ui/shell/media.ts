// Media panel operations shared by the panel, its context menu and the Delete key.

import type { Id } from "../../model";
import { store } from "../../store";
import { showAlert } from "../Alerts";

/**
 * Takes items out of Media (one undo step). When clips on the timeline use them, asks first: those
 * clips go too (§1.9). The files stay on disk.
 */
export async function removeAssets(ids: Id[]) {
  const s = store();
  const set = new Set(ids);
  if (!set.size) return;
  const used = s.project.clips.filter((c) => c.assetID && set.has(c.assetID));
  if (used.length) {
    // A video and its linked sound count as one clip, as they look on the timeline.
    const clipCount = new Set(used.map((c) => c.linkID ?? c.id)).size;
    const names = s.project.assets.filter((a) => set.has(a.id)).map((a) => a.name);
    const r = await showAlert({
      title: names.length === 1 ? `Delete “${names[0]}”?` : `Delete ${names.length} items?`,
      text: `${clipCount} clip${clipCount === 1 ? " on the timeline uses" : "s on the timeline use"} ${names.length === 1 ? "it" : "them"} and will be deleted too. The files stay on your computer, and Undo brings everything back.`,
      buttons: ["Delete", "Cancel"],
    });
    if (r !== 0) return;
  }
  await store().edit({ op: "removeAssets", ids: [...set] });
  const left = new Set([...store().mediaSelection].filter((id) => !set.has(id)));
  store().set({ mediaSelection: left });
}

/** Delete with Media items picked. */
export const removePickedMedia = () => removeAssets([...store().mediaSelection]);
