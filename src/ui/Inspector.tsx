// The inspector (docs/spec/04-ui.md §1.5): a header naming what's selected, then the sections for
// it. Nothing selected shows the sequence; a focused caption track shows caption style; clips
// show what applies to them. Every change goes through the store's edits (src/ui/inspector/live.ts
// turns drags into one undo step each).

import { useMemo } from "react";
import type { Clip, Project } from "../model";
import { useStore } from "../store";
import { clipName, isTransformable, playsSource } from "../timing";
import { useCaptions } from "../timeline/captions";
import { Glyph } from "./icons";
import { CaptionSections } from "./inspector/CaptionSections";
import { FadeSection } from "./inspector/FadeSection";
import { GradeSection } from "./inspector/GradeSection";
import { PlaybackSection } from "./inspector/PlaybackSection";
import { SequenceSections } from "./inspector/SequenceSections";
import { SolidSection, TextSection, TextTransformSection } from "./inspector/TextSections";
import { TransformSection } from "./inspector/TransformSection";
import { TransitionsSection } from "./inspector/TransitionsSection";
import "./inspector/inspector.css";

/** The clip the header names: the first visual clip, else the first. */
const primary = (clips: Clip[]) => clips.find((c) => c.kind !== "audio") ?? clips[0];
const groupCount = (clips: Clip[]) => new Set(clips.map((c) => c.linkID ?? c.id)).size;

function title(p: Project, clips: Clip[], captions: boolean, captionCount: number): string {
  if (clips.length === 0 && captions) return captionCount > 1 ? `${captionCount} captions` : captionCount === 1 ? "Caption" : "Captions";
  if (clips.length === 0) return "Sequence";
  if (groupCount(clips) === 1) return clipName(p, primary(clips));
  return `${clips.length} clips`;
}

function headerSymbol(clips: Clip[], captions: boolean): string {
  if (clips.length === 0) return captions ? "captions.bubble" : "rectangle.on.rectangle";
  if (clips.every((c) => c.kind === "solid")) return "solid";
  if (groupCount(clips) > 1) return "square.stack";
  switch (primary(clips).kind) {
    case "video": return "film";
    case "audio": return "waveform";
    case "image": return "photo";
    case "text": return "textformat";
    case "solid": return "square.fill";
  }
}

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const captionsFocused = useCaptions((s) => s.focused);
  const captionPicks = useCaptions((s) => s.selection);
  const clips = useMemo(() => project.clips.filter((c) => selection.has(c.id)), [project.clips, selection]);
  const showsCaptions = project.captions != null && (captionsFocused || captionPicks.size > 0);

  return (
    <div className="insp" data-inspector>
      <div className="insp-header">
        <span className="insp-header-icon"><Glyph symbol={headerSymbol(clips, showsCaptions)} size={12} /></span>
        <span className="insp-title">{title(project, clips, showsCaptions, captionPicks.size)}</span>
      </div>
      <div className="insp-body">
        {clips.length === 0 ? (showsCaptions ? <CaptionSections /> : <SequenceSections />) : <ClipSections clips={clips} />}
      </div>
    </div>
  );
}

function ClipSections({ clips }: { clips: Clip[] }) {
  const visual = clips.filter((c) => c.kind !== "audio");
  const audio = clips.filter((c) => c.kind === "audio");
  const sourced = clips.filter(playsSource);
  const movable = visual.filter(isTransformable);
  const single = clips.length === 1 ? clips[0] : undefined;
  // Remount per selection so drafts in fields and graph state never carry over to other clips.
  const key = clips.map((c) => c.id).join(",");
  return (
    <div key={key} style={{ display: "contents" }}>
      {/* What a title or a solid is comes first: its words, or its colour. */}
      {single?.kind === "text" && <TextSection clip={single} />}
      {single?.kind === "solid" && <SolidSection clip={single} />}
      {(sourced.length > 0 || audio.length > 0) && <PlaybackSection clips={clips} />}
      {movable.length > 0 ? (
        <TransformSection clips={movable} />
      ) : (
        visual.length === 1 && visual[0].kind === "text" && <TextTransformSection clip={visual[0]} />
      )}
      {visual.length === 1 && <TransitionsSection clip={visual[0]} />}
      {visual.length > 0 && <FadeSection title={audio.length > 0 ? "Video fade" : "Fade"} clips={visual} />}
      {audio.length > 0 && <FadeSection title={visual.length > 0 ? "Audio fade" : "Fade"} clips={audio} />}
      {visual.length > 0 && <GradeSection clips={visual} />}
    </div>
  );
}
