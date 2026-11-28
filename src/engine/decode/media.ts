// The engine's open media: a decoder (VideoSource) per video file, a bitmap per still, and each
// file's rotation. Files the webview can't decode get an edit-friendly copy once (transcode_media),
// and are reopened from it.

import { api, fileURL, mediaPath } from "../../api";
import type { Id, MediaAsset, Probe, Project } from "../../model";
import { store } from "../../store";
import type { Rotation } from "../gl/compositor";
import { sourceColorOf, sourceCube, yuvCoefficients, type SourceColorKind } from "../color/source-color";
import type { YuvColor } from "../color/planes";
import { VideoSource } from "./video-source";

/** How a file's picture becomes Rec.709 (§3.7): its kind, the conversion cube, and its Y′CbCr. */
export interface SourceColorInfo extends YuvColor {
  kind: SourceColorKind;
  cube?: Float32Array;
}

const STANDARD: SourceColorInfo = { kind: "standard", k: [0.2126, 0.0722], fullRange: false };

/** The probe fields that describe the picture's colour (kept for an edit-friendly copy, below). */
const COLOR_FIELDS = ["colorPrimaries", "colorTransfer", "colorMatrix", "colorRange", "sourceColor"] as const;

/** Stills larger than this are scaled down on load (GPU texture limits). */
const MAX_STILL = 4096;

export class Media {
  private videos = new Map<string, Promise<VideoSource | undefined>>();
  private videoReady = new Map<string, VideoSource | undefined>();
  private stills = new Map<string, Promise<ImageBitmap | undefined>>();
  private stillReady = new Map<string, ImageBitmap | undefined>();
  private transcodeTried = new Set<Id>();
  private probing = new Map<string, Promise<Probe | undefined>>();
  private timer?: ReturnType<typeof setInterval>;

  /** `onReady` runs whenever something that was loading becomes available (redraw then). */
  constructor(private onReady: () => void = () => {}, private project: () => Project = () => store().project) {
    this.timer = setInterval(() => {
      for (const v of this.videoReady.values()) v?.trim(10_000);
    }, 4000);
  }

  asset(id: Id): MediaAsset | undefined {
    return this.project().assets.find((a) => a.id === id);
  }

  /** The file's decoder, opening it (and making a playable copy if needed) on first use. */
  video(id: Id): Promise<VideoSource | undefined> {
    const a = this.asset(id);
    if (!a || a.kind !== "video") return Promise.resolve(undefined);
    const path = mediaPath(a);
    let p = this.videos.get(path);
    if (!p) {
      p = VideoSource.open(fileURL(path)).then(
        (v) => v,
        async (e) => {
          // Codec (or container) this webview can't read: an edit-friendly copy, once per item.
          if (this.transcodeTried.has(id)) throw e;
          this.transcodeTried.add(id);
          const snap = await api.transcodeMedia(id);
          store().apply(snap);
          const b = snap.project.assets.find((x) => x.id === id);
          if (!b || mediaPath(b) === path) throw e;
          // A re-encoded copy is already upright (ffmpeg applies the rotation): use the copy's probe.
          const probe = await api.probeMedia(mediaPath(b)).catch(() => undefined);
          if (probe) {
            // FFmpeg keeps the samples' curve and matrix but not Apple Log's sample-description tag:
            // the copy is described by the original's colour.
            const before = store().probes[id];
            if (before) for (const k of COLOR_FIELDS) if (before[k] !== undefined) (probe as unknown as Record<string, unknown>)[k] = before[k];
            store().set({ probes: { ...store().probes, [id]: probe } });
          }
          return this.video(id);
        },
      ).catch(() => undefined).then((v) => {
        this.videoReady.set(path, v);
        this.onReady();
        return v;
      });
      this.videos.set(path, p);
    }
    return p;
  }

  /** The decoder if it's open already (opening it otherwise). */
  videoNow(id: Id): VideoSource | undefined {
    const a = this.asset(id);
    if (!a) return undefined;
    const path = mediaPath(a);
    if (!this.videos.has(path)) void this.video(id);
    return this.videoReady.get(path);
  }

  still(id: Id): Promise<ImageBitmap | undefined> {
    const a = this.asset(id);
    if (!a || a.kind !== "image") return Promise.resolve(undefined);
    const path = mediaPath(a);
    let p = this.stills.get(path);
    if (!p) {
      p = (async () => {
        const blob = await (await fetch(fileURL(path))).blob();
        // Raw values (no colour management), EXIF orientation applied, premultiplied.
        const opts: ImageBitmapOptions = { colorSpaceConversion: "none", imageOrientation: "from-image", premultiplyAlpha: "premultiply" };
        let bmp = await createImageBitmap(blob, opts);
        const long = Math.max(bmp.width, bmp.height);
        if (long > MAX_STILL) {
          const s = MAX_STILL / long;
          const resized = await createImageBitmap(bmp, { ...opts, imageOrientation: "none", resizeWidth: Math.round(bmp.width * s), resizeHeight: Math.round(bmp.height * s), resizeQuality: "high" });
          bmp.close();
          bmp = resized;
        }
        return bmp;
      })().catch(() => undefined).then((b) => {
        this.stillReady.set(path, b);
        this.onReady();
        return b;
      });
      this.stills.set(path, p);
    }
    return p;
  }

  stillNow(id: Id): ImageBitmap | undefined {
    const a = this.asset(id);
    if (!a) return undefined;
    const path = mediaPath(a);
    if (!this.stills.has(path)) void this.still(id);
    return this.stillReady.get(path);
  }

  /** Degrees clockwise to rotate the decoded picture (from the probe; re-probed if missing). */
  rotation(id: Id): Rotation {
    const s = store();
    const p = s.probes[id];
    if (p) return (((Math.round(p.rotation / 90) % 4) + 4) % 4 * 90) as Rotation;
    const a = this.asset(id);
    if (a && a.kind === "video") {
      const path = mediaPath(a);
      if (!this.probing.has(path)) {
        this.probing.set(path, api.probeMedia(path).then((probe) => {
          store().set({ probes: { ...store().probes, [id]: probe } });
          this.onReady();
          return probe;
        }, () => undefined));
      }
    }
    return 0;
  }

  /** HDR / Log conversion for a video file (standard until its probe is in; see `rotation`). */
  sourceColor(id: Id): SourceColorInfo {
    const p = store().probes[id];
    const kind = sourceColorOf(p);
    if (kind === "standard") {
      if (!p?.colorMatrix && !p?.colorRange) return STANDARD;
      return { kind, k: yuvCoefficients(p.colorMatrix, kind), fullRange: p.colorRange === "pc" };
    }
    return { kind, cube: sourceCube(kind), k: yuvCoefficients(p?.colorMatrix, kind), fullRange: p?.colorRange === "pc" };
  }

  /** Waits for a pending probe (for exports, where the first frame must already be upright). */
  async rotationAsync(id: Id): Promise<Rotation> {
    this.rotation(id);
    const a = this.asset(id);
    if (a) await this.probing.get(mediaPath(a));
    return this.rotation(id);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    for (const v of this.videoReady.values()) v?.close();
    for (const b of this.stillReady.values()) b?.close();
    this.videos.clear();
    this.videoReady.clear();
    this.stills.clear();
    this.stillReady.clear();
  }
}
