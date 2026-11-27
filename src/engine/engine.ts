// The media engine: viewer drawing, playback (audio-clocked), scrubbing, thumbnails, waveforms,
// meters and export, behind the `Engine` interface in ./index.ts.

import { fileURL } from "../api";
import type { Id, Project } from "../model";
import { store, useStore } from "../store";
import { asset as assetOf, playRange, projectDuration } from "../timing";
import { AudioOut } from "./audio/player";
import { PcmStore } from "./audio/pcm";
import { Meters, METER_FLOOR, type MeterLevels } from "./audio/meters";
import { Waveforms, type Waveform } from "./audio/waveform";
import { Media } from "./decode/media";
import type { DecodeMode, Lane } from "./decode/video-source";
import { Exporter } from "./export/exporter";
import { Compositor, type Frame } from "./gl/compositor";
import { fitRect, frameSeconds, previewSize } from "./geometry";
import { GradeBaker } from "./grade";
import type { Engine, ExportOptions, ExportProgress } from "./index";
import { layersAt, type Layer } from "./layers";
import { resolveLayers } from "./scene";
import { Thumbnails } from "./thumbs";

type Shown = { kind: "timeline"; t: number } | { kind: "source"; asset: Id; time: number };

/** How far ahead (s) upcoming clips start decoding while playing, so cuts don't stall. */
const LOOKAHEAD = 0.5;

export class MediaEngine implements Engine {
  private canvas: HTMLCanvasElement | null = null;
  private comp?: Compositor;
  private media = new Media(() => this.redraw());
  private baker = new GradeBaker(async (path) => (await fetch(fileURL(path))).text());
  private pcm = new PcmStore();
  private waves = new Waveforms(() => this.audio.waveformsChanged());
  private audio = new AudioOut(this.pcm, this.waves, () => store().project);
  private meterState = new Meters();
  private thumbs = new Thumbnails(this.media);
  private exporter?: Exporter;
  private shown: Shown = { kind: "timeline", t: 0 };
  private generation = 0;
  private drawn = 0;
  private playing = false;
  private raf = 0;
  private lastFrameTime = NaN;
  private lastComplete = false;
  private dirty = false;
  private span: [number, number] = [0, 0];
  private unsubscribe?: () => void;
  private pending = 0;

  constructor() {
    this.unsubscribe = useStore.subscribe((s, prev) => {
      if (s.project !== prev.project) {
        this.dirty = true;
        this.audio.projectChanged();
        if (!this.playing) this.redraw();
      }
    });
  }

  // ---- Viewer ----

