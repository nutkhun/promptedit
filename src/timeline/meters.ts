// Track level meters, read from the loudness envelopes at the playhead the way Editroom reads
// its waveform peaks (Engine/Meters.swift), so they need no hook into the audio graph. dBFS.

import { create } from "zustand";
import type { Id, Project } from "../model";
import { store, useStore } from "../store";
import { dbToLinear, fadeGain, isAudible, sourceTime } from "../timing";
import { WAVE_RATE, waveform } from "./media";

export const METER_FLOOR = -60;

export interface MeterReading { level: number; peak: number; clipped: boolean }
export const EMPTY_READING: MeterReading = { level: METER_FLOOR, peak: METER_FLOOR, clipped: false };

export const useMeters = create<{ tracks: Record<Id, MeterReading> }>(() => ({ tracks: {} }));

const RELEASE = 4; // dB a level may fall per frame
const PEAK_HOLD = 0.5; // s
const PEAK_FALL = 2; // dB per frame after the hold
const holdUntil = new Map<Id, number>();

const toDB = (linear: number) => (linear > 0 ? Math.max(METER_FLOOR, 20 * Math.log10(linear)) : METER_FLOOR);

/** The loudest envelope value over the last ~30 ms of source under the playhead, with gains and fades. */
function trackLevel(p: Project, trackID: Id, t: number): number {
  let level = 0;
  for (const c of p.clips) {
    if (c.trackID !== trackID || c.kind !== "audio" || !(t >= c.start && t < c.start + c.duration) || !c.assetID) continue;
    const env = waveform(c.assetID);
    if (!env?.length) continue;
    let src = sourceTime(c, t);
    if (c.reversed) src = env.length / WAVE_RATE - src;
    const hi = Math.min(env.length - 1, Math.floor(src * WAVE_RATE));
    const lo = Math.max(0, Math.floor((src - 0.03 * c.speed) * WAVE_RATE));
    let v = 0;
    for (let i = lo; i <= hi; i++) v = Math.max(v, env[i]);
    // The envelope is RMS; a sine's peak is √2 above it, which reads closer to Editroom's peak meters.
    level = Math.max(level, v * Math.SQRT2 * dbToLinear(c.gainDB) * fadeGain(c, t));
  }
  return level;
}

function advance(old: MeterReading, reading: number, key: Id, now: number): MeterReading {
  const r = { ...old };
  r.level = Math.max(reading, Math.max(METER_FLOOR, old.level - RELEASE));
  if (reading >= old.peak) {
    r.peak = reading;
    holdUntil.set(key, now + PEAK_HOLD);
  } else if (now > (holdUntil.get(key) ?? 0)) {
    r.peak = Math.max(METER_FLOOR, old.peak - PEAK_FALL);
  }
  r.clipped = reading >= -0.1;
  return r;
}

let frame: number | undefined;

function tick() {
  frame = undefined;
  const s = store();
  const prev = useMeters.getState().tracks;
  if (!s.playing) {
    // Nothing playing: every meter empties at once, peaks and clip lights included.
    if (Object.values(prev).some((r) => r.level > METER_FLOOR || r.peak > METER_FLOOR || r.clipped)) useMeters.setState({ tracks: {} });
    return;
  }
  const now = performance.now() / 1000;
  const next: Record<Id, MeterReading> = {};
  let changed = false;
  for (const track of s.project.audioTracks) {
    const lin = isAudible(s.project, track) ? trackLevel(s.project, track.id, s.playhead) * dbToLinear(track.gainDB) : 0;
    const old = prev[track.id] ?? EMPTY_READING;
    const r = advance(old, toDB(lin), track.id, now);
    next[track.id] = r;
    if (Math.abs(r.level - old.level) > 0.2 || Math.abs(r.peak - old.peak) > 0.2 || r.clipped !== old.clipped) changed = true;
  }
  if (changed) useMeters.setState({ tracks: next });
  frame = requestAnimationFrame(tick);
}

/** Runs the meters while playing (they stop themselves when playback stops). Returns an unsubscribe. */
export function startMeters(): () => void {
  const kick = () => {
    if (frame === undefined) frame = requestAnimationFrame(tick);
  };
  kick();
  let wasPlaying = store().playing;
  return useStore.subscribe((s) => {
    if (s.playing !== wasPlaying) {
      wasPlaying = s.playing;
      kick();
    }
  });
}
