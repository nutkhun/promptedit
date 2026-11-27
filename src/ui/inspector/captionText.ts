// Retyping a caption from the inspector's Caption section (docs/spec/04-ui.md §1.5; Editroom's
// CaptionTextField, `typeCaptionText` and `setCaptionText`). The words-to-fixes logic belongs to
// the captions module, which registers an editor here; until one does, the field is read-only.

import { create } from "zustand";
import type { CaptionBlock } from "../../timeline/captions";

export interface CaptionTextEditor {
  /** Live preview while typing (empty text is ignored by the editor). */
  type(block: CaptionBlock, text: string): void;
  /** Typing ended: one undo step; empty text leaves the caption's words out. */
  commit(block: CaptionBlock, text: string): void;
  /** Esc: back to how it was, no step. */
  cancel(block: CaptionBlock): void;
}

interface State {
  editor?: CaptionTextEditor;
  /** A caption whose text should take the keyboard (double-click on the timeline). */
  request?: string;
}

export const useCaptionText = create<State>(() => ({}));

export function setCaptionTextEditor(editor: CaptionTextEditor | undefined) {
  useCaptionText.setState({ editor });
}

/** Puts the cursor in the Caption field for this caption (it must be the one picked). */
export function requestCaptionEdit(blockId: string) {
  useCaptionText.setState({ request: blockId });
}
