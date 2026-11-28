// Export (docs/spec/02-engine.md §13, §16): the same layer evaluation and compositor as the viewer,
// frame by frame into an offscreen WebGL2 canvas at the output size; our own RGB→Y′CbCr (BT.709,
// limited range); WebCodecs H.264/HEVC at Editroom's bit rates and 2-second key-frame interval.
// The sound is mixed with the playback mixer at 48 kHz, measured (BS.1770) and normalised in Rust,
// which muxes everything into a faststart MP4 (or writes a 24-bit WAV, or encodes an MP3).
// ProRes (MOV), which WebCodecs can't make: the same frames packed as 10-bit 4:2:2 and encoded by
// FFmpeg as they arrive (./prores.ts), with the sound as 24-bit PCM.

import type { ExportOptions, ExportProgress } from "../index";
import type { Project } from "../../model";
import { asset as assetOf, clipEnd, isAudible, playRange, projectDuration } from "../../timing";
import { backend, toBase64 } from "../backend";
import { ProresSink } from "./prores";
import { Media } from "../decode/media";
import { Compositor, type Frame } from "../gl/compositor";
import { frameDuration, reframeCanvas } from "../geometry";
import type { GradeBaker } from "../grade";
import { layersAt } from "../layers";
import { resolveLayers } from "../scene";
import { captionDrawLayer, prepareCaptions } from "../../captions/picture";
import { clipSound, clipVariant, renderClip, trackMixes, type ClipSound } from "../audio/mix";
import { PcmStore, RATE } from "../audio/pcm";
import type { Waveforms } from "../audio/waveform";

/** Bits per pixel per frame (§16): High 0.2, Web 0.085; HEVC needs 62 % of that. */
export function videoBitrate(w: number, h: number, fps: number, quality: "high" | "web", hevc: boolean): number {
  const bpp = quality === "high" ? 0.2 : 0.085;
  return Math.round(w * h * Math.min(fps, 60) * bpp * (hevc ? 0.62 : 1));
}

/** The lowest H.264 level that fits the frame size and macroblock rate. */
export function avcLevel(w: number, h: number, fps: number): number {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = fs * fps;
  const levels: [number, number, number][] = [
    [0x1e, 1620, 40500], [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240],
    [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3c, 139264, 4177920], [0x3d, 139264, 8355840],
    [0x3e, 139264, 16711680],
  ];
  return (levels.find(([, f, m]) => fs <= f && mbps <= m) ?? levels[levels.length - 1])[0];
}

/** HEVC level × 30 for the luma picture size and sample rate (Main tier). */
export function hevcLevel(w: number, h: number, fps: number): number {
  const ps = w * h, sps = ps * fps;
  const levels: [number, number, number][] = [
    [93, 983040, 33177600], [120, 2228224, 66846720], [123, 2228224, 133693440], [150, 8912896, 267386880],
    [153, 8912896, 534773760], [156, 8912896, 1069547520], [180, 35651584, 1069547520], [183, 35651584, 2139095040],
    [186, 35651584, 4278190080],
  ];
  return (levels.find(([, p, s]) => ps <= p && sps <= s) ?? levels[levels.length - 1])[0];
}

async function encoderConfig(w: number, h: number, fps: number, bitrate: number, hevc: boolean): Promise<VideoEncoderConfig> {
  const common = { width: w, height: h, bitrate, framerate: fps, bitrateMode: "variable" as const, latencyMode: "quality" as const };
  const candidates: VideoEncoderConfig[] = hevc
    ? [{ ...common, codec: `hvc1.1.6.L${hevcLevel(w, h, fps)}.B0`, hevc: { format: "annexb" } } as VideoEncoderConfig]
    : ["64", "4D", "42"].map((p) => ({ ...common, codec: `avc1.${p}00${avcLevel(w, h, fps).toString(16).toUpperCase().padStart(2, "0")}`, avc: { format: "annexb" } }) as VideoEncoderConfig);
  for (const c of candidates) {
    for (const hw of ["prefer-hardware", "no-preference"] as HardwareAcceleration[]) {
      const cfg = { ...c, hardwareAcceleration: hw };
      const r = await VideoEncoder.isConfigSupported(cfg).catch(() => undefined);
      if (r?.supported) return cfg;
    }
  }
  throw new Error(hevc ? "HEVC export isn't available on this computer." : "H.264 export isn't available on this computer.");
}

