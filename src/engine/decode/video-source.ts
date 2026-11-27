// WebCodecs decoding of one file's picture, with keyframe seek + decode-forward and a small
// frame cache. A file has a few decoder "lanes", so two clips of the same file on screen at once
// (a dissolve between two parts of one take, picture-in-picture) don't fight over one decoder.
//
// Modes:
// - "exact": the requested frame, waiting for it (paused viewer). When the decoder holds the frame
//   back for reordering, it is flushed out (the next decode then restarts at a keyframe).
// - "play": never waits; keeps decoding a few frames ahead and hands back the best frame it has.
// - "sequential": waits for the exact frame like "exact" but decodes ahead like "play", never
//   flushing mid-stream (export, which asks for every frame in order).

import { pickFrame, type VideoPick } from "../layers";
import { openVideoTrack, SampleReader, type VideoTrack } from "./demux";

export type DecodeMode = "exact" | "play" | "sequential";

/** Frames decoded ahead of the playhead while playing. */
const PLAY_AHEAD = 8;
/** Frames kept behind the target (stepping back a frame stays instant). */
const KEEP_BEHIND = 2;
const MAX_FRAMES = PLAY_AHEAD + KEEP_BEHIND + 3;
const MAX_LANES = 4;
/** In exact mode, how long to wait for a decoded frame before flushing it out. */
const OUTPUT_WAIT_MS = 40;

export class UnsupportedCodecError extends Error {}

class Lane {
  private decoder?: VideoDecoder;
  private nextFeed = 0;
  private needKey = true;
  private target = 0;
  private mode: DecodeMode = "exact";
  private pumping = false;
  private epoch = 0;
  private listeners = new Set<() => void>();
  private failed = false;
  /** Presentation index of the last frame output since the last restart (output is in order). */
  private lastOut = -1;
  /**
   * How many samples the decoder holds beyond what reordering needs before it outputs a frame
   * (frame-threaded software decoders hold several). Learned, so requests feed that far at once.
   */
  private lag = 0;
  readonly frames = new Map<number, VideoFrame>();
  lastUse = 0;

  constructor(private src: VideoSource) {}

  /** Whether frame `p` (presentation index) is here or can be reached without a restart. */
  canContinue(p: number): boolean {
    if (this.frames.has(p)) return true;
    if (this.needKey || !this.decoder || this.decoder.state !== "configured") return false;
    const t = this.src.track;
    const d = t.byPts[p];
    const key = this.src.keyAtOrBefore(d);
    // Not decoded yet (or still inside the decoder), and no keyframe between here and there.
    return key <= this.nextFeed && this.lastOut < p;
  }

  /** Starts working toward frame `p`. In exact mode resolves when it's decoded (or can't be). */
  async want(p: number, mode: DecodeMode): Promise<VideoFrame | undefined> {
    this.target = p;
    this.mode = mode;
    this.lastUse = performance.now();
    if (!this.canContinue(p)) this.restart(this.src.keyAtOrBefore(this.src.track.byPts[p]));
    this.evict();
    void this.pump();
    if (mode === "play") return undefined;
    while (!this.frames.has(p)) {
      if (this.target !== p) return this.frames.get(p);
      if (!this.pumping) {
        // The pump stopped without the frame: it couldn't be decoded.
        if (!this.frames.has(p)) return undefined;
        break;
      }
      await this.event();
    }
    return this.frames.get(p);
  }

  /** The decoded frame nearest `p` at or before it (else the nearest after). */
  best(p: number): VideoFrame | undefined {
    let below = -1, above = Infinity;
    for (const k of this.frames.keys()) {
      if (k <= p && k > below) below = k;
      if (k > p && k < above) above = k;
    }
    return this.frames.get(below >= 0 ? below : above);
  }

  /** Releases frames and the decoder (idle for a while). */
  release() {
    this.epoch++;
    for (const f of this.frames.values()) f.close();
    this.frames.clear();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
    this.needKey = true;
  }

