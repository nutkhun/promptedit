// The timeline canvas's behaviour: hover and skimming, scrubbing, selection and marquee, move,
// ⌥-duplicate, trim (and sticky trim), fades, gain lines, the cut tool, markers and in/out edges,
// drops, autoscroll, wheel/pinch zoom and the context menus (docs/spec/04-ui.md §3; Editroom's
// TimelineCanvas). Drags draw locally and commit exactly one edit on release.

import { engine } from "../engine";
import { api, isMac } from "../api";
import type { Clip, Id, Marker, Payload, Project, TransitionKind } from "../model";
import { store } from "../store";
import {
  asset as findAsset, clipEnd, formatDB, isLocked, linked, nextTouching, playsSource, previousTouching, projectDuration,
  snapFrame, snapTargets, sourceTime, timecode, unlocked,
} from "../timing";
import { RULER, makeLayout } from "./layout";
import { Geometry } from "./geometry";
import type { Rect, Zone } from "./geometry";
import {
  SNAP_POINT, computeMove, computeTrim, cutTime, fadeValue, freshCopies, gainFromNorm, gainNorm, groupOf, planDrop, snap,
} from "./edits";
import type { DropPlan } from "./edits";
import { drawTimeline, markerLabelWidth } from "./draw";
import { palette } from "./palette";
import { commitLive, flushLive, sendLive } from "./live";
import { captionBlocks, captionProvider, useCaptions } from "./captions";
import type { CaptionBlock } from "./captions";
import { openMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import * as A from "./actions";
import { wheelZoomFactor } from "./viewMath";

/** Media panel drag payloads (dataTransfer types). */
export const MEDIA_TYPE = "application/x-promptedit-media";
export const TEXT_TYPE = "application/x-promptedit-text";
export const SOLID_TYPE = "application/x-promptedit-solid";

type Drag =
  | { kind: "none" }
  | { kind: "scrub" }
  | { kind: "pendingMove"; grabbed: Clip; x: number; y: number; time: number }
  | { kind: "move"; grabbed: Clip; time: number; originals: Clip[] }
  | { kind: "trim"; grabbed: Clip; left: boolean; time: number; originals: Clip[] }
  | { kind: "fade"; clip: Clip; fadeIn: boolean }
  | { kind: "gain"; id: Id; startY: number; startNorm: number; height: number }
  | { kind: "marquee"; ox: number; oy: number; base: Set<Id>; captionBase: Set<string> }
  | { kind: "captionMarquee"; ox: number; oy: number; base: Set<string> }
  | { kind: "marker"; id: Id; startX: number; moved: boolean }
  | { kind: "rangeEdge"; isIn: boolean };

const TRIM_CURSOR = "ew-resize";
/** Scissors, white with a dark shadow, hotspot in the middle (Editroom's Cursors.cut). */
const CUT_CURSOR = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><defs><filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="black" flood-opacity="0.9"/></filter></defs><g transform="translate(4 4)" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" filter="url(#s)"><circle cx="4" cy="12" r="2.3"/><circle cx="12" cy="12" r="2.3"/><path d="M5.6 10.4L13 2M10.4 10.4L3 2"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
})();

export class TimelineController {
  canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private dpr = 1;

  private drag: Drag = { kind: "none" };
  private overrides: Clip[] = [];
  private ghosts: Clip[] = [];
  private fileGhostLabel?: string;
  private dropPlan?: DropPlan;
  private hover?: { id: Id; zone: Zone };
  private cutHover?: { id: Id; time: number };
  private snapLine?: number;
  private marquee?: Rect;
  private bubble?: { text: string; x: number; y: number };
  private readout?: number;
  private duplicating = false;
  private moveTrackDelta = 0;
  private markerOverride?: { id: Id; time: number };
  private rangeOverride?: { isIn: boolean; time: number };
  private last = { x: 0, y: 0 };
  private mods = { alt: false, primary: false, shift: false };
  private lastDown = { time: 0, x: 0, y: 0, count: 0 };
  private autoscrollV = 0;
  private autoscrollFrame?: number;
  private autoscrollAt = 0;
  private settle?: ReturnType<typeof setTimeout>;
  private frame?: number;
  /** Set by the Media panel (or a test) while it drags: payloads aren't readable from dataTransfer until drop. */
  dragPayloads?: Payload[];