const PIECE = 1 << 20;

/** Sends bytes to the job in ~1 MB pieces, in order. */
class Uplink {
  private parts: Uint8Array[] = [];
  private size = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private failure?: unknown;
  /** Sends started and not yet acknowledged. */
  inflight = 0;

  constructor(private job: number, private stream: "video" | "audio") {}

  push(bytes: Uint8Array) {
    this.parts.push(bytes);
    this.size += bytes.length;
    if (this.size >= PIECE) this.send();
  }

  private send() {
    if (this.size === 0) return;
    const all = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) { all.set(p, at); at += p.length; }
    this.parts = [];
    this.size = 0;
    // In pieces of at most 1 MB (≈1.4 MB as base64), under request-size limits.
    for (let i = 0; i < all.length; i += PIECE) {
      const piece = all.subarray(i, i + PIECE);
      this.inflight++;
      this.chain = this.chain
        .then(() => (this.failure ? undefined : backend.exportAppend(this.job, this.stream, toBase64(piece))))
        .catch((e) => { this.failure = e; })
        .finally(() => { this.inflight--; });
    }
  }

  /** Resolves when everything pushed so far has arrived. */
  async drain() {
    this.send();
    await this.chain;
    if (this.failure) throw this.failure;
  }
}

export interface ExportDeps { baker: GradeBaker; waveforms: Waveforms }

export class Exporter {
  private cancelled = false;
  private job?: number;
  private encoder?: VideoEncoder;
  private prores?: ProresSink;

  constructor(private deps: ExportDeps) {}

  cancel() {
    this.cancelled = true;
    try { this.encoder?.close(); } catch { /* closed */ }
    if (this.job != null) void backend.exportCancel(this.job);
  }

  private check() {
    if (this.cancelled) throw new Cancelled();
  }

  async run(project: Project, o: ExportOptions, onProgress: (p: ExportProgress) => void): Promise<void> {
    const report = (fraction: number, phase: ExportProgress["phase"], message?: string) => onProgress({ fraction, phase, message });
    const media = new Media(() => {}, () => project);
    try {
      report(0, "preparing");
      const audioOnly = o.format === "wav" || o.format === "mp3";
      const prores = o.format === "mov-prores";
      if (prores || o.format === "mp3") {
        // Before any work: these need encoders FFmpeg may not have.
        const enc = await backend.exportEncoders();
        if (prores && !enc.prores) throw new Error("ProRes export isn't available: this copy of FFmpeg has no ProRes encoder.");
        if (o.format === "mp3" && !enc.mp3) throw new Error("MP3 export isn't available: this copy of FFmpeg has no MP3 encoder.");
      }
      const total = projectDuration(project);
      const [lo, hi] = o.rangeOnly ? playRange(project) ?? [0, total] : [0, total];
      const duration = hi - lo;
      if (!(duration > 0)) throw new Error("There's nothing to export.");
      // A movie can leave its sound out (Audio › "No audio").
      const hasAudio = (audioOnly || o.includeAudio !== false) && project.clips.some((c) => c.kind === "audio" && c.start < hi && clipEnd(c) > lo &&
        project.audioTracks.some((t) => t.id === c.trackID && isAudible(project, t)));
      if (audioOnly && !hasAudio) throw new Error("There's no sound to export.");

      this.job = (await backend.exportBegin(o.path)).job;
      this.check();

      // 1. The sound: mixed first, so its loudness is known before the picture is made.
      if (hasAudio) {
        await this.mixAudio(project, lo, hi, (f) => report(f * (audioOnly ? 0.9 : 0.1), "preparing"));
      }
      let gainDb = 0;
      if (hasAudio && o.loudness != null) {
        const m = await backend.exportLoudness(this.job);
        // Reach the target, but never push the sample peak above −1 dBFS (§13). Silent: as mixed.
        if (m) gainDb = Math.min(o.loudness - m.lufs, -1 - m.peakDb);
      }
      this.check();

      // 2. The picture.
      const fd = frameDuration(o.fps > 0 ? o.fps : project.fps);
      if (!audioOnly) {
        await this.renderVideo(project, media, o, lo, duration, fd, gainDb, (f) => report(0.1 + f * 0.85, "rendering"));
      }
      this.check();

      report(0.96, "finishing");
      const hevc = o.format === "mp4-hevc";
      await backend.exportFinish(this.job, o.format === "wav" ? { container: "wav", gainDb }
        : o.format === "mp3" ? { container: "mp3", audioKbps: o.mp3Kbps ?? 320, gainDb }
        // The gain went into the movie's sound when the encoder started.
        : prores ? { container: "mov" }
        : { container: "mp4", codec: hevc ? "hevc" : "h264", fpsNum: fd.den, fpsDen: fd.num, audioKbps: o.quality === "high" ? 256 : 160, gainDb });
      this.job = undefined;
      report(1, "done");
    } catch (e) {
      if (this.job != null) await backend.exportCancel(this.job).catch(() => {});
      this.job = undefined;
      if (e instanceof Cancelled || this.cancelled) { report(0, "cancelled"); return; }
      const message = e instanceof Error ? e.message : String(e);
      report(0, "failed", message);
      throw e instanceof Error ? e : new Error(message);
    } finally {
      try { if (this.encoder && this.encoder.state !== "closed") this.encoder.close(); } catch { /* */ }
      media.dispose();
    }
  }