  private event(timeoutMs?: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.listeners.delete(done); clearTimeout(timer); resolve(); };
      const timer = timeoutMs != null ? setTimeout(done, timeoutMs) : undefined;
      this.listeners.add(done);
    });
  }

  private notify() {
    for (const l of [...this.listeners]) l();
  }

  private makeDecoder(): VideoDecoder {
    const d = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: () => {
        // A decode error (corrupt sample, lost GPU): start over at the next request.
        this.failed = true;
        this.decoder = undefined;
        this.needKey = true;
        this.notify();
      },
    });
    d.configure(this.src.config);
    d.addEventListener("dequeue", () => this.notify());
    return d;
  }

  private restart(fromDecodeIndex: number) {
    this.epoch++;
    if (this.decoder && this.decoder.state === "configured") {
      this.decoder.reset();
      this.decoder.configure(this.src.config);
    } else {
      this.decoder = this.makeDecoder();
    }
    this.failed = false;
    this.lastOut = -1;
    this.nextFeed = fromDecodeIndex;
    this.needKey = false;
  }

  private keep(p: number): boolean {
    const t = this.target;
    return p >= t - KEEP_BEHIND && p <= t + (this.mode === "exact" ? KEEP_BEHIND + 1 : PLAY_AHEAD);
  }

  /** The newest decoded frame at or before the target: what playback shows while decoding catches up. */
  private held(): number {
    let h = -1;
    for (const k of this.frames.keys()) if (k <= this.target && k > h) h = k;
    return h;
  }

  private onFrame(frame: VideoFrame) {
    const p = this.src.presIndexOf(frame.timestamp);
    if (p !== undefined) {
      this.lastOut = Math.max(this.lastOut, p);
      const t = this.src.track;
      this.lag = Math.min(16, Math.max(this.lag, this.nextFeed - 1 - t.byPts[p] - t.reorder));
    }
    // Behind the target while playing, a newer frame still beats the one on screen.
    const catchingUp = p !== undefined && this.mode !== "exact" && p <= this.target && p > this.held();
    if (p === undefined || (!this.keep(p) && !catchingUp)) {
      frame.close();
    } else {
      this.frames.get(p)?.close();
      this.frames.set(p, frame);
      this.evict();
    }
    this.notify();
  }

  private evict() {
    // The frame on screen stays until a newer one replaces it (never a blank picture while playing).
    const hold = this.mode === "exact" ? -1 : this.held();
    for (const [k, f] of this.frames) {
      if (k !== hold && !this.keep(k)) { f.close(); this.frames.delete(k); }
    }
    if (this.frames.size <= MAX_FRAMES) return;
    const far = [...this.frames.keys()].filter((k) => k !== hold).sort((a, b) => Math.abs(b - this.target) - Math.abs(a - this.target));
    for (const k of far.slice(0, this.frames.size - MAX_FRAMES)) { this.frames.get(k)!.close(); this.frames.delete(k); }
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const t = this.src.track;
    const n = t.samples.length;
    try {
      for (;;) {
        const decoder = this.decoder;
        if (!decoder || decoder.state !== "configured" || this.failed) break;
        const epoch = this.epoch;
        const p = this.target;
        const ahead = this.mode !== "exact";
        const last = ahead ? Math.min(n - 1, p + PLAY_AHEAD) : p;
        if (this.frames.has(last) || (this.mode === "exact" && this.frames.has(p))) break;
        // Decode index that frames p…last need, plus room for reordering decoders.
        let need = 0;
        for (let q = p; q <= last; q++) need = Math.max(need, t.byPts[q]);
        const limit = Math.min(n - 1, need + t.reorder + this.lag + (ahead ? 2 : 0));
        if (this.nextFeed <= limit) {
          if (decoder.decodeQueueSize >= 4) { await this.event(); continue; }
          const i = this.nextFeed++;
          const s = t.samples[i];
          const data = await this.src.reader.get(i);
          if (epoch !== this.epoch || decoder.state !== "configured") continue;
          decoder.decode(new EncodedVideoChunk({
            type: s.key ? "key" : "delta", timestamp: this.src.timestampOf(i), duration: Math.round(t.frameDuration * 1e6), data,
          }));
          continue;
        }
        if (decoder.decodeQueueSize > 0) { await this.event(); continue; }
        // Everything it needs is in; give the output a moment, then force it out.
        await this.event(OUTPUT_WAIT_MS);
        if (epoch !== this.epoch || this.frames.has(ahead ? last : p)) continue;
        if (ahead && this.nextFeed < n && this.nextFeed - t.byPts[p] < 64) {
          // A decoder with more delay than the stream's reordering needs: feed it further.
          this.nextFeed = Math.max(this.nextFeed, limit + 1);
          if (this.nextFeed < n) {
            const i = this.nextFeed++;
            const s = t.samples[i];
            const data = await this.src.reader.get(i);
            if (epoch === this.epoch && decoder.state === "configured") {
              decoder.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: this.src.timestampOf(i), data }));
            }
            continue;
          }
        }
        try { await decoder.flush(); } catch { /* reset while flushing */ }
        if (epoch !== this.epoch) continue;
        this.needKey = true;
        break;
      }
    } catch {
      this.failed = true;
    } finally {
      this.pumping = false;
      this.notify();
    }
  }
}

export class VideoSource {
  readonly reader: SampleReader;
  readonly config: VideoDecoderConfig;
  private keys: Int32Array;
  private tsToPres = new Map<number, number>();
  private lanes: Lane[] = [];
  private affinity = new Map<string, Lane>();
  private thumbLane?: Lane;

