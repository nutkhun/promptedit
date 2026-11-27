// Playback sound and the master clock (docs/spec/02-engine.md §8.2, §10.6). Web Audio plays the
// mix in short pieces scheduled ahead of time; each piece is rendered by `renderClip` (gain,
// fades and ducking baked per sample) from the streamed PCM, then routed through a per-track gain
// node so mute/solo/track level act at once. The picture follows the time being *heard*.

import type { Clip, Project } from "../../model";
import { asset as assetOf, clipEnd } from "../../timing";
import { clipSound, clipVariant, renderClip, trackMixes, type ClipSound, type TrackMix } from "./mix";
import { PcmStore, RATE } from "./pcm";
import type { Waveforms } from "./waveform";

/** Timeline seconds per scheduled piece. */
const PIECE = 0.25;
/** How far ahead pieces are scheduled. */
const AHEAD = 0.6;
/** Audio start delay after play (Editroom: now + 0.06 s + output latency). */
const START_DELAY = 0.06;
/** Scrub snippet (§10.6): 80 ms, eased in over 96 and out over 160 samples at 32 kHz. */
const SCRUB_SECONDS = 0.08;
const SCRUB_IN = Math.round((96 / 32000) * RATE);
const SCRUB_OUT = Math.round((160 / 32000) * RATE);

export class AudioOut {
  private ctx?: AudioContext;
  private out?: GainNode;
  private trackNodes = new Map<string, GainNode>();
  private live = new Set<AudioBufferSourceNode>();
  private done = new Set<string>();
  private sounds = new Map<string, Promise<ClipSound | undefined>>();
  private soundsReady = new Map<string, ClipSound | undefined>();
  private mixes?: { project: Project; ready: number; value: TrackMix[] };
  private playing = false;
  private from = 0;
  private ctxStart = 0;
  private perfStart = 0;
  private timer?: ReturnType<typeof setInterval>;
  private fingerprint = "";
  private scrubSource?: AudioBufferSourceNode;
  private scrubToken = 0;
  private waveReady = 0;

  constructor(private pcm: PcmStore, private waveforms: Waveforms, private project: () => Project) {}