  /** Mixes [lo, hi) at 48 kHz stereo f32 (inaudible tracks left out) and sends it to the job. */
  private async mixAudio(p: Project, lo: number, hi: number, progress: (f: number) => void) {
    const pcm = new PcmStore();
    const wf = this.deps.waveforms;
    // Ducking reads the voice tracks' waveforms: have them all first.
    await Promise.all(p.clips.filter((c) => c.kind === "audio").map((c) => {
      const a = assetOf(p, c.assetID);
      return a ? wf.get(a) : undefined;
    }));
    const mixes = trackMixes(p, (c) => wf.forClip(assetOf(p, c.assetID), c)).filter((m) => m.gain > 0);
    const sounds = new Map<string, ClipSound | undefined>();
    for (const m of mixes) {
      for (const c of p.clips) {
        if (c.trackID !== m.track.id || c.kind !== "audio" || !(c.start < hi && clipEnd(c) > lo)) continue;
        const a = assetOf(p, c.assetID);
        const v = a && clipVariant(c, a);
        if (!a || !v) continue;
        const info = await pcm.info(v);
        if (!info) continue;
        const base = v.speed === 1 ? info.duration : (await pcm.info({ ...v, speed: 1 }))?.duration ?? info.duration;
        sounds.set(c.id, clipSound(c, a, info, base));
      }
    }
    const up = new Uplink(this.job!, "audio");
    const totalFrames = Math.round((hi - lo) * RATE);
    const SEG = RATE * 5;
    for (let f0 = 0; f0 < totalFrames; f0 += SEG) {
      this.check();
      const n = Math.min(SEG, totalFrames - f0);
      const t0 = lo + f0 / RATE;
      const mix = new Float32Array(n * 2);
      for (const m of mixes) {
        for (const c of p.clips) {
          const s = c.trackID === m.track.id ? sounds.get(c.id) : undefined;
          if (!s || !(c.start < t0 + n / RATE && clipEnd(c) > t0)) continue;
          // Wait for the PCM this segment needs, then render it exactly as playback does.
          const a = Math.max(t0, c.start), z = Math.min(t0 + n / RATE, clipEnd(c));
          const fa = Math.floor(Math.min(s.frameAt(a), s.frameAt(z))) - 2;
          const fz = Math.ceil(Math.max(s.frameAt(a), s.frameAt(z))) + 2;
          await pcm.read(s.info, fa, fz - fa);
          const d = renderClip(s, t0, n, m.duck, (start, count) => pcm.readNow(s.info, start, count));
          if (!d) continue;
          for (let i = 0; i < d.length; i++) mix[i] += d[i] * m.gain;
        }
      }
      up.push(new Uint8Array(mix.buffer));
      progress(Math.min(1, (f0 + n) / totalFrames));
      if (up.inflight > 2) await up.drain();
    }
    await up.drain();
  }

