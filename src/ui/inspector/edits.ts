// Small helpers for the inspector's edits and the selection it shows.

import type { Clip, ClipPatch, ClipTransform, ColorGrade, Edit, Id } from "../../model";
import { DEFAULT_GRADE } from "../../model";
import { linked } from "../../timing";
import { store } from "../../store";

export const update = (ids: Id[], patch: ClipPatch): Edit => ({ op: "update", ids, patch });

/** The selected clips, in project order (what the inspector edits). */
export function selectedClips(): Clip[] {
  const s = store();
  return s.project.clips.filter((c) => s.selection.has(c.id));
}

/** These clips and everything linked to them (speed changes move linked clips together). */
export const linkedIds = (ids: Iterable<Id>) => [...linked(store().project, ids)];

/** Fresh copies of the clips with these ids, as they are now. */
export function clipsNow(ids: Id[]): Clip[] {
  const set = new Set(ids);
  return store().project.clips.filter((c) => set.has(c.id));
}

export const IDENTITY: ClipTransform = { scale: 1, x: 0, y: 0 };

export function isIdentity(t: ClipTransform | undefined | null): boolean {
  return !t || (t.scale === 1 && t.x === 0 && t.y === 0 && !t.zoom);
}

const sameWheel = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y;

export function isNeutral(g: ColorGrade | undefined | null): boolean {
  if (!g) return true;
  const d = DEFAULT_GRADE;
  return (
    g.look == null && g.exposure === 0 && g.contrast === 0 &&
    g.saturation === 0 && g.temperature === 0 && g.tint === 0 &&
    sameWheel(g.shadows, d.shadows) && sameWheel(g.midtones, d.midtones) && sameWheel(g.highlights, d.highlights)
  );
}

/** One update per clip: each clip's own transform with `body` applied (identity clears it). */
export function transformEdits(clips: Clip[], body: (t: ClipTransform) => ClipTransform): Edit[] {
  return clips.map((c) => update([c.id], { transform: body({ ...(c.transform ?? IDENTITY) }) }));
}

/** One update per clip: each clip's own grade with `body` applied (neutral clears it). */
export function gradeEdits(clips: Clip[], body: (g: ColorGrade) => ColorGrade): Edit[] {
  return clips.map((c) => update([c.id], { grade: body(structuredClone(c.grade ?? DEFAULT_GRADE)) }));
}
