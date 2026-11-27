// Continuous edits (fade and gain handles, the track gain pill, marker renames) are sent as live
// edits and committed once at the end. Pointer moves arrive faster than the backend answers, so
// only one request is in flight at a time and only the newest pending edit is sent next — the
// backend sees them in order and never falls behind the pointer.

import type { Edit } from "../model";
import { store } from "../store";

let inFlight: Promise<void> | undefined;
let pending: Edit | undefined;

function pump() {
  if (inFlight || !pending) return;
  const e = pending;
  pending = undefined;
  inFlight = store().edit(e, true).finally(() => {
    inFlight = undefined;
    pump();
  });
}

/** Queue a live edit; superseded edits that haven't been sent are dropped. */
export function sendLive(e: Edit) {
  pending = e;
  pump();
}

/** Wait until every queued live edit has reached the backend. */
export async function flushLive() {
  while (inFlight || pending) {
    pump();
    await inFlight;
  }
}

/** Wait for queued live edits, then commit them as one undo step. */
export async function commitLive() {
  await flushLive();
  await store().commitLive();
}
