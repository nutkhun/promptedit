// Track and output meters, read from the waveform peaks at the playhead (Editroom MeterState,
// docs/spec/02-engine.md §11.2): no tap on the audio graph, so the meters show the mix's levels
// (gains, fades, mute/solo; not ducking) exactly as the original does.

import type { Project } from "../../model";
import { clipEnd, dbToLinear, fadeGain, isAudible, sourceTime } from "../../timing";
import type { Clip } from "../../model";
import type { Waveform } from "./waveform";
import { speedAt } from "./mix";

export const METER_FLOOR = -60;

export interface MeterReading { level: number; peak: number; clipped: boolean }
export interface MeterLevels {
  tracks: Record<string, MeterReading>;
  master: MeterReading;
  left: MeterReading;
  right: MeterReading;
}

const empty = (): MeterReading => ({ level: METER_FLOOR, peak: METER_FLOOR, clipped: false });
const db = (linear: number) => (linear > 0 ? Math.max(METER_FLOOR, 20 * Math.log10(linear)) : METER_FLOOR);
const sum = (p: number) => (p > 0 ? 10 * Math.log10(p) : METER_FLOOR);

export class Meters {
  levels: MeterLevels = { tracks: {}, master: empty(), left: empty(), right: empty() };
  private holdUntil = new Map<string, number>();
  private last = 0;

  /** Once per display frame. `now` in seconds. */
  update(p: Project, t: number, playing: boolean, waveform: (c: Clip) => Waveform | undefined, now: number) {
    // Release rates are per 60 Hz frame in the original; scale by the real frame time.
    const frames = this.last > 0 ? Math.min(4, Math.max(0.25, (now - this.last) * 60)) : 1;
    this.last = now;
    const release = 4 * frames, peakFall = 2 * frames;
    const advance = (old: MeterReading, reading: number, key: string): MeterReading => {
      if (!playing) return empty();
      const r = { ...old };
      r.level = Math.max(reading, Math.max(METER_FLOOR, old.level - release));
      if (reading >= old.peak) {
        r.peak = reading;
        this.holdUntil.set(key, now + 0.5);
      } else if (now > (this.holdUntil.get(key) ?? 0)) {
        r.peak = Math.max(METER_FLOOR, old.peak - peakFall);
      }
      r.clipped = reading >= -0.1;
      return r;
    };
    const tracks: Record<string, MeterReading> = {};
    let power = 0, powerL = 0, powerR = 0;
    for (const track of p.audioTracks) {
      let level = 0, levelL = 0, levelR = 0;
      if (playing && isAudible(p, track)) {
        for (const c of p.clips) {
          if (c.trackID !== track.id || c.kind !== "audio" || !(t >= c.start && t < clipEnd(c))) continue;
          const wf = waveform(c);
          if (!wf || wf.peaks.length === 0) continue;
          // The loudest peak over the last ~30 ms of source.
          const src = sourceTime(c, t);
          const hi = Math.min(wf.peaks.length - 1, Math.trunc(src * wf.peaksPerSecond));
          const lo = Math.max(0, Math.trunc((src - 0.03 * speedAt(c, t)) * wf.peaksPerSecond));
          if (hi < lo) continue;
          let peak = 0, pl = 0, pr = 0;
          for (let i = lo; i <= hi; i++) {
            peak = Math.max(peak, wf.peaks[i]);
            if (i < wf.left.length) pl = Math.max(pl, wf.left[i]);
            if (i < wf.right.length) pr = Math.max(pr, wf.right[i]);
          }
          const g = dbToLinear(c.gainDB) * fadeGain(c, t);
          level = Math.max(level, peak * g);
          levelL = Math.max(levelL, pl * g);
          levelR = Math.max(levelR, pr * g);
        }
        const tg = dbToLinear(track.gainDB);
        level *= tg; levelL *= tg; levelR *= tg;
      }
      power += level * level;
      powerL += levelL * levelL;
      powerR += levelR * levelR;
      tracks[track.id] = advance(this.levels.tracks[track.id] ?? empty(), db(level), track.id);
    }
    this.levels = {
      tracks,
      master: advance(this.levels.master, sum(power), "master"),
      left: advance(this.levels.left, sum(powerL), "L"),
      right: advance(this.levels.right, sum(powerR), "R"),
    };
  }
}
