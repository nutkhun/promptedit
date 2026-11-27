// Caption commands: Clip › Add Captions / Remove Captions, the timeline's caption menus, Delete on
// picked captions, and retyping a caption (Editroom EditorModel "Captions"; docs/spec/01-model.md §3.20,
// docs/spec/04-ui.md §1.9 "Nothing to caption").

import { api } from "../api";
import type { Edit, Id } from "../model";
import { store } from "../store";
import { unlocked } from "../timing";
import { useCaptions } from "../timeline/captions";
import { requestCaptionEdit } from "../ui/inspector/captionText";
import { endGesture, sendLive, settled } from "../ui/inspector/live";
import { showAlert } from "../ui/Alerts";
import { projectCaptions, setRetyping } from "./blocks";
import { captionTargets, captionTextFixes, defaultCaptionTargets, hasCaptions, splitWords, type CaptionBlock } from "./layout";

export { captionTargets, defaultCaptionTargets, hasCaptions };
import { modelReadyOrComing } from "./speechModel";
import { fetchTranscript, transcriptOf } from "./store";
import { retryTranscription } from "./follow";
import type { CaptionBlock as TimelineCaptionBlock } from "../timeline/captions";

/** Clip › Add Captions or Remove Captions (Editroom `captionsMenuTitle`). */
export function captionsMenuTitle(): string {
  const s = store();
  return s.selection.size > 0 && hasCaptions(s.project, s.selection) ? "Remove Captions" : "Add Captions";
}

/** Editroom `canCaption`: the picked clips have sound to caption. */
export const canCaption = () => captionTargets(store().project, store().selection).size > 0;

/** The menu item: removes the picked clips' captions if they have them, else adds them. */
export async function captionsFromMenu() {
  const s = store();
  if (s.selection.size > 0 && hasCaptions(s.project, s.selection)) return removeCaptions();
  const added = await addCaptions();
  // Captioned, or the person chose not to download the speech model: nothing more to say.
  if (added === "declined" || added > 0) return;
  await showAlert({
    title: "Nothing to caption",
    text: store().selection.size === 0
      ? "Captions come from what's said in clips of people talking. Add some to the timeline, or pick a clip with sound."
      : "The picked clips have no sound to caption.",
  });
}

/**
 * Captions the picked clips' speech, or with nothing (or everything) picked, every clip of people
 * talking. Asks to download the speech model first when it's needed and missing. Returns how many
 * clips were captioned (0: nothing to caption), or "declined" when the person didn't want the download.
 */
export async function addCaptions(ids: Iterable<Id> = store().selection): Promise<number | "declined"> {
  const s = store(), p = s.project;
  const picked = new Set(ids);
  const everything = picked.size === 0 || p.clips.every((c) => picked.has(c.id));
  const targets = unlocked(p, everything ? defaultCaptionTargets(p) : captionTargets(p, picked));
  if (targets.size === 0) return 0;
  const files = [...new Set(p.clips.filter((c) => targets.has(c.id) && c.assetID).map((c) => c.assetID!))];
  // Words already heard need no model.
  await Promise.all(files.map((id) => fetchTranscript(id)));
  if (files.some((id) => !transcriptOf(id)) && !(await modelReadyOrComing())) return "declined";
  for (const id of files) retryTranscription(id);
  await store().edit({ op: "addCaptions", ids: [...picked] });
  return targets.size;
}

/** Takes captions off the clips (and what's linked to them). */
export async function removeCaptions(ids: Iterable<Id> = store().selection) {
  const targets = captionTargets(store().project, ids);
  if (targets.size === 0) return;
  await store().edit({ op: "removeCaptions", ids: [...targets] });
}

export async function removeCaptionTrack() {
  useCaptions.setState({ selection: new Set(), focused: false });
  await store().edit({ op: "removeCaptionTrack" });
}

export const setCaptionsHidden = (hidden: boolean) => store().edit({ op: "setCaptionsHidden", hidden });

// ---- Picked captions ----

/** The full caption for a timeline block (the timeline hands back what the provider gave it). */
function full(b: TimelineCaptionBlock): CaptionBlock | undefined {
  if ("words" in b && "assetID" in b) return b as CaptionBlock;
  return projectCaptions(store().project).find((x) => x.id === b.id);
}

/** One `setCaptionFixes` per file: a caption's words, or several captions' from the same file. */
function fixEdits(changes: { block: CaptionBlock; text: string }[]): Edit[] {
  const byAsset = new Map<Id, Edit & { op: "setCaptionFixes" }>();
  for (const { block, text } of changes) {
    const e = byAsset.get(block.assetID) ?? { op: "setCaptionFixes", asset: block.assetID, fixes: [] };
    e.fixes.push(...captionTextFixes(block, text));
    byAsset.set(block.assetID, e);
  }
  return [...byAsset.values()];
}

/** Leaves the captions' words out (the speech isn't touched). One undo step. */
export async function deleteCaptions(ids: Iterable<string>) {
  const want = new Set(ids);
  const picked = projectCaptions(store().project).filter((b) => want.has(b.id));
  if (!picked.length) return;
  useCaptions.setState({ selection: new Set() });
  const edits = fixEdits(picked.map((block) => ({ block, text: "" })));
  if (edits.length === 1) return store().edit(edits[0]);
  // Captions from several files: their edits made as one step.
  await settled();
  for (const e of edits) await store().edit(e, true);
  await store().commitLive();
}

/** Delete with captions picked and no clips. */
export async function deleteSelectedCaptions() {
  await deleteCaptions(useCaptions.getState().selection);
}

/** Double-click / Edit Caption: the caption picked and its text taking the keyboard in the inspector. */
export function editCaption(b: TimelineCaptionBlock) {
  if (store().selection.size) store().set({ selection: new Set() });
  useCaptions.setState({ selection: new Set([b.id]), focused: false });
  requestCaptionEdit(b.id);
}

// ---- Retyping a caption (inspector) ----

/** Whether a live retype has been sent since typing began. */
let typing = false;

export const captionEditor = {
  /** Shown at once; empty text waits for more typing rather than removing the caption. */
  type(b: TimelineCaptionBlock, text: string) {
    const block = full(b);
    if (!block || splitWords(text).length === 0) return;
    typing = true;
    setRetyping(block);
    sendLive(fixEdits([{ block, text }]));
  },
  /** One undo step; empty text leaves the caption's words out. */
  commit(b: TimelineCaptionBlock, text: string) {
    const block = full(b);
    const wasTyping = typing;
    typing = false;
    if (!block) return;
    if (!wasTyping && text === block.text) return;
    setRetyping(block);
    sendLive(fixEdits([{ block, text }]));
    void endGesture().finally(() => setRetyping(undefined));
  },
  /** Esc: back to how it was, no step. */
  cancel() {
    if (!typing) return;
    typing = false;
    void (async () => {
      await settled();
      store().apply(await api.discardLive());
      setRetyping(undefined);
    })();
  },
};
