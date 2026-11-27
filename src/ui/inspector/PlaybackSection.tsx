// Volume, speed and the speed ramp (docs/spec/04-ui.md §1.5 Playback; docs/spec/01-model.md §3.3).
// Speed changes retime the clips (the footage stays, the length follows) and move linked clips
// together; each drag is computed from the project as it was when the drag began, so nothing
// drifts, and respects Sticky.

import { useRef, useState } from "react";
import type { Clip, Edit, Id } from "../../model";
import { store, useStore } from "../../store";
import { formatDB, playsSource } from "../../timing";
import { InspectorSection, ParamRow, RampButton } from "../controls";
import { linkedIds, update } from "./edits";
import { applyAsOneStep } from "./live";
import { setSpeedRampMode, speedRampMode } from "./prefs";
import { isRamped, RAMP_STARTER, rampTime, starterMid, type RampShape } from "./shapes";
import { SpeedRampGraph } from "./SpeedRampGraph";
import { useGesture } from "./useGesture";
import { percent } from "./values";

/** A ramp drawn on the graph, applied to these clips (each keeps its own footage). */
const rampEdit = (ids: Id[], s: RampShape): Edit => ({
  op: "setRamp", ids, speed: s.mid, points: [s.p1, s.p2, s.p3, s.p4], start: s.start, end: s.end, sticky: store().sticky,
});

/** No ramp at `speed` (SpeedRamp.drawn with no eases is nil). */
const noRamp = (ids: Id[], speed: number): Edit => ({
  op: "setRamp", ids, speed, points: [0, 0, 1, 1], start: speed, end: speed, sticky: store().sticky,
});

export function PlaybackSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id);
  const audio = clips.filter((c) => c.kind === "audio");
  const sourced = clips.filter(playsSource);
  const first = sourced[0];
  const ramped = first ? isRamped(first) : false;
  const offSpeed = first ? Math.abs(first.speed - 1) > 0.001 : false;
  const offGain = audio[0] ? Math.abs(audio[0].gainDB) > 0.001 : false;
  const audioIds = audio.map((c) => c.id);
  const edit = useStore((s) => s.edit);
  const playing = useStore((s) => s.playing);
  // While a ramp dot is dragged: the graph stays up (even if the ramp is pulled away), and where
  // the playhead was before it followed the dot.
  const [rampDrag, setRampDrag] = useState(false);
  const playheadBefore = useRef<number | undefined>(undefined);

  const volume = useGesture<number, void>({
    capture: () => undefined,
    make: (v) => [update(audioIds, { gainDB: Math.round(v * 10) / 10 })],
  });
  const speed = useGesture<number, Id[]>({
    capture: () => linkedIds(ids),
    make: (v, group) => [{ op: "setSpeed", ids: group, speed: v / 100, sticky: store().sticky }],
    restore: true,
  });
  const ramp = useGesture<{ shape: RampShape; focus?: number }, Id[]>({
    capture: () => linkedIds(ids),
    make: ({ shape }, group) => [rampEdit(group, shape)],
    restore: true,
    after: ({ focus }) => {
      // The playhead and viewer follow the dot being dragged (never while playing).
      if (focus === undefined || !first || store().playing) return;
      const c = store().project.clips.find((x) => x.id === first.id);
      if (!c) return;
      playheadBefore.current ??= store().playhead;
      store().seek(rampTime(focus, c));
    },
    onBegin: () => {
      playheadBefore.current = undefined;
      setRampDrag(true);
    },
    onEnd: () => {
      setRampDrag(false);
      if (playheadBefore.current !== undefined) store().seek(playheadBefore.current);
      playheadBefore.current = undefined;
    },
  });

  const reset = () => {
    const group = linkedIds(ids);
    const edits: Edit[] = [noRamp(group, 1)];
    if (audioIds.length) edits.push(update(audioIds, { gainDB: 0 }));
    void applyAsOneStep(edits);
  };

  /** On: a starter ramp in the last-picked shape. Off: the ramp goes and each clip keeps its speed. */
  const toggleRamp = () => {
    if (!first) return;
    const group = linkedIds(ids);
    if (ramped) {
      const now = store().project.clips.filter((c) => group.includes(c.id));
      const bySpeed = new Map<number, Id[]>();
      for (const c of now) bySpeed.set(c.speed, [...(bySpeed.get(c.speed) ?? []), c.id]);
      void applyAsOneStep([...bySpeed].map(([spd, g]) => noRamp(g, spd)));
    } else {
      const [p1, p2, p3, p4] = RAMP_STARTER[speedRampMode()];
      void edit(rampEdit(group, { mid: starterMid(first.speed), p1, p2, p3, p4, start: 1, end: 1 }));
    }
  };

  const marked = offSpeed || ramped || offGain;
  return (
    <InspectorSection title="Playback" marked={marked} action={marked ? { label: "Reset", onClick: reset } : undefined}>
      {audio[0] && (
        <ParamRow icon="speaker.wave.2" label="Volume" value={audio[0].gainDB} range={[-60, 12]} format={formatDB} live={volume} />
      )}
      {first && (
        <ParamRow
          icon="clock.arrow.circlepath"
          label="Speed"
          value={first.speed * 100}
          range={[10, 5000]}
          log
          format={percent}
          live={speed}
          inside={<RampButton on={ramped} onClick={toggleRamp} />}
        />
      )}
      {first && (ramped || rampDrag) && (
        <SpeedRampGraph
          clip={first}
          onEditing={(began) => (began ? ramp.begin() : ramp.end())}
          onChange={(shape, focus) => ramp.change({ shape, focus: playing ? undefined : focus })}
          onPick={(mode, shape) => {
            setSpeedRampMode(mode);
            if (shape) void edit(rampEdit(linkedIds(ids), shape));
          }}
        />
      )}
    </InspectorSection>
  );
}
