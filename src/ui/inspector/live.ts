// Continuous inspector edits (slider drags, graph drags, wheels, typing) on top of the store's
// live edits (docs/spec/01-model.md §4): every gesture becomes exactly one undo step.
//
// - A gesture sends absolute edits computed from the clips as they were when it began, so values
//   never drift. Edits that retime clips (speed, ramp) also put the project back to how it was
//   before applying again (`restore`), because each retime starts from the current length.
// - Only the newest edit is kept while one is on its way to the backend, so a fast drag doesn't
//   queue up hundreds of round trips; requests are strictly ordered.
// - "Auto-commit" edits (text clip words, font, colours) become a step after a 0.8 s pause.

import { api } from "../../api";
import type { Edit } from "../../model";
import { store } from "../../store";

interface Batch {
  edits: Edit[];
  restore: boolean;
  after?: () => void;
}

let pending: Batch | undefined;
let running: Promise<void> | undefined;
let autoTimer: ReturnType<typeof setTimeout> | undefined;

async function pump() {
  while (pending) {
    const b = pending;
    pending = undefined;
    try {
      // Back to the state the gesture started from (no-op when nothing is live yet).
      if (b.restore) await api.discardLive();
      for (const e of b.edits) await store().edit(e, true);
      b.after?.();
    } catch (err) {
      store().set({ error: String(err) });
    }
  }
  running = undefined;
}

/** Sends a live change; replaces any change still waiting to go. */
export function sendLive(edits: Edit[], opts: { restore?: boolean; after?: () => void } = {}) {
  pending = { edits, restore: opts.restore ?? false, after: opts.after };
  if (!running) running = pump();
}

/** Resolves once every live change sent so far has reached the backend. */
export async function settled() {
  while (running) await running;
}

/** Commits any auto-commit change still waiting for its pause, so it stays a step of its own. */
export async function flushAutoCommit() {
  if (autoTimer === undefined) return;
  clearTimeout(autoTimer);
  autoTimer = undefined;
  await settled();
  await store().commitLive();
}

/** Starts a gesture: earlier auto-commit changes become their own step first. */
export function beginGesture(): Promise<void> {
  return flushAutoCommit();
}

/** Ends a gesture: waits for its last change, then makes it one undo step. */
export async function endGesture() {
  await settled();
  await store().commitLive();
}

/** A change that becomes an undo step after a 0.8 s pause (Editroom's `live(autoCommit: true)`). */
export function sendAutoCommit(edits: Edit[]) {
  sendLive(edits);
  if (autoTimer !== undefined) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = undefined;
    void endGesture();
  }, 800);
}

/** One undoable step made of several edits (e.g. Reset Playback: speed, ramp and volume). */
export async function applyAsOneStep(edits: Edit[]) {
  await beginGesture();
  sendLive(edits);
  await endGesture();
}

/** The three callbacks a continuous control calls: when it's grabbed, as it moves, when it's let go. */
export interface Gesture<T> {
  begin: () => void;
  change: (v: T) => void;
  end: () => void;
}

/** What a gesture does; read afresh at every call, so it can follow the latest render. */
export interface GestureSpec<T, O> {
  /** What the edits are computed from: taken when the gesture begins (usually the selected clips). */
  capture: () => O;
  /** The edits for a value, from the captured state (absolute, so nothing drifts). */
  make: (v: T, origin: O) => Edit[];
  /** Put the project back to the gesture's start before each change (for retiming edits). */
  restore?: boolean;
  /** Runs once a change has reached the backend (e.g. move the playhead to a dragged dot). */
  after?: (v: T, origin: O) => void;
  onBegin?: () => void;
  onEnd?: () => void;
}

export function gesture<T, O>(spec: () => GestureSpec<T, O>): Gesture<T> {
  let origin: { value: O } | undefined;
  let started: Promise<void> | undefined;
  return {
    begin: () => {
      origin = { value: spec().capture() };
      started = beginGesture();
      spec().onBegin?.();
    },
    change: (v) => {
      const sp = spec();
      // A change without a begin (shouldn't happen) still works, as its own step.
      const o = origin ? origin.value : sp.capture();
      const edits = sp.make(v, o);
      const after = sp.after;
      const go = () => sendLive(edits, { restore: sp.restore, after: after ? () => after(v, o) : undefined });
      if (started) void started.then(go); else go();
    },
    end: () => {
      const s = started;
      origin = undefined;
      started = undefined;
      void (async () => {
        await s;
        await endGesture();
        spec().onEnd?.();
      })();
    },
  };
}
