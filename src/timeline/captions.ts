// The caption track as the timeline shows it. Caption blocks (phrases of transcript words placed
// where they're said) come from the captions module, which registers a provider here; until one
// does, the caption row shows its empty-state line. Caption picks are timeline state.

import { create } from "zustand";
import type { Id, Project } from "../model";

export interface CaptionBlock {
  /** Stable id of the phrase. */
  id: string;
  /** The clip whose sound it was heard in. */
  clipID: Id;
  start: number;
  end: number;
  text: string;
}

export interface CaptionProvider {
  /** The blocks for a project (also for a project with clips mid-drag, so they follow). */
  blocks(p: Project): CaptionBlock[];
  /** Still transcribing: "Listening for what's said…" instead of "No speech heard…". */
  waiting(): boolean;
  /** Double-click / Edit Caption: focus the caption's text in the inspector. */
  edit?(block: CaptionBlock): void;
  /** Delete Caption(s): leave their words out. */
  remove?(ids: string[]): void;
}

let provider: CaptionProvider | undefined;
export function setCaptionProvider(p: CaptionProvider | undefined) {
  provider = p;
  useCaptions.setState({ version: useCaptions.getState().version + 1 });
}
export const captionProvider = () => provider;

interface CaptionState {
  selection: Set<string>;
  /** The caption track header was clicked: the inspector shows caption style. */
  focused: boolean;
  /** Bumped when the provider or its blocks change, to repaint. */
  version: number;
}

export const useCaptions = create<CaptionState>(() => ({ selection: new Set(), focused: false, version: 0 }));

export const captionBlocks = (p: Project) => (p.captions && provider ? provider.blocks(p) : []);