  attachViewer(canvas: HTMLCanvasElement | null) {
    if (canvas === this.canvas) return;
    this.comp?.dispose();
    this.comp = undefined;
    this.canvas = canvas;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return;
    this.comp = new Compositor(gl);
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.comp = undefined; });
    canvas.addEventListener("webglcontextrestored", () => { this.comp = new Compositor(gl); this.redraw(); });
    this.redraw();
  }

  /** The layout size for the viewer: the preview size, no bigger than twice the shown size. */
  private viewSize(p: Project): { width: number; height: number } {
    const pre = previewSize(p);
    const c = this.canvas;
    if (!c || c.width < 2) return pre;
    const box = fitRect({ width: c.width * 2, height: c.height * 2 }, p.width / p.height);
    if (box.width >= pre.width) return pre;
    const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
    return { width: even(box.width), height: even(box.height) };
  }

  private present(p: Project) {
    const c = this.canvas;
    if (!c || !this.comp) return;
    this.comp.present(c.width, c.height, fitRect({ width: c.width, height: c.height }, p.width / Math.max(1, p.height)));
  }

  /** Draws the timeline at frame time t. Returns whether every picture was available. */
  private async drawTimeline(t: number, mode: DecodeMode): Promise<boolean> {
    const gen = ++this.generation;
    this.pending++;
    try {
      return await this.drawTimelineNow(t, mode, gen);
    } finally {
      this.pending--;
    }
  }

  private async drawTimelineNow(t: number, mode: DecodeMode, gen: number): Promise<boolean> {
    const p = store().project;
    const size = this.viewSize(p);
    const layers = layersAt(p, t);
    const r = await resolveLayers(layers, this.media, this.baker, size, mode, "", () => this.redraw());
    if (this.playing) this.prefetch(p, t, r.busy);
    try {
      if (gen < this.drawn || !this.comp) return r.complete;
      this.drawn = gen;
      const frame: Frame = { canvasWidth: size.width, canvasHeight: size.height, outWidth: size.width, outHeight: size.height, offsetX: 0, offsetY: 0 };
      this.comp.render(r.layers, frame);
      this.present(p);
    } finally {
      for (const f of r.frames) f.close();
    }
    return r.complete;
  }

  /** While playing: start decoding clips that are about to appear, on lanes not in use now. */
  private prefetch(p: Project, t: number, busy: Map<string, Set<Lane>>) {
    const now = new Set(layersAt(p, t).map((l) => l.clipID));
    for (const l of layersAt(p, t + LOOKAHEAD)) {
      if (now.has(l.clipID) || l.source.kind !== "video") continue;
      const src = this.media.videoNow(l.source.pick.asset);
      if (!src) continue;
      let set = busy.get(l.source.pick.asset);
      if (!set) { set = new Set(); busy.set(l.source.pick.asset, set); }
      // The frame this clip opens on, decoded ahead (the result itself isn't needed yet).
      void src.frame(l.source.pick, "play", l.clipID, set).then((f) => f?.close());
    }
  }

  private async drawSource(asset: Id, time: number, mode: DecodeMode): Promise<boolean> {
    const gen = ++this.generation;
    this.pending++;
    try {
      return await this.drawSourceNow(asset, time, mode, gen);
    } finally {
      this.pending--;
    }
  }

  private async drawSourceNow(asset: Id, time: number, mode: DecodeMode, gen: number): Promise<boolean> {
    const p = store().project;
    const a = assetOf(p, asset);
    const size = this.viewSize(p);
    const draw = async () => {
      if (!a) return { layers: [], frames: [] as VideoFrame[], complete: true };
      const layer: Layer = a.kind === "image"
        ? { clipID: `source:${asset}`, track: 0, source: { kind: "image", asset }, opacity: 1 }
        : { clipID: `source:${asset}`, track: 0, source: { kind: "video", pick: { asset, time: Math.min(Math.max(0, time), a.duration), rule: "at" } }, opacity: 1 };
      if (a.kind === "audio") return { layers: [], frames: [] as VideoFrame[], complete: true };
      return resolveLayers([layer], this.media, this.baker, size, mode, "source:");
    };
    const r = await draw();
    try {
      if (gen < this.drawn || !this.comp) return r.complete;
      this.drawn = gen;
      this.comp.render(r.layers, { canvasWidth: size.width, canvasHeight: size.height, outWidth: size.width, outHeight: size.height, offsetX: 0, offsetY: 0 });
      this.present(p);
    } finally {
      for (const f of r.frames) f.close();
    }
    return r.complete;
  }

  /** Draws what's shown again (an edit, a file finished loading). */
  private redraw() {
    if (this.playing) { this.dirty = true; return; }
    const s = this.shown;
    if (s.kind === "timeline") void this.drawTimeline(this.frameTime(s.t), "exact");
    else void this.drawSource(s.asset, s.time, "exact");
  }

  private frameTime(t: number): number {
    const p = store().project;
    const fd = frameSeconds(p.fps || 30);
    return Math.max(0, Math.floor(t / fd + 1e-6) * fd);
  }

  showFrame(t: number, fast = false) {
    this.shown = { kind: "timeline", t };
    if (this.playing) return;
    const ft = this.frameTime(t);
    // Skimming: whatever is decoded now, at once; the exact frame follows when it's ready.
    if (fast) void this.drawTimeline(ft, "play");
    void this.drawTimeline(ft, "exact");
  }

  showSource(source?: { asset: Id; time: number }) {
    if (!source) {
      this.shown = { kind: "timeline", t: store().playhead };
      this.redraw();
      return;
    }
    this.shown = { kind: "source", asset: source.asset, time: source.time };
    if (this.playing) return;
    void this.drawSource(source.asset, source.time, "play");
    void this.drawSource(source.asset, source.time, "exact");
  }

  // ---- Playback ----

  play(from: number) {
    this.stopLoop();
    const p = store().project;
    const dur = projectDuration(p);
    const range = store().loop ? playRange(p) : undefined;
    this.span = range ?? [0, dur];
    this.playing = true;
    this.shown = { kind: "timeline", t: from };
    this.lastFrameTime = NaN;
    // Waveforms feed the meters and ducking.
    for (const c of p.clips) if (c.kind === "audio") { const a = assetOf(p, c.assetID); if (a) void this.waves.get(a); }
    void this.audio.start(from).then(() => {
      if (!this.playing) return;
      this.raf = requestAnimationFrame(this.tick);
    });
  }

  pause() {
    const t = this.playing ? this.audio.now() : store().playhead;
    this.stopLoop();
    this.audio.stop();
    this.meterState.update(store().project, t, false, () => undefined, performance.now() / 1000);
    if (this.playing) {
      this.playing = false;
      store().seek(t);
      this.shown = { kind: "timeline", t: store().playhead };
    }
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = () => {
    if (!this.playing) return;
    const s = store();
    const p = s.project;
    let t = this.audio.now();
    const [a, b] = this.span;
    if (t >= b) {
      if (s.loop && b > a) {
        // Looping: start the span again.
        this.audio.stop();
        this.playing = false;
        this.play(a);
        s.set({ playhead: a });
        return;
      }
      t = b;
      this.playing = false;
      this.audio.stop();
      s.set({ playing: false });
      s.seek(t);
      this.shown = { kind: "timeline", t: store().playhead };
      this.meterState.update(p, t, false, () => undefined, performance.now() / 1000);
      this.redraw();
      return;
    }
    s.set({ playhead: t });
    this.shown = { kind: "timeline", t };
    this.meterState.update(p, t, true, (c) => this.waves.forClip(assetOf(p, c.assetID), c), performance.now() / 1000);
    const ft = this.frameTime(t);
    if (ft !== this.lastFrameTime || !this.lastComplete || this.dirty) {
      this.dirty = false;
      this.lastFrameTime = ft;
      void this.drawTimeline(ft, "play").then((complete) => { this.lastComplete = complete; });
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---- Media helpers ----

  thumbnail(asset: Id, time: number, height: number): Promise<ImageBitmap | undefined> {
    return this.thumbs.get(asset, time, height);
  }

  async waveform(asset: Id): Promise<Float32Array | undefined> {
    return (await this.waveformData(asset))?.rms;
  }

  async waveformData(asset: Id): Promise<Waveform | undefined> {
    const a = assetOf(store().project, asset);
    return a ? this.waves.get(a) : undefined;
  }

  meters(): [number, number] {
    const m = this.meterState.levels;
    const v = (x: number) => (x <= METER_FLOOR ? -Infinity : x);
    return [v(m.left.level), v(m.right.level)];
  }

  levels(): MeterLevels {
    return this.meterState.levels;
  }

  scrubAudio(t: number) {
    if (this.playing) return;
    this.audio.scrub(t);
  }

  // ---- Export ----

  async export(options: ExportOptions, onProgress: (p: ExportProgress) => void): Promise<void> {
    if (this.exporter) throw new Error("An export is already running.");
    const project = store().project;
    this.exporter = new Exporter({ baker: this.baker, waveforms: this.waves });
    try {
      await this.exporter.run(project, options, onProgress);
    } finally {
      this.exporter = undefined;
    }
  }

  cancelExport() {
    this.exporter?.cancel();
  }

  /** Resolves once no draw is in progress (for tests: the viewer shows the latest request). */
  async idle(): Promise<void> {
    for (let quiet = 0; quiet < 3;) {
      await new Promise((r) => setTimeout(r, 30));
      quiet = this.pending === 0 ? quiet + 1 : 0;
    }
  }

  /** Reads the viewer's last render back (8-bit RGBA, top row first). For tests and diagnostics. */
  readViewer(): { width: number; height: number; data: Uint8Array } | undefined {
    if (!this.comp) return undefined;
    const p = store().project;
    const size = this.viewSize(p);
    return { ...size, data: this.comp.readRGBA() };
  }

  dispose() {
    this.pause();
    this.unsubscribe?.();
    this.comp?.dispose();
    this.media.dispose();
  }
}

