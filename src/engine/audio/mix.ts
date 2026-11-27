// The audio mix, shared by playback, scrubbing and export so they sound the same
// (docs/spec/02-engine.md §10): per clip gain × fade curve (evaluated per sample) × ducking,
// summed per track and scaled by the track's gain. No pan, no limiter, no master gain.

import type { Clip, MediaAsset, Project, Track } from "../../model";
import { clipEnd, dbToLinear, fadeGain, isAudible, playsSource, rampSpeed, sourceTime } from "../../timing";
import { mediaPath } from "../../api";
import type { PcmInfo } from "../backend";
import type { PcmVariant } from "./pcm";
import type { Waveform } from "./waveform";
import { RATE } from "./pcm";

export interface Span { start: number; end: number }

/** Where a track has sound, for ducking another under it (`AudioLevels.activity`, §10.3). */
export function activity(p: Project, trackID: string, waveform: (c: Clip) => Waveform | undefined): Span[] {
  const spans: Span[] = [];
  const step = 0.05;
  for (const c of p.clips) {
    if (c.trackID !== trackID || c.kind !== "audio") continue;
    const wf = waveform(c);
    if (!wf || wf.peaks.length === 0) continue;
    let open: number | undefined;
    // Same accumulation as Swift (`t += step`), so span edges land on the same float values.
    for (let t = c.start; t < clipEnd(c); t += step) {
      const src = sourceTime(c, t);
      const lo = Math.max(0, Math.trunc(src * wf.peaksPerSecond));
      const hi = Math.min(wf.peaks.length - 1, Math.trunc(sourceTime(c, t + step) * wf.peaksPerSecond));
      let peak = 0;
      for (let i = lo; i <= hi; i++) peak = Math.max(peak, wf.peaks[i]);
      const active = peak * dbToLinear(c.gainDB) * fadeGain(c, t) > 0.03;
      if (active && open === undefined) open = t;
      if (!active && open !== undefined) { spans.push({ start: open, end: t }); open = undefined; }
    }
    if (open !== undefined) spans.push({ start: open, end: clipEnd(c) });
  }
  // Short pauses between words don't let the music back up.
  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < 0.35) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** Ducking gain at t: down to `low` during activity, easing over 0.15 s before and 0.5 s after. */
export function duckGain(t: number, spans: Span[], low: number): number {
  const attack = 0.15, release = 0.5;
  let g = 1;
  for (const s of spans) {
    if (t < s.start - attack || t > s.end + release) continue;
    const f = t < s.start ? (s.start - t) / attack : t > s.end ? (t - s.end) / release : 0;
    g = Math.min(g, low + (1 - low) * f);
  }
  return g;
}

/** The clip's lowest and highest speed (ramps included). */
export function speedRange(c: Clip): [number, number] {
  if (!c.ramp || !playsSource(c)) return [c.speed, c.speed];
  const v = [c.speed, c.ramp.startSpeed, c.ramp.endSpeed];
  return [Math.min(...v), Math.max(...v)];
}

/** Which PCM file a clip plays: forward or reversed, stretched to its speed (pitch kept) unless ramped. */
export function clipVariant(c: Clip, a: MediaAsset): PcmVariant | undefined {
  if (c.kind !== "audio" || !playsSource(c)) return undefined;
  const [lo, hi] = speedRange(c);
  // Editroom skips clips outside 1/32…32× (they're silent).
  if (!(hi <= 32 && lo >= 1 / 32)) return undefined;
  const ramped = !!c.ramp;
  return { path: mediaPath(a), reversed: c.reversed === true, speed: ramped ? 1 : c.speed };
}

/** A clip resolved against its PCM: maps timeline time to a (fractional) frame of `info`. */
export interface ClipSound {
  clip: Clip;
  info: PcmInfo;
  /** Frame of `info` heard at timeline time t. */
  frameAt(t: number): number;
  /** True when frames advance one per output sample (no resampling). */
  linear: boolean;
}

/**
 * `info` is the variant `clipVariant` named; `baseDuration` is the speed-1 file's length (for a
 * reversed clip, where source time s is file time L − s: the reversed sound lines up with the
 * asset's length L, spec §7).
 */
