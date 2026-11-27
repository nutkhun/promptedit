// Transitions on the cuts either side of one visual clip (docs/spec/04-ui.md §1.5 Transitions;
// docs/spec/01-model.md §3.13): In blends from the clip before, Out into the clip after. A
// transition lives on the incoming clip. When the clips' media can't give the length asked for, a
// note says what really happens.

import type { Clip, Transition, TransitionKind } from "../../model";
import { useStore } from "../../store";
import { nextTouching, previousTouching, transitionSpan } from "../../timing";
import { InspectorSection, MenuField, ParamRow, RowIcon, type MenuItem } from "../controls";
import { clipsNow } from "./edits";
import { useGesture } from "./useGesture";
import { seconds } from "./values";

export const TRANSITION_LABEL: Record<TransitionKind, string> = { dissolve: "Dissolve", dipToBlack: "Dip to Black", wipe: "Wipe" };
const KINDS: TransitionKind[] = ["dissolve", "dipToBlack", "wipe"];

export function TransitionsSection({ clip }: { clip: Clip }) {
  const project = useStore((s) => s.project);
  const before = previousTouching(project, clip);
  const after = nextTouching(project, clip);
  if (!before && !after) return null;
  const marked = (before ? clip.transitionIn != null : false) || (after?.transitionIn != null);
  return (
    <InspectorSection title="Transitions" collapsedByDefault marked={marked}>
      {before && <TransitionRows label="In" into={clip} from={before} />}
      {after && <TransitionRows label="Out" into={after} from={clip} />}
    </InspectorSection>
  );
}

function TransitionRows({ label, into, from }: { label: "In" | "Out"; into: Clip; from: Clip }) {
  const project = useStore((s) => s.project);
  const edit = useStore((s) => s.edit);
  const t = into.transitionIn ?? undefined;
  const set = (n: Transition | null) => void edit({ op: "setTransition", id: into.id, transition: n });
  const items: MenuItem[] = [
    { label: "None", onSelect: () => set(null) },
    "divider",
    ...KINDS.map((kind): MenuItem => ({
      label: TRANSITION_LABEL[kind],
      // A new transition starts as a dissolve of 0.5 s; changing kind keeps the length.
      onSelect: () => set({ kind, duration: t?.duration ?? 0.5 }),
    })),
  ];
  const length = useGesture<number, void>({
    capture: () => undefined,
    make: (v) => {
      const now = clipsNow([into.id])[0]?.transitionIn;
      return now ? [{ op: "setTransition", id: into.id, transition: { ...now, duration: Math.round(v * 100) / 100 } }] : [];
    },
  });

  const span = t ? transitionSpan(project, from, into) : undefined;
  const actual = span ? span.end - span.start : 0;
  return (
    <>
      <div className="ctl-row" data-param={`Transition ${label}`}>
        <RowIcon symbol={label === "In" ? "arrow.right.to.line" : "arrow.right.to.line.compact"} />
        <span className="ctl-row-label">{label}</span>
        <MenuField label={t ? TRANSITION_LABEL[t.kind] : "None"} items={items} height={26} />
      </div>
      {t && (
        <>
          <ParamRow icon="timer" label="Length" value={t.duration} range={[0.1, 5]} format={seconds} live={length} />
          {actual < t.duration - 0.01 && (
            <div className="insp-transition-note">
              {actual > 0
                ? `Shortened to ${actual.toFixed(2)}s: no more media beyond the cut.`
                : "Needs media beyond the cut to blend; try Dip to Black."}
            </div>
          )}
        </>
      )}
    </>
  );
}