  /** Lets the ducking spans be recomputed once more waveforms have arrived. */
  waveformsChanged() {
    this.waveReady++;
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
      this.out = this.ctx.createGain();
      this.out.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private latency(): number {
    const c = this.ctx!;
    return Math.min(1, (c.outputLatency || 0) + (c.baseLatency || 0));
  }

  /** Whether the audio clock is running (a suspended context, e.g. no user gesture yet, isn't). */
  private audioClock(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  /** The timeline time being heard now (or shown, if sound can't run). */
  now(): number {
    if (!this.playing) return this.from;
    if (this.audioClock()) return this.from + Math.max(0, this.ctx!.currentTime - this.latency() - this.ctxStart);
    return this.from + Math.max(0, (performance.now() - this.perfStart) / 1000);
  }

  isPlaying() {
    return this.playing;
  }

  private soundKey(c: Clip) {
    // The whole clip: a ClipSound carries the clip's gain and fades too.
    return JSON.stringify(c);
  }

  /** The clip resolved against its PCM, starting that work if needed. */
  private soundAsync(c: Clip): Promise<ClipSound | undefined> {
    const key = this.soundKey(c);
    let job = this.sounds.get(key);
    if (!job) {
      const p = this.project();
      const a = assetOf(p, c.assetID);
      const variant = a && clipVariant(c, a);
      job = (async () => {
        if (!a || !variant) return undefined;
        const info = await this.pcm.info(variant);
        if (!info) return undefined;
        // The speed-1 file's length (a reversed clip lines up with it).
        const base = variant.speed === 1 ? info.duration : (await this.pcm.info({ ...variant, speed: 1 }))?.duration ?? info.duration * variant.speed;
        return clipSound(c, a, info, base);
      })().catch(() => undefined).then((s) => { this.soundsReady.set(key, s); return s; });
      if (this.sounds.size > 512) { this.sounds.clear(); this.soundsReady.clear(); }
      this.sounds.set(key, job);
    }
    return job;
  }

  private sound(c: Clip): ClipSound | undefined {
    const key = this.soundKey(c);
    if (this.soundsReady.has(key)) return this.soundsReady.get(key);
    void this.soundAsync(c);
    return undefined;
  }

  private trackMixes(p: Project): TrackMix[] {
    if (this.mixes && this.mixes.project === p && this.mixes.ready === this.waveReady) return this.mixes.value;
    const value = trackMixes(p, (c) => this.waveforms.forClip(assetOf(p, c.assetID), c));
    this.mixes = { project: p, ready: this.waveReady, value };
    return value;
  }

  /** Track gain nodes follow mute/solo/level at once. */
  private applyTrackGains(p: Project) {
    const ctx = this.context();
    for (const m of this.trackMixes(p)) {
      let node = this.trackNodes.get(m.track.id);
      if (!node) {
        node = ctx.createGain();
        node.connect(this.out!);
        this.trackNodes.set(m.track.id, node);
        node.gain.value = m.gain;
      } else {
        node.gain.setTargetAtTime(m.gain, ctx.currentTime, 0.004);
      }
    }
  }

  /** Audio-relevant state apart from track gain/mute/solo, which act without rescheduling. */
  private audioFingerprint(p: Project): string {
    const clips = p.clips.filter((c) => c.kind === "audio");
    const tracks = trackMixes(p, () => undefined).map((m) => [m.track.id, m.track.duckUnder ?? "", m.track.duckDB, !!m.duck]);
    return JSON.stringify([clips, tracks]);
  }

  private clipsNear(p: Project, a: number, b: number): Clip[] {
    return p.clips.filter((c) => c.kind === "audio" && c.start < b && clipEnd(c) > a);
  }

  /** Starts sound (and the clock) at timeline time `from`, after the first pieces are ready. */
  async start(from: number) {
    this.stop();
    const ctx = this.context();
    if (ctx.state !== "running") await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 200))]);
    const p = this.project();
    this.from = from;
    this.fingerprint = this.audioFingerprint(p);
    // Have the first second's sound loaded before the clock starts, so playback starts in sync.
    const first = this.clipsNear(p, from, from + 1);
    const prep = Promise.all(first.map(async (c) => {
      for (const a of p.assets.filter((x) => x.id === c.assetID)) void this.waveforms.get(a);
      const s = await this.soundAsync(c);
      if (!s) return;
      const f0 = Math.floor(s.frameAt(Math.max(from, c.start)));
      await this.pcm.read(s.info, Math.max(0, f0 - RATE), RATE * 2);
    }));
    await Promise.race([prep, new Promise((r) => setTimeout(r, 1500))]);
    this.playing = true;
    this.applyTrackGains(p);
    this.ctxStart = ctx.currentTime + START_DELAY;
    this.perfStart = performance.now() + (START_DELAY + this.latency()) * 1000;
    this.tick();
    this.timer = setInterval(() => this.tick(), 40);
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.live) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.live.clear();
    this.done.clear();
  }

  /** The project changed while playing: gains act at once; other audio changes reschedule from now. */
  projectChanged() {
    if (!this.playing) return;
    const p = this.project();
    this.applyTrackGains(p);
    const fp = this.audioFingerprint(p);
    if (fp === this.fingerprint) return;
    this.fingerprint = fp;
    for (const s of this.live) { try { s.stop(); } catch { /* */ } s.disconnect(); }
    this.live.clear();
    this.done.clear();
    this.tick();
  }

  private ctxTimeOf(t: number) {
    return this.ctxStart + (t - this.from);
  }

  private tick() {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const p = this.project();
    const mixes = this.trackMixes(p);
    // Audio position of what's being queued: the context's own time (not the heard time).
    const queued = this.from + (ctx.currentTime - this.ctxStart);
    const horizon = queued + AHEAD;
    const firstPiece = Math.floor(Math.max(this.from, queued) / PIECE);
    for (const m of mixes) {
      const node = this.trackNodes.get(m.track.id);
      if (!node) { this.applyTrackGains(p); continue; }
      for (const c of p.clips) {
        if (c.trackID !== m.track.id || c.kind !== "audio") continue;
        if (!(clipEnd(c) > queued && c.start < horizon)) continue;
        const s = this.sound(c);
        if (!s) continue;
        for (let k = firstPiece; k * PIECE < horizon; k++) {
          const a = Math.max(k * PIECE, c.start, this.from), b = Math.min((k + 1) * PIECE, clipEnd(c));
          if (b <= a) continue;
          const key = `${c.id}:${k}`;
          if (this.done.has(key)) continue;
          const frames = Math.round((b - a) * RATE);
          if (frames <= 0) continue;
          const data = renderClip(s, a, frames, m.duck, (start, count) => this.pcm.readNow(s.info, start, count));
          if (!data) continue; // not loaded yet: next tick
          this.done.add(key);
          const when = this.ctxTimeOf(a);
          const offset = Math.max(0, ctx.currentTime + 0.005 - when);
          if (offset >= (b - a)) continue; // too late for this piece
          const buf = ctx.createBuffer(2, frames, RATE);
          const L = buf.getChannelData(0), R = buf.getChannelData(1);
          for (let i = 0; i < frames; i++) { L[i] = data[i * 2]; R[i] = data[i * 2 + 1]; }
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(node);
          src.onended = () => { this.live.delete(src); src.disconnect(); };
          src.start(Math.max(when, ctx.currentTime), offset);
          this.live.add(src);
        }
      }
    }
    if (this.done.size > 4000) {
      // Forget pieces well behind the playhead.
      const behind = Math.floor(queued / PIECE) - 8;
      for (const k of this.done) if (Number(k.split(":")[1]) < behind) this.done.delete(k);
    }
  }

  /** A short burst of the mix at t (audio scrubbing). Latest wins. */
  scrub(t: number) {
    const token = ++this.scrubToken;
    const ctx = this.context();
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    const p = this.project();
    const frames = Math.round(SCRUB_SECONDS * RATE);
    const attempt = (deadline: number) => {
      if (token !== this.scrubToken) return;
      const mix = new Float32Array(frames * 2);
      let missing = false;
      for (const m of this.trackMixes(p)) {
        if (m.gain === 0) continue;
        for (const c of this.clipsNear(p, t, t + SCRUB_SECONDS)) {
          if (c.trackID !== m.track.id) continue;
          const s = this.sound(c);
          if (!s) { missing = true; continue; }
          const d = renderClip(s, t, frames, m.duck, (start, count) => this.pcm.readNow(s.info, start, count));
          if (!d) { missing = true; continue; }
          for (let i = 0; i < d.length; i++) mix[i] += d[i] * m.gain;
        }
      }
      if (missing && performance.now() < deadline) { setTimeout(() => attempt(deadline), 15); return; }
      const buf = ctx.createBuffer(2, frames, RATE);
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) {
        let g = 1;
        if (i < SCRUB_IN) g = i / SCRUB_IN;
        const remain = frames - i;
        if (remain < SCRUB_OUT) g *= remain / SCRUB_OUT;
        L[i] = mix[i * 2] * g;
        R[i] = mix[i * 2 + 1] * g;
      }
      this.scrubSource?.stop();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.out!);
      src.start();
      this.scrubSource = src;
    };
    attempt(performance.now() + 150);
  }
}
