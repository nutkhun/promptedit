// Media panel operations shared by the panel, its context menu and the Delete key.

import type { Id } from "../../model";
import { store } from "../../store";
import { showAlert } from "../Alerts";
import { backUpFolder, treeOf, useMediaFolders } from "../library/folders";
import { nameOf } from "../library/tree";

/**
 * Takes items out of Media (one undo step), and with `folders`, whole Media panel folders with everything
 * in them. When clips on the timeline use them, asks first: those clips go too (§1.9). The files stay on
 * disk; files in a linked folder stay out of it from then on (hiddenMedia), until Undo.
 */
export async function removeAssets(ids: Id[], folders: string[] = []) {
  const s = store();
  const tree = treeOf();
  const inFolders = new Set(folders.flatMap((f) => tree.assetsUnder(f, s.project.assets).map((a) => a.id)));
  const loose = new Set(ids.filter((id) => !inFolders.has(id)));
  const set = new Set([...loose, ...inFolders]);
  if (!set.size && !folders.length) return;
  const used = s.project.clips.filter((c) => c.assetID && set.has(c.assetID));
  if (used.length) {
    // A video and its linked sound count as one clip, as they look on the timeline.
    const clipCount = new Set(used.map((c) => c.linkID ?? c.id)).size;
    const names = [...s.project.assets.filter((a) => loose.has(a.id)).map((a) => a.name), ...folders.map(nameOf)];
    const r = await showAlert({
      title: names.length === 1 ? (folders.length ? `Delete the folder “${names[0]}”?` : `Delete “${names[0]}”?`) : `Delete ${names.length} items?`,
      text: `${clipCount} clip${clipCount === 1 ? " on the timeline uses" : "s on the timeline use"} ${names.length === 1 ? "it" : "them"} and will be deleted too. The files stay on your computer, and Undo brings everything back.`,
      buttons: ["Delete", "Cancel"],
    });
    if (r !== 0) return;
  }
  await store().edit({ op: "removeAssets", ids: [...set], ...(folders.length ? { folders } : {}) });
  // Setting Media's picks from here lets go of the picked folders too (library/folders.ts).
  const left = new Set([...store().mediaSelection].filter((id) => !set.has(id)));
  store().set({ mediaSelection: left });
  useMediaFolders.setState({ picked: new Set() });
  backUpFolder();
}

/** Whether anything is picked in Media (items or folders). */
export const hasMediaPicks = () => store().mediaSelection.size > 0 || useMediaFolders.getState().picked.size > 0;

/** Delete with Media items or folders picked. */
export const removePickedMedia = () => removeAssets([...store().mediaSelection], [...useMediaFolders.getState().picked]);