  // ---- Setup and drawing ----

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas ?? undefined;
    this.ctx = canvas?.getContext("2d") ?? undefined;
    this.invalidate();
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.dpr = window.devicePixelRatio || 1;
    if (this.canvas) {
      this.canvas.width = Math.max(1, Math.round(width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    }
    this.draw();
  }

  /** Repaint on the next animation frame (coalesced). */
  invalidate = () => {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.draw();
    });
  };

  /** The project as drawn: markers and in/out being dragged shown where they are now. */
  private displayProject(): Project {
    let p = store().project;
    const m = this.markerOverride, r = this.rangeOverride;
    if (m) p = { ...p, markers: (p.markers ?? []).map((x) => (x.id === m.id ? { ...x, time: m.time } : x)) };
    if (r) p = r.isIn ? { ...p, inPoint: r.time } : { ...p, outPoint: r.time };
    return p;
  }

  geometry(p: Project = store().project): Geometry {
    const s = store();
    return new Geometry(p, makeLayout(p, s.view.rowHeight), { ...s.view, viewWidth: this.width || s.view.viewWidth, viewHeight: this.height || s.view.viewHeight });
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.width || !this.height) return;
    const s = store();
    const geo = this.geometry(this.displayProject());
    const caps = useCaptions.getState();
    const skim = s.skim && "time" in s.skim && !("asset" in s.skim) ? s.skim.time : undefined;
    drawTimeline(ctx, {
      geo, width: this.width, height: this.height, dpr: this.dpr, palette: palette(),
      selection: s.selection, thumbnails: s.thumbnails, timeStyle: s.timeStyle,
      overrides: this.overrides, duplicating: this.duplicating, ghosts: this.ghosts, fileGhostLabel: this.fileGhostLabel,
      hover: this.hover, cut: this.cutHover, snapLine: this.snapLine, marquee: this.marquee,
      bubble: this.bubble, readout: this.readout, skim,
      trimming: this.drag.kind === "trim" ? { ids: new Set(this.drag.originals.map((c) => c.id)), left: this.drag.left } : undefined,
      captions: this.shownCaptions(geo.project), captionSelection: caps.selection,
      captionsWaiting: captionProvider()?.waiting() ?? false,
    });
  }

  /** Captions as they'll be: while clips are dragged, laid out from where they are now. */
  private shownCaptions(p: Project): CaptionBlock[] {
    if (!p.captions) return [];
    if (!this.overrides.length) return captionBlocks(p);
    const byId = new Map(this.overrides.map((c) => [c.id, c]));
    const clips = this.duplicating
      ? [...p.clips, ...freshCopies(this.overrides)]
      : p.clips.map((c) => byId.get(c.id) ?? c);
    return captionBlocks({ ...p, clips });
  }

  // ---- Snapping and modifiers ----

  /** Snapping is on when the setting XOR ⌘ (Ctrl on Windows) is held. */
  private get snapping() { return store().snapping !== this.mods.primary; }

  private readMods(e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
    this.mods = { alt: e.altKey, primary: isMac ? e.metaKey : e.ctrlKey, shift: e.shiftKey };
  }

  /** Modifier changes mid-drag (⌥ duplicate, ⌘ snapping) re-run the drag where the pointer is. */
  keyChanged(e: KeyboardEvent) {
    if (this.drag.kind === "none") return false;
    if (e.type === "keydown" && e.key === "Escape") {
      this.cancelDrag();
      return true;
    }
    const before = { ...this.mods };
    this.readMods(e);
    if (before.alt !== this.mods.alt || before.primary !== this.mods.primary) this.handleDrag(this.last.x, this.last.y);
    return false;
  }

  // ---- Hover, skimming ----

  pointerMove(x: number, y: number, e: PointerEvent) {
    this.readMods(e);
    if (this.drag.kind !== "none") {
      this.last = { x, y };
      this.handleDrag(x, y);
      if (["scrub", "move", "trim", "marquee", "captionMarquee"].includes(this.drag.kind)) this.updateAutoscroll(x);
      return;
    }
    this.updateHover(x, y);
    const s = store();
    if (s.skimming && !s.playing && x >= 0 && x <= this.width) this.skimTo(this.geometry().time(x));
  }

  pointerLeave() {
    if (this.drag.kind !== "none") return;
    this.endSkim();
    if (this.hover || this.cutHover) {
      this.hover = undefined;
      this.cutHover = undefined;
      this.invalidate();
    }
  }

  private skimTo(time: number) {
    const s = store();
    const t = Math.min(Math.max(0, snapFrame(s.project, time)), projectDuration(s.project));
    const cur = s.skim && !("asset" in s.skim) ? s.skim.time : undefined;
    if (cur === t) return;
    s.set({ skim: { time: t } });
    this.showFrame(t);
    if (s.audioScrubbing) engine.scrubAudio(t);
    this.invalidate();
  }

  private endSkim() {
    const s = store();
    if (!s.skim || "asset" in s.skim) return;
    s.set({ skim: undefined });
    if (!s.playing) engine.showFrame(s.playhead);
    this.invalidate();
  }

  /** A fast (approximate) frame now, the exact one once the pointer rests for 90 ms. */
  private showFrame(t: number) {
    engine.showFrame(t, true);
    clearTimeout(this.settle);
    this.settle = setTimeout(() => engine.showFrame(t, false), 90);
  }

  private setCursor(c: string) {
    if (this.canvas && this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  private updateHover(x: number, y: number) {
    const s = store();
    const geo = this.geometry();
    let hover: { id: Id; zone: Zone } | undefined;
    let cut: { id: Id; time: number } | undefined;
    let cursor = "default";
    if (y < RULER) cursor = "default";
    else if (s.tool === "cut") {
      cursor = CUT_CURSOR;
      const h = geo.hit(x, y);
      if (h) {
        const t = cutTime(s.project, h.clip, geo.time(x), geo.pps, s.playhead, this.snapping);
        if (t !== undefined) {
          cut = { id: h.clip.id, time: t };
          hover = { id: h.clip.id, zone: "body" };
        }
      }
    } else {
      const h = geo.hit(x, y);
      if (h) {
        hover = { id: h.clip.id, zone: h.zone };
        cursor = h.zone === "left" || h.zone === "right" ? TRIM_CURSOR : h.zone === "gain" ? "ns-resize"
          : h.zone === "fadeIn" || h.zone === "fadeOut" ? "pointer" : "default";
      }
    }
    const changed = hover?.id !== this.hover?.id || hover?.zone !== this.hover?.zone
      || cut?.id !== this.cutHover?.id || cut?.time !== this.cutHover?.time;
    this.hover = hover;
    this.cutHover = cut;
    this.setCursor(cursor);
    if (changed) this.invalidate();
  }

  // ---- Mouse down ----

  pointerDown(x: number, y: number, e: PointerEvent) {
    this.readMods(e);
    const s = store();
    // Working on the timeline: Delete is for clips again, not Media items.
    if (s.mediaSelection.size) s.set({ mediaSelection: new Set() });
    this.endSkim();
    this.last = { x, y };
    const now = performance.now();
    const again = now - this.lastDown.time < 400 && Math.abs(x - this.lastDown.x) < 5 && Math.abs(y - this.lastDown.y) < 5;
    this.lastDown = { time: now, x, y, count: again ? this.lastDown.count + 1 : 1 };
    const clickCount = this.lastDown.count;
    const extend = e.shiftKey;
    const geo = this.geometry();
    const p = s.project;

    if (y < RULER) {
      // Near the playhead a click takes the playhead; otherwise a marker flag or a range edge.
      const onPlayhead = Math.abs(x - geo.x(s.playhead)) <= 6;
      const marker = onPlayhead ? undefined : this.markerHit(x, geo);
      if (marker) {
        this.drag = { kind: "marker", id: marker, startX: x, moved: false };
        return;
      }
      const edge = onPlayhead ? undefined : this.rangeEdgeHit(x, geo);
      if (edge !== undefined) {
        this.drag = { kind: "rangeEdge", isIn: edge };
        return;
      }
      this.drag = { kind: "scrub" };
      this.scrub(x);
      return;
    }

    if (geo.inCaptionRow(y)) {
      this.captionDown(x, y, extend, clickCount, geo);
      return;
    }

    if (s.tool === "cut") {
      this.updateHover(x, y);
      const cut = this.cutHover;
      if (cut) {
        s.edit({ op: "split", ids: [...linked(p, [cut.id])], at: cut.time });
        this.cutHover = undefined;
        this.invalidate();
      }
      return;
    }

    const h = geo.hit(x, y);
    if (!h) {
      if (!extend) {
        s.set({ selection: new Set() });
        useCaptions.setState({ selection: new Set(), focused: false });
      }
      this.drag = {
        kind: "marquee", ox: x + s.view.scrollX, oy: y + s.view.scrollY, base: new Set(store().selection),
        captionBase: extend ? new Set(useCaptions.getState().selection) : new Set(),
      };
      return;
    }

    const group = groupOf(p, h.clip.id);
    const selectGroup = () => {
      if (!s.selection.has(h.clip.id)) {
        s.set({ selection: group });
        useCaptions.setState({ selection: new Set() });
      }
    };
    switch (h.zone) {
      case "body":
        if (extend) {
          const next = new Set(s.selection);
          if (next.has(h.clip.id)) group.forEach((id) => next.delete(id)); else group.forEach((id) => next.add(id));
          s.set({ selection: next });
          return;
        }
        selectGroup();
        this.drag = { kind: "pendingMove", grabbed: h.clip, x, y, time: geo.time(x) };
        break;
      case "left":
      case "right": {
        selectGroup();
        // Every selected clip's same edge moves together (any track); with nothing else selected,
        // that's this clip and what's linked to it.
        const trimmed = unlocked(p, linked(p, new Set([...store().selection, ...group])));
        const originals = p.clips.filter((c) => trimmed.has(c.id));
        this.drag = { kind: "trim", grabbed: h.clip, left: h.zone === "left", time: geo.time(x), originals };
        this.handleDrag(x, y);
        break;
      }
      case "fadeIn":
      case "fadeOut":
        this.drag = { kind: "fade", clip: h.clip, fadeIn: h.zone === "fadeIn" };
        break;
      case "gain":
        if (clickCount === 2) {
          s.edit({ op: "update", ids: [h.clip.id], patch: { gainDB: 0 } });
          return;
        }
        this.drag = { kind: "gain", id: h.clip.id, startY: y, startNorm: gainNorm(h.clip.gainDB), height: h.rect.h };
        break;
    }
    this.invalidate();
  }

  private captionDown(x: number, y: number, extend: boolean, clickCount: number, geo: Geometry) {
    const s = store();
    const blocks = this.shownCaptions(s.project);
    const hit = [...blocks].reverse().find((b) => {
      const r = geo.captionRect(b.start, b.end);
      return r && x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y && y <= r.y + r.h;
    });
    const caps = useCaptions.getState();
    const select = (ids: Set<string>) => {
      if (s.selection.size) s.set({ selection: new Set() });
      useCaptions.setState({ selection: ids, focused: false });
    };
    const origin = { ox: x + s.view.scrollX, oy: y + s.view.scrollY };
    if (!hit) {
      if (!extend) select(new Set());
      this.drag = { kind: "captionMarquee", ...origin, base: new Set(useCaptions.getState().selection) };
      return;
    }
    if (extend) {
      const next = new Set(caps.selection);
      if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id);
      select(next);
    } else select(new Set([hit.id]));
    if (clickCount === 2) {
      select(new Set([hit.id]));
      s.seek((hit.start + hit.end) / 2);
      engine.showFrame(store().playhead);
      captionProvider()?.edit?.(hit);
    } else {
      // Captions don't move, so a drag from one boxes in more.
      this.drag = { kind: "captionMarquee", ...origin, base: extend ? new Set(useCaptions.getState().selection) : new Set() };
    }
    this.invalidate();
  }

  // ---- Drag ----

  private handleDrag(x: number, y: number) {
    const s = store();
    const geo = this.geometry();
    const p = s.project;
    const d = this.drag;
    switch (d.kind) {
      case "none":
        return;
      case "scrub":
        this.scrub(x);
        return;
      case "pendingMove": {
        if (Math.abs(x - d.x) <= 3 && Math.abs(y - d.y) <= 3) return;
        const ids = unlocked(p, linked(p, s.selection));
        const originals = p.clips.filter((c) => ids.has(c.id));
        this.moveTrackDelta = 0;
        this.drag = { kind: "move", grabbed: d.grabbed, time: d.time, originals };
        this.handleDrag(x, y);
        return;
      }
      case "move": {
        this.duplicating = this.mods.alt;
        this.setCursor(this.duplicating ? "copy" : "grabbing");
        const r = computeMove({
          project: p, originals: d.originals, grabbed: d.grabbed, startTime: d.time, time: geo.time(x), pps: geo.pps,
          playhead: s.playhead, snapping: this.snapping, lane: geo.lane(y), previousDelta: this.moveTrackDelta,
        });
        this.moveTrackDelta = r.trackDelta;
        this.overrides = r.clips;
        this.snapLine = r.snapLine;
        break;
      }
      case "trim": {
        const r = computeTrim({
          project: p, originals: d.originals, grabbed: d.grabbed, left: d.left, startTime: d.time, time: geo.time(x),
          pps: geo.pps, playhead: s.playhead, snapping: this.snapping, sticky: s.sticky,
        });
        this.overrides = r.clips;
        this.snapLine = r.snapLine;
        const g = r.clips.find((c) => c.id === d.grabbed.id);
        if (g) this.bubble = { text: timecode(g.duration, p.fps, s.timeStyle), x, y: y - 22 };
        this.showTrimFrame(d.grabbed, d.left);
        break;
      }
      case "fade": {
        const c = p.clips.find((o) => o.id === d.clip.id) ?? d.clip;
        const v = fadeValue(p, c, geo.time(x), d.fadeIn);
        sendLive({ op: "update", ids: [c.id], patch: d.fadeIn ? { fadeIn: v } : { fadeOut: v } });
        this.bubble = { text: `${v.toFixed(2)}s`, x, y: y - 22 };
        break;
      }
      case "gain": {
        const value = gainFromNorm(d.startNorm + (y - d.startY) / d.height);
        sendLive({ op: "update", ids: [d.id], patch: { gainDB: value } });
        this.bubble = { text: formatDB(value), x: x + 12, y: y - 22 };
        break;
      }
      case "marker": {
        if (!d.moved && Math.abs(x - d.startX) < 3) return;
        d.moved = true;
        const own = p.markers?.find((m) => m.id === d.id)?.time ?? -1;
        let t = Math.max(0, geo.time(x));
        const targets = [...snapTargets(p, new Set()).filter((v) => Math.abs(v - own) > 1e-9), s.playhead];
        const sn = this.snapping ? snap([t], targets, geo.pps, SNAP_POINT) : undefined;
        if (sn) t += sn.delta;
        const snapped = snapFrame(p, t);
        this.markerOverride = { id: d.id, time: snapped };
        this.readout = snapped;
        break;
      }
      case "rangeEdge": {
        let t = Math.max(0, geo.time(x));
        const sn = this.snapping ? snap([t], [...snapTargets(p, new Set()), s.playhead], geo.pps, SNAP_POINT) : undefined;
        if (sn) t += sn.delta;
        const snapped = snapFrame(p, t);
        this.rangeOverride = { isIn: d.isIn, time: snapped };
        this.readout = snapped;
        break;
      }
      case "marquee": {
        const cx = x + s.view.scrollX, cy = y + s.view.scrollY;
        const box = {
          x: Math.min(d.ox, cx) - s.view.scrollX, y: Math.min(d.oy, cy) - s.view.scrollY,
          w: Math.abs(d.ox - cx), h: Math.abs(d.oy - cy),
        };
        this.marquee = box;
        const ids = unlocked(p, linked(p, new Set([...d.base, ...geo.clipsIn(box)])));
        // A box touching no clips but touching captions picks the captions.
        const boxed = this.shownCaptions(p).filter((b) => {
          const r = geo.captionRect(b.start, b.end);
          return r && r.x < box.x + box.w && box.x < r.x + r.w && r.y < box.y + box.h && box.y < r.y + r.h;
        }).map((b) => b.id);
        const sameAsBase = ids.size === d.base.size && [...ids].every((id) => d.base.has(id));
        if (sameAsBase && boxed.length) {
          useCaptions.setState({ selection: new Set([...boxed, ...d.captionBase]) });
        } else {
          if (useCaptions.getState().selection.size && !sameAsBase) useCaptions.setState({ selection: new Set() });
          if (!setEquals(ids, s.selection)) s.set({ selection: ids });
        }
        break;
      }
      case "captionMarquee": {
        const cx = x + s.view.scrollX, cy = y + s.view.scrollY;
        const box = {
          x: Math.min(d.ox, cx) - s.view.scrollX, y: Math.min(d.oy, cy) - s.view.scrollY,
          w: Math.abs(d.ox - cx), h: Math.abs(d.oy - cy),
        };
        this.marquee = box;
        const ids = new Set(d.base);
        for (const b of this.shownCaptions(p)) {
          const r = geo.captionRect(b.start, b.end);
          if (r && r.x < box.x + box.w && box.x < r.x + r.w && r.y < box.y + box.h && box.y < r.y + r.h) ids.add(b.id);
        }
        useCaptions.setState({ selection: ids });
        break;
      }
    }
    this.invalidate();
  }

  /** While an edge is dragged, the viewer shows the frame it lands on (a video's own, also when its sound's edge is dragged). */
  private showTrimFrame(grabbed: Clip, left: boolean) {
    const p = store().project;
    const video = this.overrides.find((c) => c.id === grabbed.id && c.kind === "video")
      ?? (grabbed.linkID ? this.overrides.find((c) => c.linkID === grabbed.linkID && c.kind === "video") : undefined);
    if (!video?.assetID) return;
    const a = findAsset(p, video.assetID);
    if (!a || a.kind !== "video" || a.duration <= 0) return;
    const t = left ? video.start : Math.max(video.start, clipEnd(video) - 1 / Math.max(1, p.fps));
    const src = video.freeze ? video.sourceStart : sourceTime(video, t);
    const shown = Math.min(Math.max(0, video.reversed ? a.duration - src : src), Math.max(0, a.duration - 0.02));
    engine.showSource({ asset: a.id, time: shown });
  }

  private scrub(x: number) {
    const s = store();
    const geo = this.geometry();
    let t = Math.max(0, geo.time(x));
    const sn = this.snapping ? snap([t], snapTargets(s.project, new Set()), geo.pps, SNAP_POINT) : undefined;
    if (sn) t += sn.delta;
    if (s.playing) {
      engine.pause();
      s.set({ playing: false });
    }
    s.set({ skim: undefined });
    s.seek(t);
    const ph = store().playhead;
    this.showFrame(ph);
    if (s.audioScrubbing) engine.scrubAudio(ph);
    this.readout = ph;
    this.invalidate();
  }

  // ---- Mouse up ----

  async pointerUp(x: number, y: number) {
    this.stopAutoscroll();
    const finished = this.drag;
    this.drag = { kind: "none" };
    const s = store();
    if (finished.kind === "trim") engine.showSource(undefined);
    const moved = this.overrides;
    const duplicating = this.duplicating;
    const marker = this.markerOverride, range = this.rangeOverride;
    this.resetDragVisuals();
    switch (finished.kind) {
      case "move":
        if (!moved.length) break;
        if (duplicating) {
          // ⌥-drag: the clips stay where they were and copies land where they were dropped.
          const copies = freshCopies(moved);
          await s.edit({ op: "place", clips: copies });
          const exists = new Set(store().project.clips.map((c) => c.id));
          store().set({ selection: new Set(copies.map((c) => c.id).filter((id) => exists.has(id))) });
        } else {
          await s.edit({ op: "place", clips: moved });
        }
        break;
      case "trim":
        if (moved.length) await s.edit({ op: "place", clips: moved });
        break;
      case "marker": {
        if (finished.moved && marker) {
          const m = s.project.markers?.find((x) => x.id === marker.id);
          if (m && m.time !== marker.time) await s.edit({ op: "updateMarker", marker: { ...m, time: marker.time } });
        } else if (!finished.moved) {
          this.onOpenMarker?.(finished.id);
        }
        break;
      }
      case "rangeEdge":
        if (range) await s.edit(range.isIn ? { op: "setIn", playhead: range.time } : { op: "setOut", playhead: range.time });
        break;
      case "fade":
      case "gain":
        await commitLive();
        break;
    }
    this.invalidate();
    this.updateHover(x, y);
  }

  private resetDragVisuals() {
    this.overrides = [];
    this.duplicating = false;
    this.snapLine = undefined;
    this.marquee = undefined;
    this.bubble = undefined;
    this.readout = undefined;
    this.markerOverride = undefined;
    this.rangeOverride = undefined;
  }

  /** Esc mid-drag: nothing is committed; live changes are thrown away. */
  cancelDrag() {
    const d = this.drag;
    this.drag = { kind: "none" };
    this.stopAutoscroll();
    if (d.kind === "trim") engine.showSource(undefined);
    if (d.kind === "fade" || d.kind === "gain") {
      flushLive().then(() => api.discardLive()).then(store().apply).catch(() => {});
    }
    this.resetDragVisuals();
    this.invalidate();
  }

  /** Opens the marker panel (set by the Timeline component). */
  onOpenMarker?: (id: Id) => void;

  // ---- Ruler hit testing ----

  private markerHit(x: number, geo: Geometry): Id | undefined {
    const markers = geo.project.markers ?? [];
    const ctx = this.ctx;
    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i];
      const mx = geo.x(m.time);
      const lw = ctx ? markerLabelWidth(ctx, palette(), m.name) : m.name.length * 6;
      if (x >= mx - 4 && x <= mx + 12 + lw) return m.id;
    }
    return undefined;
  }

  private rangeEdgeHit(x: number, geo: Geometry): boolean | undefined {
    const p = geo.project;
    if (p.inPoint !== undefined && Math.abs(x - geo.x(p.inPoint)) < 5) return true;
    if (p.outPoint !== undefined && Math.abs(x - geo.x(p.outPoint)) < 5) return false;
    return undefined;
  }

  /** Where a marker's flag is, in canvas x (for anchoring its panel). */
  markerX(id: Id): number | undefined {
    const m = store().project.markers?.find((x) => x.id === id);
    return m ? this.geometry().x(m.time) : undefined;
  }

  // ---- Autoscroll ----

  private updateAutoscroll(x: number) {
    const margin = 26;
    let v = 0;
    if (x > this.width - margin) v = Math.min(34, (x - (this.width - margin)) * 0.6 + 4);
    else if (x < margin && store().view.scrollX > 0) v = -Math.min(34, (margin - x) * 0.6 + 4);
    this.autoscrollV = v;
    if (v === 0) this.stopAutoscroll();
    else if (this.autoscrollFrame === undefined) {
      this.autoscrollAt = performance.now();
      const tick = (now: number) => {
        // Velocity is points per 1/60 s, whatever the display's refresh rate.
        const steps = Math.min(4, (now - this.autoscrollAt) / (1000 / 60));
        this.autoscrollAt = now;
        const view = store().view;
        store().setView({ scrollX: view.scrollX + this.autoscrollV * steps });
        this.handleDrag(this.last.x, this.last.y);
        this.autoscrollFrame = requestAnimationFrame(tick);
      };
      this.autoscrollFrame = requestAnimationFrame(tick);
    }
  }

  private stopAutoscroll() {
    if (this.autoscrollFrame !== undefined) cancelAnimationFrame(this.autoscrollFrame);
    this.autoscrollFrame = undefined;
    this.autoscrollV = 0;
  }

  // ---- Wheel and pinch ----

  /**
   * ⌥/⌘ (Windows: Ctrl/Alt) + wheel zooms; a trackpad pinch (ctrl+wheel in browsers) zooms; else
   * pan locked to the dominant axis, a plain mouse wheel scrolling sideways (Shift too).
   */
  wheel(e: WheelEvent) {
    const s = store();
    const lineScale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    let dx = e.deltaX * lineScale, dy = e.deltaY * lineScale;
    // A notched mouse wheel moves in big whole steps; a trackpad in small fractional ones.
    const precise = e.deltaMode === 0 && !(Math.abs(dy) >= 50 && Number.isInteger(dy) && dx === 0);
    const pinch = e.ctrlKey && precise && isMac;
    if (pinch) {
      s.zoomBy(1 - dy * 0.01);
      return;
    }
    if (e.altKey || e.metaKey || e.ctrlKey) {
      // Editroom: positive (scrolled-up) deltas zoom in; a wheel notch counts as 8 points.
      const up = -dy / (precise ? 1 : 100 / 8);
      s.zoomBy(wheelZoomFactor(up));
      return;
    }
    if (!precise || e.shiftKey) {
      if (Math.abs(dx) < 0.01) {
        dx = dy;
        dy = 0;
      }
    }
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
    s.setView({ scrollX: s.view.scrollX + dx, scrollY: s.view.scrollY + dy });
  }

  // ---- Drops from the Media panel ----

  /** Payloads from a drag; during dragover only the types are readable, so fall back to what was announced. */
  payloadsFrom(dt: DataTransfer | null, final: boolean): Payload[] | undefined {
    if (!dt) return undefined;
    const types = [...dt.types];
    if (types.includes(TEXT_TYPE)) return [{ type: "text" }];
    if (types.includes(SOLID_TYPE)) return [{ type: "solid" }];
    if (!types.includes(MEDIA_TYPE)) return undefined;
    const raw = dt.getData(MEDIA_TYPE);
    if (raw) {
      try {
        const ids = JSON.parse(raw) as Id[];
        if (Array.isArray(ids) && ids.length) return ids.map((id) => ({ type: "asset", id }));
      } catch { /* malformed payload: fall through */ }
    }
    if (this.dragPayloads?.length) return this.dragPayloads;
    if (final) return undefined;
    // Unreadable until drop: the picked Media items are what's usually being dragged.
    const picked = [...store().mediaSelection];
    return picked.length ? picked.map((id) => ({ type: "asset" as const, id })) : [];
  }

  /** x relative to the canvas (negative = over the track headers). */
  dragOver(x: number, y: number, payloads: Payload[], fileLabel?: string) {
    const s = store();
    const geo = this.geometry();
    const plan = planDrop({
      project: s.project, payloads, lane: geo.lane(y), time: x < 0 ? undefined : geo.time(x), pps: geo.pps,
      playhead: s.playhead, snapping: this.snapping,
    });
    this.dropPlan = plan;
    this.ghosts = plan?.ghosts ?? [];
    this.fileGhostLabel = fileLabel;
    this.snapLine = plan?.snapLine;
    this.invalidate();
    return !!plan;
  }

  clearDrop() {
    this.dropPlan = undefined;
    this.ghosts = [];
    this.fileGhostLabel = undefined;
    this.snapLine = undefined;
    this.invalidate();
  }

  async drop(x: number, y: number, payloads: Payload[]) {
    this.dragOver(x, y, payloads);
    const plan = this.dropPlan;
    this.clearDrop();
    if (!plan || !payloads.length) return;
    const s = store();
    await s.edit({ op: "add", payloads, start: plan.start, videoTrack: plan.videoTrack, audioTrack: plan.audioTrack, snap: true });
    // Only the new timeline clips are picked, so Delete takes them off the timeline, not out of Media.
    store().set({ mediaSelection: new Set() });
  }

  /** Files from the OS dropped on the timeline: imported, then laid end to end from the drop point. */
  async dropFiles(x: number, y: number, paths: string[]) {
    const names = paths.map((p) => p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? p);
    this.dragOver(x, y, [], names.length > 1 ? `${names[0]} + ${names.length - 1} more` : names[0]);
    const plan = this.dropPlan;
    this.clearDrop();
    if (!plan) return;
    const result = await api.importMedia(paths);
    store().apply(result.snapshot);
    const probes = Object.fromEntries(result.probes);
    store().set({ probes: { ...store().probes, ...probes } });
    if (!result.added.length) return;
    // Laid end to end from the drop point, not frame-snapped between files (as Editroom).
    await store().edit({
      op: "add", payloads: result.added.map((id) => ({ type: "asset", id })), start: plan.start,
      videoTrack: plan.videoTrack, audioTrack: plan.audioTrack, snap: false,
    });
    store().set({ mediaSelection: new Set() });
  }

  // ---- Context menus ----

  contextMenu(x: number, y: number, clientX: number, clientY: number) {
    const s = store();
    const p = s.project;
    const geo = this.geometry();
    if (y < RULER) return;
    if (geo.inCaptionRow(y)) return this.captionMenu(x, y, clientX, clientY, geo);
    const h = geo.hit(x, y);
    const items: MenuItem[] = [];
    if (h) {
      const c = h.clip;
      if (!s.selection.has(c.id)) s.set({ selection: linked(p, [c.id]) });
      const t = s.playhead;
      const selection = store().selection;
      items.push({ label: "Split at Playhead", enabled: t > c.start && t < clipEnd(c), action: A.splitAtPlayhead });
      items.push({ label: "Detach Audio", enabled: p.clips.some((x) => selection.has(x.id) && x.linkID), action: A.detachAudio });
      items.push({ label: "Reveal in Media", enabled: !!findAsset(p, c.assetID), action: () => A.revealInMedia(c.id) });
      if (c.kind === "video" || c.kind === "audio") {
        items.push({ label: "Freeze Frame at Playhead", enabled: c.kind === "video" && !c.freeze && t >= c.start && t < clipEnd(c), action: A.freezeFrame });
        items.push({ label: c.reversed ? "Play Forwards" : "Reverse", enabled: !c.freeze, action: A.reverseSelection });
      }
      if (playsSource(c)) {
        items.push({
          label: "Speed",
          submenu: [25, 50, 100, 200, 400, 800, 1600, 3000].map((pct) => ({
            label: `${pct}%`, checked: Math.abs(c.speed * 100 - pct) < 0.5, action: () => A.setSpeed(pct / 100),
          })),
        });
      }
      if (c.kind !== "audio") {
        const transitionMenu = (label: string, into: Clip): MenuItem => ({
          label,
          submenu: [
            { label: "None", checked: !into.transitionIn, action: () => A.setTransition(into.id, null) },
            "separator",
            ...(["dissolve", "dipToBlack", "wipe"] as TransitionKind[]).map((kind) => ({
              label: kind === "dissolve" ? "Dissolve" : kind === "dipToBlack" ? "Dip to Black" : "Wipe",
              checked: into.transitionIn?.kind === kind,
              action: () => A.setTransition(into.id, { kind, duration: into.transitionIn?.duration ?? 0.5 }),
            })),
          ],
        });
        if (previousTouching(p, c)) items.push(transitionMenu("Transition In", c));
        const next = nextTouching(p, c);
        if (next) items.push(transitionMenu("Transition Out", next));
      }
      if (c.kind === "audio") items.push({ label: "Even Out Levels", action: A.evenOutLevels });
      if (A.captionTargets(p, selection).length) {
        items.push(A.hasCaptions(p, selection)
          ? { label: "Remove Captions", action: () => A.removeCaptions() }
          : { label: "Add Captions", action: A.addCaptions });
      }
      if (c.fadeIn > 0 || c.fadeOut > 0) items.push({ label: "Remove Fades", action: A.removeFades });
      if (c.kind !== "audio") {
        const count = p.clips.filter((x) => selection.has(x.id) && x.kind !== "audio").length;
        items.push("separator",
          { label: "Copy Grade", enabled: A.canCopyGrade(), action: A.copyGrade },
          { label: count > 1 ? `Paste Grade to ${count} Clips` : "Paste Grade", enabled: A.canPasteGrade(), action: A.pasteGrade });
      }
      if (c.kind === "video" && c.assetID && findAsset(p, c.assetID)) {
        const id = c.assetID;
        items.push("separator", { label: "Match Sequence to Clip", enabled: !A.sequenceMatches(p, id), action: () => A.matchSequence(id) });
      }
      items.push("separator", { label: "Delete", action: () => A.deleteClips(false) }, { label: "Ripple Delete", action: () => A.deleteClips(true) });
    } else {
      const lane = geo.lane(y);
      if (lane.kind === "track" && !lane.track.locked) {
        const t = geo.time(x), track = lane.track.id;
        items.push({ label: "Delete Gap", enabled: !!A.gapAt(p, track, t), action: () => A.deleteGap(track, t) });
        items.push({ label: "Close All Gaps on Track", action: () => A.closeAllGaps([track]) }, "separator");
      }
      items.push({ label: "Add Video Track", action: () => A.addTrack("video") }, { label: "Add Audio Track", action: () => A.addTrack("audio") });
      if (lane.kind === "track" && (lane.track.kind === "video" ? p.videoTracks : p.audioTracks).length > 1) {
        const id = lane.track.id;
        items.push("separator", { label: "Delete Track", action: () => A.removeTrack(id) });
      }
    }
    this.invalidate();
    openMenu(items, clientX, clientY);
  }

  private captionMenu(x: number, y: number, clientX: number, clientY: number, geo: Geometry) {
    const s = store();
    const blocks = this.shownCaptions(s.project);
    const hit = blocks.find((b) => {
      const r = geo.captionRect(b.start, b.end);
      return r && x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y && y <= r.y + r.h;
    });
    const items: MenuItem[] = [];
    if (hit) {
      if (!useCaptions.getState().selection.has(hit.id)) useCaptions.setState({ selection: new Set([hit.id]) });
      const picked = [...useCaptions.getState().selection];
      const provider = captionProvider();
      items.push({ label: "Edit Caption", enabled: !!provider?.edit, action: () => { s.seek((hit.start + hit.end) / 2); provider?.edit?.(hit); } });
      items.push({ label: picked.length > 1 ? "Delete Captions" : "Delete Caption", enabled: !!provider?.remove, action: () => provider?.remove?.(picked) });
      items.push({ label: "Remove Captions from Clip", action: () => A.removeCaptions([hit.clipID]) }, "separator");
    }
    const hidden = s.project.captions?.hidden ?? false;
    items.push({ label: hidden ? "Show Captions" : "Hide Captions", action: () => s.edit({ op: "setCaptionsHidden", hidden: !hidden }) });
    items.push({ label: "Delete Caption Track", action: () => s.edit({ op: "removeCaptionTrack" }) });
    this.invalidate();
    openMenu(items, clientX, clientY);
  }

  // ---- Markers (panel) ----

  updateMarker(m: Marker) {
    sendLive({ op: "updateMarker", marker: m });
  }

  /** Locked clips are never hit; exposed for tests. */
  isHittable(c: Clip) { return !isLocked(store().project, c.trackID); }
}

function setEquals<T>(a: Set<T>, b: Set<T>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** The one timeline in the window (for the window-wide file drop catcher and tests). */
export const timeline = new TimelineController();
