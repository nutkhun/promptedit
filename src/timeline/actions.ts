// Timeline commands: the ones the menus and global shortcuts call (zoomIn, zoomOut, zoomToFit,
// selectAll — owned by the shortcut layer, exported here) and the ones behind the timeline's own
// buttons and context menus. Each edit is one undo step in the Rust core.

import type { Clip, Id, Project, TrackKind, Transition } from "../model";
import { store } from "../store";
import { asset, clipEnd, linked, unlocked } from "../timing";
import { WAVE_RATE, waveform } from "./media";
import { useCaptions } from "./captions";
import * as captions from "../captions/actions";
import { hasMediaPicks, removePickedMedia } from "../ui/shell/media";

const sel = () => [...store().selection];

// ---- View ----

export const zoomIn = () => store().zoomBy(1.4);
export const zoomOut = () => store().zoomBy(1 / 1.4);
export const zoomToFit = () => store().zoomToFit();

/** ⌘A: every clip, locked tracks included; Media picks let go. */
export function selectAll() {
  store().set({ selection: new Set(store().project.clips.map((c) => c.id)), mediaSelection: new Set() });
}

// ---- Clip commands ----

export const splitAtPlayhead = () => store().edit({ op: "splitAtPlayhead", selection: sel(), playhead: store().playhead });

/** The toolbar's Delete: Media picks if there are any, else the selected clips. */
export function deleteSelected(ripple = false) {
  const s = store();
  // Media's picks (items and folders) first, asking when clips use them (src/ui/shell/media.ts).
  if (hasMediaPicks()) return removePickedMedia();
  if (!s.selection.size && useCaptions.getState().selection.size) return captions.deleteSelectedCaptions();
  if (!s.selection.size) return;
  return s.edit({ op: "delete", ids: sel(), ripple });
}

export const deleteClips = (ripple: boolean) => store().edit({ op: "delete", ids: sel(), ripple });
export const detachAudio = () => store().edit({ op: "detachAudio", ids: sel() });
export const freezeFrame = () => store().edit({ op: "freezeFrame", selection: sel(), playhead: store().playhead });
export const reverseSelection = () => store().edit({ op: "reverse", selection: sel() });
export const setSpeed = (speed: number) => store().edit({ op: "setSpeed", ids: sel(), speed, sticky: store().sticky });
export const setTransition = (id: Id, transition: Transition | null) => store().edit({ op: "setTransition", id, transition });
export const removeFades = () => store().edit({ op: "update", ids: sel(), patch: { fadeIn: 0, fadeOut: 0 } });
// Captions: the captions module asks for the speech model and starts listening (src/captions/actions.ts).
export const addCaptions = () => void captions.addCaptions(sel());
export const removeCaptions = (ids: Id[] = sel()) => captions.removeCaptions(ids);
export const matchSequence = (assetID: Id) => store().edit({ op: "matchSequence", asset: assetID });

/** Reveal in Media: pick the clip's file in the Media panel. */
export function revealInMedia(clipID: Id) {
  const c = store().project.clips.find((x) => x.id === clipID);
  if (c?.assetID) store().set({ mediaSelection: new Set([c.assetID]) });
}

/** Selected visual clips on unlocked tracks (grade copy/paste works on these). */
export function gradableSelection(p: Project = store().project): Clip[] {
  const ids = unlocked(p, store().selection);
  return p.clips.filter((c) => ids.has(c.id) && c.kind !== "audio");
}
export const canCopyGrade = () => gradableSelection().length === 1;
export const canPasteGrade = () => store().copiedGrade !== undefined && gradableSelection().length > 0;
export function copyGrade() {
  const c = gradableSelection()[0];
  if (c) store().set({ copiedGrade: { grade: c.grade } });
}
export function pasteGrade() {
  const copied = store().copiedGrade;
  const ids = gradableSelection().map((c) => c.id);
  if (copied && ids.length) store().edit({ op: "pasteGrade", ids, grade: copied.grade ?? null });
}

/** Audio clips among the linked selection that play their file (caption targets). */
export function captionTargets(p: Project, ids: Set<Id>): Id[] {
  const group = linked(p, ids);
  return p.clips.filter((c) => group.has(c.id) && c.kind === "audio" && !c.freeze).map((c) => c.id);
}
export function hasCaptions(p: Project, ids: Set<Id>) {
  const t = new Set(captionTargets(p, ids));
  return p.clips.some((c) => t.has(c.id) && c.captioned === true);
}

/**
 * Even Out Levels: each audio clip (selected, else all) to the same typical level, −20 dB, from its
 * loudness envelope over the part of the file it plays. Clips without an envelope yet are left out.
 */
export function evenOutLevels() {
  const p = store().project;
  const picked = p.clips.filter((c) => store().selection.has(c.id) && c.kind === "audio");
  const clips = (picked.length ? picked : p.clips.filter((c) => c.kind === "audio")).filter((c) => !p.audioTracks.find((t) => t.id === c.trackID)?.locked);
  const gains: Record<Id, number> = {};
  for (const c of clips) {
    if (!c.assetID) continue;
    const env = waveform(c.assetID);
    if (!env) continue;
    const a = Math.max(0, Math.floor(c.sourceStart * WAVE_RATE));
    const b = Math.min(env.length, Math.ceil((c.sourceStart + c.duration * c.speed) * WAVE_RATE));
    let sum = 0, n = 0;
    for (let i = a; i < b; i++) {
      if (env[i] > 0.003) {
        sum += env[i] * env[i];
        n++;
      }
    }
    if (!n) continue;
    const level = 10 * Math.log10(sum / n);
    gains[c.id] = Math.min(12, Math.max(-24, Math.round((-20 - level) * 10) / 10));
  }
  if (Object.keys(gains).length) store().edit({ op: "setGains", gains });
}

// ---- Tracks and gaps ----

export const addTrack = (kind: TrackKind) => store().edit({ op: "addTrack", kind });
export const removeTrack = (id: Id) => store().edit({ op: "removeTrack", id });
export const deleteGap = (track: Id, at: number) => store().edit({ op: "deleteGap", track, at });
export const closeAllGaps = (tracks: Id[]) => store().edit({ op: "closeAllGaps", tracks });
export const duck = (track: Id, under: Id | null, amount?: number) =>
  store().edit({ op: "setTrack", id: track, patch: amount === undefined ? { duckUnder: under } : { duckUnder: under, duckDB: amount } });

/** gap(on: track, at: t): the empty stretch around t, if it's between two clips (not after the last). */
export function gapAt(p: Project, track: Id, t: number): [number, number] | undefined {
  const clips = p.clips.filter((c) => c.trackID === track);
  if (clips.some((c) => c.start <= t && t < clipEnd(c))) return undefined;
  const before = clips.filter((c) => clipEnd(c) <= t + 1e-9).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const afters = clips.filter((c) => c.start >= t - 1e-9).map((c) => c.start);
  if (!afters.length) return undefined;
  const after = Math.min(...afters);
  return after - before > 1e-6 ? [before, after] : undefined;
}

/** The sequence frame rate a file's rate maps to (crates/core edit.rs standard_fps). */
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
const standardFps = (fps: number) =>
  fps <= 1 ? 30 : STANDARD_FPS.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best));

export const sequenceMatches = (p: Project, assetID: Id) => {
  const a = asset(p, assetID);
  return !!a && a.width === p.width && a.height === p.height && standardFps(a.fps) === p.fps;
};
