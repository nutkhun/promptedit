// Captions: what's said in captioned clips, shown on the caption track, in the inspector and on the
// picture (docs/spec/05-captions-contract.md). Importing this module plugs it in: the timeline's caption
// provider, the inspector's caption text editor, and the transcripts following the project.

import type { Id } from "../model";
import { store } from "../store";
import { setCaptionProvider } from "../timeline/captions";
import { setCaptionTextEditor } from "../ui/inspector/captionText";
import { captionEditor, deleteCaptions, editCaption } from "./actions";
import { projectCaptions } from "./blocks";
import { startFollowing } from "./follow";
import { captionedAssets, type TranscriptWord } from "./layout";
import { pending, seedTranscript, useTranscripts } from "./store";

setCaptionProvider({
  blocks: projectCaptions,
  waiting: () => captionedAssets(store().project).some(pending),
  edit: editCaption,
  remove: (ids) => void deleteCaptions(ids),
});
setCaptionTextEditor(captionEditor);
startFollowing();

declare global {
  interface Window {
    /** Dev builds only: puts a transcript in place without the speech backend (UI tests). */
    __peSeedTranscript?: (asset: Id, words: TranscriptWord[], language?: string) => void;
    __peTranscripts?: typeof useTranscripts;
  }
}
if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__peSeedTranscript = seedTranscript;
  window.__peTranscripts = useTranscripts;
}
