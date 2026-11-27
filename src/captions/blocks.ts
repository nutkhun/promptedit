// The project's captions, laid out from the transcripts in hand. Kept until the captioned clips, the
// fixes or a transcript change: the timeline asks on every repaint and the viewer on every frame.

import type { Project } from "../model";
import { captionBlocks, type CaptionBlock } from "./layout";
import { transcriptOf, useTranscripts } from "./store";

interface Memo { clips: Project["clips"]; fixes: Project["captionFixes"]; on: boolean; version: number; blocks: CaptionBlock[] }
let memo: Memo | undefined;

/** Every caption in the project (none without a caption track). */
export function projectCaptions(p: Project): CaptionBlock[] {
  const version = useTranscripts.getState().version;
  const on = p.captions != null;
  if (memo && memo.clips === p.clips && memo.fixes === p.captionFixes && memo.on === on && memo.version === version) return memo.blocks;
  const blocks = on ? captionBlocks(p, (a) => transcriptOf(a.id)) : [];
  memo = { clips: p.clips, fixes: p.captionFixes, on, version, blocks };
  return blocks;
}

/**
 * The caption being retyped in the inspector, as it was when typing began. Its words can land in a
 * caption with another id as they're retyped (a phrase cut moves), so the pick follows them.
 */
let retyping: CaptionBlock | undefined;
export const setRetyping = (b: CaptionBlock | undefined) => { retyping = b; };
export const retypingBlock = () => retyping;