  private constructor(readonly track: VideoTrack, url: string, config: VideoDecoderConfig) {
    this.reader = new SampleReader(url, track.samples);
    this.config = config;
    this.keys = Int32Array.from(track.samples.flatMap((s, i) => (s.key ? [i] : [])));
    if (this.keys.length === 0 || this.keys[0] !== 0) this.keys = Int32Array.from([0, ...this.keys]);
    track.byPts.forEach((d, p) => this.tsToPres.set(this.timestampOf(d), p));
  }

  /** Opens a file's picture; throws UnsupportedCodecError when this webview can't decode it. */
  static async open(url: string): Promise<VideoSource> {
    const track = await openVideoTrack(url);
    const config: VideoDecoderConfig = {
      codec: track.codec,
      description: track.description,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      optimizeForLatency: true,
    };
    const ok = typeof VideoDecoder !== "undefined" && (await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported;
    if (!ok) throw new UnsupportedCodecError(`Can't decode ${track.codec} here.`);
    return new VideoSource(track, url, config);
  }

  timestampOf(decodeIndex: number): number {
    return Math.round(this.track.samples[decodeIndex].pts * 1e6);
  }

  presIndexOf(timestamp: number): number | undefined {
    return this.tsToPres.get(timestamp);
  }

  keyAtOrBefore(d: number): number {
    const k = this.keys;
    let lo = 0, hi = k.length - 1, best = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (k[m] <= d) { best = k[m]; lo = m + 1; } else hi = m - 1;
    }
    return best;
  }

  indexFor(pick: Pick<VideoPick, "time" | "rule">): number {
    return pickFrame(this.track.ptsSorted, pick);
  }

  /** Presentation time of presentation index p. */
  ptsOf(p: number): number {
    return this.track.ptsSorted[p];
  }

  private lane(p: number, key: string, busy: Set<Lane>): Lane {
    const free = this.lanes.filter((l) => !busy.has(l));
    const pinned = this.affinity.get(key);
    const pick =
      free.find((l) => l.frames.has(p)) ??
      (pinned && !busy.has(pinned) && pinned.canContinue(p) ? pinned : undefined) ??
      free.find((l) => l.canContinue(p)) ??
      (pinned && !busy.has(pinned) ? pinned : undefined) ??
      (this.lanes.length < 2 || free.length === 0 ? undefined : free.sort((a, b) => a.lastUse - b.lastUse)[0]);
    let lane = pick;
    if (!lane) {
      if (this.lanes.length >= MAX_LANES) lane = this.lanes.sort((a, b) => a.lastUse - b.lastUse)[0];
      else { lane = new Lane(this); this.lanes.push(lane); }
    }
    this.affinity.set(key, lane);
    if (this.affinity.size > 64) this.affinity.delete(this.affinity.keys().next().value!);
    busy.add(lane);
    return lane;
  }

  /**
   * The frame for `pick`, as a clone the caller must close. `key` keeps a clip on the same lane;
   * `busy` collects the lanes already used for this picture, so two layers never share one.
   */
  async frame(pick: Pick<VideoPick, "time" | "rule">, mode: DecodeMode, key: string, busy: Set<Lane>): Promise<VideoFrame | undefined> {
    const p = this.indexFor(pick);
    if (p < 0) return undefined;
    const lane = this.lane(p, key, busy);
    if (mode === "play") {
      void lane.want(p, "play");
      return lane.best(p)?.clone();
    }
    const f = await lane.want(p, mode);
    try { return f?.clone(); } catch { return undefined; }
  }

  /** A frame for a thumbnail, on its own lane so it never disturbs the viewer's decoding. */
  async thumbnailFrame(time: number, tolerance: number): Promise<VideoFrame | undefined> {
    let p = this.indexFor({ time, rule: "at" });
    if (p < 0) return undefined;
    // Within tolerance, a keyframe decodes on its own: much faster for filmstrips.
    const d = this.track.byPts[p];
    const key = this.keyAtOrBefore(d);
    const kp = this.track.ptsRank[key];
    if (Math.abs(this.ptsOf(kp) - time) <= tolerance) p = kp;
    this.thumbLane ??= new Lane(this);
    const f = await this.thumbLane.want(p, "exact");
    try { return f?.clone(); } catch { return undefined; }
  }

  /** Drops decoders and frames that haven't been used for `idleMs`. */
  trim(idleMs: number) {
    const now = performance.now();
    for (const l of [...this.lanes, ...(this.thumbLane ? [this.thumbLane] : [])]) {
      if (now - l.lastUse > idleMs) l.release();
    }
  }

  close() {
    for (const l of this.lanes) l.release();
    this.thumbLane?.release();
    this.lanes = [];
    this.affinity.clear();
  }
}

export type { Lane };
