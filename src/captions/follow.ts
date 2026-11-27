// Keeps transcripts coming for what the project needs (docs/spec/05-captions-contract.md "When
// transcription starts"):
// - captioned clips' files: read from the backend's cache, and transcribed when they aren't yet
//   (whoever captioned them: the menu, Magic, or an AI agent over MCP);
// - every video/audio file, in the background, but only once the speech model is downloaded (so
//   search by what's said works) — never downloading it without asking;
// - files the model was missing for, once it arrives.

import type { Id, Project } from "../model";
import { store, useStore } from "../store";
import { useCaptions } from "../timeline/captions";
import { captionedAssets, covered } from "./layout";
import { projectCaptions, retypingBlock } from "./blocks";
import { needsDownload, offerModelDownload } from "./speechModel";
import { fetchTranscript, followBackend, onModelChange, refreshModel, requestTranscription, transcriptOf, useTranscripts } from "./store";

/** Asked for this session (so a file that failed isn't retried on every edit). */
const requested = new Set<Id>();

/** An explicit Add Captions tries a file again, even one that failed. */
export function retryTranscription(asset: Id) {
  requested.delete(asset);
}

async function hear(asset: Id, prompt: boolean) {
  await fetchTranscript(asset);
  if (transcriptOf(asset) || requested.has(asset) || useTranscripts.getState().unavailable) return;
  requested.add(asset);
  const st = await requestTranscription(asset);
  if (st?.state !== "needsModel" || !prompt) return;
  const m = useTranscripts.getState().model ?? await refreshModel();
  if (needsDownload(m)) void offerModelDownload();
}

/** Captioned files: their words, heard if need be (asking for the model if it's missing). */
function syncCaptioned(p: Project) {
  for (const id of captionedAssets(p)) void hear(id, true);
}

/** Every file with sound, heard in the background while the model is in. */
let background: ReturnType<typeof setTimeout> | undefined;
function syncLibrary(p: Project) {
  if (useTranscripts.getState().model?.state !== "ready") return;
  if (background !== undefined) clearTimeout(background);
  // A moment after the files arrive, so it doesn't compete with opening them.
  background = setTimeout(() => {
    background = undefined;
    for (const a of store().project.assets) {
      if (a.kind === "image" || (a.kind === "video" && !a.hasAudio)) continue;
      void hear(a.id, false);
    }
  }, 3000);
  void p;
}

/**
 * Picked captions that no longer exist are let go (Editroom `didChange`). While a caption is being
 * retyped its words can move into another phrase (a cut moves as the text grows and shrinks), so the
 * pick follows the caption its first word is in, there and back.
 */
function pruneSelection(p: Project) {
  const caps = useCaptions.getState();
  if (!p.captions) {
    if (caps.selection.size || caps.focused) useCaptions.setState({ selection: new Set(), focused: false });
    return;
  }
  if (!caps.selection.size) return;
  const blocks = projectCaptions(p);
  const typed = retypingBlock();
  if (typed && caps.selection.size === 1) {
    const first = covered(typed)[0];
    const now = blocks.find((b) => b.clipID === typed.clipID && covered(b).includes(first));
    if (now) {
      if (!caps.selection.has(now.id)) useCaptions.setState({ selection: new Set([now.id]) });
      return;
    }
  }
  const ids = new Set(blocks.map((b) => b.id));
  const valid = new Set([...caps.selection].filter((id) => ids.has(id)));
  if (valid.size !== caps.selection.size) useCaptions.setState({ selection: valid });
}

let started = false;
export function startFollowing() {
  if (started) return;
  started = true;
  followBackend();
  void refreshModel().then(() => syncLibrary(store().project));
  syncCaptioned(store().project);
  useStore.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    if (s.project.clips !== prev.project.clips || s.project.captions !== prev.project.captions) syncCaptioned(s.project);
    if (s.project.assets !== prev.project.assets) syncLibrary(s.project);
    pruneSelection(s.project);
  });
  // New words: the timeline and inspector lay the captions out again.
  useTranscripts.subscribe((s, prev) => {
    if (s.version === prev.version && s.states === prev.states && s.model === prev.model) return;
    useCaptions.setState({ version: useCaptions.getState().version + 1 });
    if (s.version !== prev.version) pruneSelection(store().project);
  });
  onModelChange((m) => {
    if (m.state !== "ready") return;
    // The model is in: files that were waiting for it are heard now.
    const st = useTranscripts.getState().states;
    for (const [id, s] of Object.entries(st)) {
      if (s.state === "needsModel") { requested.delete(id); void hear(id, false); }
    }
    syncLibrary(store().project);
  });
}
