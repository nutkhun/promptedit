// The ProRes (MOV) export's picture: each composited frame is packed as v210 on the GPU and sent to
// Rust as the raw body of an `export_frames` call (no JSON, no base64), where FFmpeg encodes it as
// it arrives (src-tauri/src/render/prores.rs). One send at a time, in order; the next frame renders
// while the last one travels, and a slow encoder holds the render back instead of piling up frames.

import { backend, type ProresProfile } from "../backend";
import { V210Packer, v210FrameBytes } from "./v210";

/** Sends in flight before rendering waits. Each holds a frame (≈5.5 MB at 1080p). */
const IN_FLIGHT = 2;

export class ProresSink {
  private packer: V210Packer;
  private free: Uint8Array<ArrayBuffer>[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  /** Sends not yet acknowledged, oldest first. */
  private sends: Promise<unknown>[] = [];
  private failure?: unknown;
  private frameBytes: number;
  /** Time spent packing and reading back, and waiting for sends, for the throughput log. */
  readonly timing = { frames: 0, packMs: 0, waitMs: 0 };

  private constructor(gl: WebGL2RenderingContext, private job: number, private width: number, private height: number) {
    this.packer = new V210Packer(gl);
    this.frameBytes = v210FrameBytes(width, height);
  }

  /** Starts FFmpeg for the job (the mix, with its loudness gain, becomes the movie's sound). */
  static async start(gl: WebGL2RenderingContext, job: number, o: {
    width: number; height: number; fpsNum: number; fpsDen: number; profile: ProresProfile; gainDb: number;
  }): Promise<ProresSink> {
    await backend.exportVideoStart(job, { codec: "prores", ...o });
    return new ProresSink(gl, job, o.width, o.height);
  }

  /** Packs the frame in `texture` (the compositor's output) and queues it for sending. */
  async push(texture: WebGLTexture) {
    if (this.failure) throw this.failure;
    const t0 = performance.now();
    while (this.sends.length >= IN_FLIGHT) await this.sends[0];
    const t1 = performance.now();
    if (this.failure) throw this.failure;
    const bytes = this.free.pop() ?? new Uint8Array(this.frameBytes);
    this.packer.pack(texture, this.width, this.height, bytes);
    this.timing.frames++;
    this.timing.waitMs += t1 - t0;
    this.timing.packMs += performance.now() - t1;
    const send: Promise<unknown> = this.chain
      .then(() => (this.failure ? undefined : backend.exportFrames(this.job, bytes)))
      .catch((e) => { this.failure = e; })
      .finally(() => { this.sends = this.sends.filter((s) => s !== send); this.free.push(bytes); });
    this.sends.push(send);
    this.chain = send;
  }

  /** Resolves when every frame has reached the encoder. */
  async drain() {
    await this.chain;
    if (this.failure) throw this.failure;
  }

  dispose() {
    this.packer.dispose();
    this.free = [];
  }
}
