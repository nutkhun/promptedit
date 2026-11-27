// Transport actions shared by the viewer's buttons, the keyboard and the menus (docs/spec/04-ui.md
// §1.4, §3.4): play/pause (from the skimmer or the playhead, restarting at the end, looping the in/out
// range), frame steps, edit jumps, seeking, and the full-screen viewer.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "../../api";
import { engine } from "../../engine";
import { store } from "../../store";
import { editPoints, playRange, projectDuration } from "../../timing";

/** Where playback repeats: the in/out range with Loop on, else the whole timeline. */
function loopSpan(): [number, number] {
  const s = store();
  const dur = projectDuration(s.project);
  return (s.loop && playRange(s.project)) || [0, dur];
}

export function play() {
  const s = store();
  let from = s.playhead;
  // Space while skimming plays from the skimmer (setting `playFromSkimmer`) or from the playhead.
  if (s.skim && !("asset" in s.skim) && s.playFromSkimmer) from = s.skim.time;
  const dur = projectDuration(s.project);
  if (dur <= 0) return;
  const fps = s.project.fps || 30;
  const [a, b] = loopSpan();
  const ranged = s.loop && playRange(s.project) !== undefined;
  // From the end, play starts over; with a looped range, from outside it, at its start.
  if (from >= dur - 1 / fps || (ranged && (from < a || from >= b - 1 / fps))) from = a;
  s.set({ skim: undefined });
  s.seek(from);
  s.set({ playing: true });
  engine.play(store().playhead);
}

export function pause() {
  if (!store().playing) return;
  engine.pause();
  store().set({ playing: false });
  engine.showFrame(store().playhead);
}

export const togglePlay = () => (store().playing ? pause() : play());

/** Moves the playhead; playback carries on from there. */
export function seekTo(t: number) {
  const s = store();
  const playing = s.playing;
  if (playing) engine.pause();
  s.seek(Math.max(0, t));
  if (playing) engine.play(store().playhead);
  else engine.showFrame(store().playhead);
}

export function step(frames: number) {
  const s = store();
  if (s.playing) pause();
  seekTo(store().playhead + frames / (s.project.fps || 30));
}

/** Previous/Next Edit: clip starts and ends, markers and 0 (±half a frame). */
export function jumpToEdit(forward: boolean) {
  const s = store();
  const points = editPoints(s.project);
  const eps = 0.5 / (s.project.fps || 30);
  const t = forward ? points.find((x) => x > s.playhead + eps) : [...points].reverse().find((x) => x < s.playhead - eps);
  if (t !== undefined) seekTo(t);
}

/** Whether the window was already in OS full screen when the viewer went full screen (then it stays). */
let wasFullscreen = false;

/**
 * F: the viewer alone, filling the screen. Not a separate OS full-screen space: the window is made
 * full-screen and only the viewer and transport show. Esc or F restores the window as it was.
 */
export async function toggleViewerFullScreen() {
  const s = store();
  const on = !s.viewerOnly;
  if (inTauri) {
    try {
      const w = getCurrentWindow();
      if (on) {
        wasFullscreen = await w.isFullscreen();
        if (!wasFullscreen) await w.setFullscreen(true);
      } else if (!wasFullscreen) {
        await w.setFullscreen(false);
      }
    } catch { /* window API unavailable: the in-window view still switches */ }
  } else if (on && document.fullscreenEnabled && !document.fullscreenElement) {
    void document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (!on && document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => {});
  }
  s.set({ viewerOnly: on });
}