export function clipSound(c: Clip, a: MediaAsset, info: PcmInfo, baseDuration: number): ClipSound {
  const shift = c.reversed === true ? baseDuration - a.duration : 0;
  if (!c.ramp) {
    const v = c.speed;
    return { clip: c, info, linear: true, frameAt: (t) => ((sourceTime(c, t) + shift) / v) * RATE };
  }
  // Ramps play the speed-1 file resampled (varispeed: pitch follows speed — see engine notes).
  return { clip: c, info, linear: false, frameAt: (t) => (sourceTime(c, t) + shift) * RATE };
}

export interface TrackMix {
  track: Track;
  /** 0 for inaudible tracks (left out of exports entirely). */
  gain: number;
  duck?: { spans: Span[]; low: number };
}

/** Per audio track: gain (mute/solo applied) and ducking (§10.2–10.3). */
export function trackMixes(p: Project, waveform: (c: Clip) => Waveform | undefined): TrackMix[] {
  return p.audioTracks.map((track) => {
    const audible = isAudible(p, track);
    const m: TrackMix = { track, gain: audible ? dbToLinear(track.gainDB) : 0 };
    if (audible && track.duckUnder) {
      const voice = p.audioTracks.find((t) => t.id === track.duckUnder);
      if (voice && isAudible(p, voice)) m.duck = { spans: activity(p, voice.id, waveform), low: dbToLinear(track.duckDB) };
    }
    return m;
  });
}

/**
 * Renders a clip's contribution to [t0, t0 + frames/RATE) as interleaved stereo, gain/fades/ducking
 * applied per sample (track gain not included). `read(start, count)` returns interleaved frames of
 * the clip's PCM (zeros outside it), or undefined if they aren't loaded.
 */
export function renderClip(
  s: ClipSound, t0: number, frames: number, duck: TrackMix["duck"],
  read: (start: number, count: number) => Float32Array | undefined,
): Float32Array | undefined {
  const c = s.clip;
  const gain = dbToLinear(c.gainDB);
  const out = new Float32Array(frames * 2);
  if (gain === 0) return out;
  const start = c.start, end = clipEnd(c);
  // Only the part inside the clip.
  const i0 = Math.max(0, Math.ceil((start - t0) * RATE - 1e-9));
  const i1 = Math.min(frames, Math.ceil((end - t0) * RATE - 1e-9));
  if (i1 <= i0) return out;
  const level = (i: number) => {
    const t = t0 + i / RATE;
    let g = gain * fadeGain(c, t);
    if (duck) g *= duckGain(t, duck.spans, duck.low);
    return g;
  };
  if (s.linear) {
    const f0 = Math.round(s.frameAt(t0 + i0 / RATE));
    const data = read(f0, i1 - i0);
    if (!data) return undefined;
    for (let i = i0; i < i1; i++) {
      const g = level(i), k = (i - i0) * 2;
      out[i * 2] = data[k] * g;
      out[i * 2 + 1] = data[k + 1] * g;
    }
    return out;
  }
  // Varispeed: positions every 10 ms, linear in between; linear interpolation between frames.
  const grid = Math.round(RATE / 100);
  const pos = new Float64Array(i1 - i0);
  let lo = Infinity, hi = -Infinity;
  for (let i = i0; i < i1; i += grid) {
    const j = Math.min(i1 - 1, i + grid);
    const a = s.frameAt(t0 + i / RATE), b = s.frameAt(t0 + j / RATE);
    for (let k = i; k <= j && k < i1; k++) pos[k - i0] = j > i ? a + ((b - a) * (k - i)) / (j - i) : a;
  }
  for (const v of pos) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const base = Math.floor(lo);
  const data = read(base, Math.max(1, Math.ceil(hi) - base + 2));
  if (!data) return undefined;
  const n = data.length / 2;
  for (let i = i0; i < i1; i++) {
    const p = pos[i - i0] - base, k = Math.floor(p), f = p - k;
    if (k < 0 || k + 1 >= n) continue;
    const g = level(i);
    out[i * 2] = (data[k * 2] * (1 - f) + data[k * 2 + 2] * f) * g;
    out[i * 2 + 1] = (data[k * 2 + 1] * (1 - f) + data[k * 2 + 3] * f) * g;
  }
  return out;
}

/** Instantaneous speed of a ramped clip at timeline t (for meters' look-back window). */
export function speedAt(c: Clip, t: number): number {
  if (!c.ramp || !playsSource(c)) return c.speed;
  return rampSpeed(c.ramp, sourceTime(c, t), c.speed);
}