  private async renderVideo(p: Project, media: Media, o: ExportOptions, lo: number, duration: number,
    fd: { num: number; den: number }, gainDb: number, progress: (f: number) => void) {
    const outW = Math.max(2, Math.round(o.width / 2) * 2), outH = Math.max(2, Math.round(o.height / 2) * 2);
    const center = o.reframe ? { x: 0.5 + o.reframe.x / 2, y: 0.5 + o.reframe.y / 2 } : { x: 0.5, y: 0.5 };
    const { canvas, offset } = reframeCanvas({ width: p.width, height: p.height }, { width: outW, height: outH }, center);
    const frame: Frame = { canvasWidth: canvas.width, canvasHeight: canvas.height, outWidth: outW, outHeight: outH, offsetX: offset.x, offsetY: offset.y };
    const surface = new OffscreenCanvas(outW, outH);
    const gl = surface.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error("This computer can't render the export (no WebGL2).");
    const comp = new Compositor(gl);
    const hevc = o.format === "mp4-hevc";
    const fps = fd.den / fd.num;
    if (o.format === "mov-prores") {
      const sink = await ProresSink.start(gl, this.job!, { width: outW, height: outH, fpsNum: fd.den, fpsDen: fd.num, profile: o.proresProfile ?? "standard", gainDb });
      this.prores = sink;
    }
    const config = this.prores ? undefined : await encoderConfig(outW, outH, fps, videoBitrate(outW, outH, fps, o.quality, hevc), hevc);
    const up = new Uplink(this.job!, "video");
    let encodeError: unknown;
    // ProRes needs no WebCodecs at all (so it works where the webview can't encode video).
    const encoder = config ? new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        up.push(bytes);
      },
      error: (e) => { encodeError = e; },
    }) : undefined;
    if (encoder && config) {
      this.encoder = encoder;
      encoder.configure(config);
    }
    const n = Math.max(1, Math.ceil(duration / (fd.num / fd.den) - 1e-6));
    const gop = Math.round(fps * 2);
    const frameUs = (fd.num / fd.den) * 1e6;
    await prepareCaptions(p);
    try {
      for (let k = 0; k < n; k++) {
        this.check();
        if (encodeError) throw encodeError;
        const t = lo + (k * fd.num) / fd.den;
        const r = await resolveLayers(layersAt(p, t), media, this.deps.baker, canvas, "sequential", "export:");
        // Captions on top of every video track, in the output frame (after the reframe crop).
        const caption = captionDrawLayer(p, t, frame);
        // Video drawn bigger than its pixels (a 1080p clip in a 4K export) is upscaled, not stretched (§12).
        comp.render(caption ? [...r.layers, caption] : r.layers, frame, { upscale: true });
        for (const f of r.frames) f.close();
        if (this.prores) {
          await this.prores.push(comp.output!.tex);
          progress((k + 1) / n);
          continue;
        }
        const enc = encoder!;
        const yuv = comp.readI420();
        const vf = new VideoFrame(yuv.data, {
          format: "I420", codedWidth: outW, codedHeight: outH, timestamp: Math.round(k * frameUs), duration: Math.round(frameUs),
          layout: yuv.layout, colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
        });
        enc.encode(vf, { keyFrame: k % gop === 0 });
        vf.close();
        while (enc.encodeQueueSize > 3) await new Promise((res) => enc.addEventListener("dequeue", res, { once: true }));
        if (up.inflight > 2) await up.drain();
        progress((k + 1) / n);
      }
      if (this.prores) {
        await this.prores.drain();
        const t = this.prores.timing;
        console.info(`ProRes export: ${t.frames} frames, ${(t.packMs / t.frames).toFixed(1)} ms packing, ${(t.waitMs / t.frames).toFixed(1)} ms waiting for sends a frame`);
      } else {
        await encoder!.flush();
      }
      if (encodeError) throw encodeError;
      await up.drain();
    } finally {
      this.prores?.dispose();
      this.prores = undefined;
      try { if (encoder && encoder.state !== "closed") encoder.close(); } catch { /* closed */ }
      comp.dispose();
    }
  }
}

class Cancelled extends Error {}
