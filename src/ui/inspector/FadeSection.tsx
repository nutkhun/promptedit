// Fade in / out and their shapes (docs/spec/04-ui.md §1.5 Fade; docs/spec/01-model.md §3.8).
// "Fade" for visual-only or audio-only selections, "Video fade" + "Audio fade" when both. Values
// snap to frames and can't pass the other fade (the backend applies both limits per clip).

import type { Clip, FadeCurve } from "../../model";
import { useStore } from "../../store";
import { CurveMenu, InspectorSection, ParamRow } from "../controls";
import { update } from "./edits";
import { useGesture } from "./useGesture";
import { seconds } from "./values";

export function FadeSection({ title, clips }: { title: string; clips: Clip[] }) {
  const edit = useStore((s) => s.edit);
  const ids = clips.map((c) => c.id);
  const first = clips[0];
  const max = Math.max(0.1, Math.min(first.duration, 10));
  const fadeIn = useGesture<number, void>({ capture: () => undefined, make: (v) => [update(ids, { fadeIn: v })] });
  const fadeOut = useGesture<number, void>({ capture: () => undefined, make: (v) => [update(ids, { fadeOut: v })] });
  const curve = (key: "fadeInCurve" | "fadeOutCurve") => (c: FadeCurve) => void edit(update(ids, { [key]: c }));
  return (
    <InspectorSection title={title} collapsedByDefault marked={first.fadeIn > 0 || first.fadeOut > 0}>
      <ParamRow icon="fadeIn" label="Fade In" value={first.fadeIn} range={[0, max]} format={seconds} live={fadeIn}
        trailing={<CurveMenu selection={first.fadeInCurve ?? "linear"} rising active={first.fadeIn > 0} onPick={curve("fadeInCurve")} />} />
      <ParamRow icon="fadeOut" label="Fade Out" value={first.fadeOut} range={[0, max]} format={seconds} live={fadeOut}
        trailing={<CurveMenu selection={first.fadeOutCurve ?? "linear"} rising={false} active={first.fadeOut > 0} onPick={curve("fadeOutCurve")} />} />
    </InspectorSection>
  );
}
