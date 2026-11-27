// Draws the timeline canvas: lanes, clips (filmstrips, waveforms, titles, fades, gain lines),
// transitions, guides, the ruler with markers and in/out, and value bubbles
// (docs/spec/04-ui.md §2.2, §2.6, §3.3, §3.11, §3.14; Editroom's TimelineCanvas.draw).

import { MARKER_HEX } from "../model";
import type { Clip, ColorGrade, Id, MediaAsset, Project } from "../model";
import {
  applyCurve, asset as findAsset, clipEnd, dbToLinear, formatDB, isLocked, linked, playRange, playsSource,
  previousTouching, sourceTime, timecode, transitionSpan,
} from "../timing";
import type { TimeStyle } from "../timing";
import { RULER, ZONE, band } from "./layout";
import { gainNorm } from "./edits";
import { Geometry } from "./geometry";
import type { Rect, Zone } from "./geometry";
import { FLAT, blend } from "./palette";
import type { Palette } from "./palette";
import { rulerLabel, rulerStep } from "./ruler";
import { WAVE_RATE, cachedThumbnail, thumbHeight, thumbnail, waveform } from "./media";
import type { CaptionBlock } from "./captions";

export interface Scene {
  geo: Geometry;
  width: number;
  height: number;
  dpr: number;
  palette: Palette;
  selection: Set<Id>;
  thumbnails: boolean;
  timeStyle: TimeStyle;
  /** Clips being dragged/trimmed, drawn lifted over the timeline. */
  overrides: Clip[];
  /** ⌥-drag: the originals stay drawn where they are. */
  duplicating: boolean;
  ghosts: Clip[];
  fileGhostLabel?: string;
  hover?: { id: Id; zone: Zone };
  trimming?: { ids: Set<Id>; left: boolean };
  cut?: { id: Id; time: number };
  snapLine?: number;
  marquee?: Rect;
  bubble?: { text: string; x: number; y: number };
  /** Time shown beside the playhead flag (scrub, marker and range drags). */
  readout?: number;
  skim?: number;
  captions: CaptionBlock[];
  captionSelection: Set<string>;
  captionsWaiting: boolean;
}

const LABEL_FONT = (p: Palette) => `600 10.5px ${p.font}`;

// ---- Entry point ----

export function drawTimeline(ctx: CanvasRenderingContext2D, s: Scene) {
  const { geo, width: W, height: H, palette: pal } = s;
  const p = geo.project;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);

  // Lanes
  for (const row of geo.layout.rows) {
    const y = RULER + row.y - geo.view.scrollY;
    if (y + row.height <= RULER || y >= H) continue;
    const t = row.track;
    const off = t.locked || (t.kind === "video" ? t.hidden : !audible(p, t));
    ctx.fillStyle = off ? pal.laneOff : pal.lane;
    ctx.fillRect(0, y, W, row.height);
  }

  // The caption track
  if (geo.layout.captionY !== undefined) {
    const y = RULER + geo.layout.captionY - geo.view.scrollY;
    if (y + 30 > RULER && y < H) {
      const hidden = p.captions?.hidden ?? false;
      ctx.fillStyle = hidden ? pal.laneOff : pal.lane;
      ctx.fillRect(0, y, W, 30);
      drawCaptions(ctx, s, { x: 0, y, w: W, h: 30 }, hidden);
    }
  }

  // An empty timeline says how to fill it, across V1.
  if (!p.clips.length && !s.ghosts.length && p.videoTracks[0]) {
    const b = band(geo.layout, p.videoTracks[0].id);
    if (b) {
      ctx.font = `400 11.5px ${pal.font}`;
      ctx.fillStyle = pal.hint;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText("Drag media here, or double-click it in the library", W / 2, RULER + b.y - geo.view.scrollY + b.height / 2);
      ctx.textAlign = "left";
    }
  }

  // Where a drag will land: new-track zones in accent, target lanes faintly lit.
  const targets = new Set([...s.ghosts, ...s.overrides].map((c) => c.trackID));
  const zones: [boolean, number][] = [
    [[...targets].some((t) => t === NEW_V), geo.layout.videoZoneY], [[...targets].some((t) => t === NEW_A), geo.layout.audioZoneY],
  ];
  for (const [on, zy] of zones) {
    if (!on) continue;
    ctx.fillStyle = withAlpha(pal.accent, 0.1);
    ctx.fillRect(0, RULER + zy - geo.view.scrollY, W, ZONE);
  }
  for (const row of geo.layout.rows) {
    if (!targets.has(row.track.id)) continue;
    ctx.fillStyle = pal.ink(0.035);
    ctx.fillRect(0, RULER + row.y - geo.view.scrollY, W, row.height);
  }

  // Clips: originals (lifted ones hidden unless ⌥-duplicating), dragged ones, then drop ghosts.
  const lifted = s.duplicating ? new Set<Id>() : new Set(s.overrides.map((c) => c.id));
  for (const c of p.clips) if (!lifted.has(c.id)) drawClip(ctx, s, c, isLocked(p, c.trackID) ? 0.45 : 1, false);
  for (const c of s.overrides) drawClip(ctx, s, c, 0.82, false);
  for (const c of s.ghosts) drawClip(ctx, s, c, 0.55, true);

  // Transitions: a hatched block over the stretch each covers.
  for (const b of p.clips) {
    if (!b.transitionIn || lifted.has(b.id)) continue;
    const a = previousTouching(p, b);
    if (!a || lifted.has(a.id)) continue;
    const span = transitionSpan(p, a, b);
    const r = geo.rect(b);
    if (!span || !r) continue;
    const x0 = geo.x(span.start);
    const box = { x: x0, y: r.y + 3, w: Math.max(4, geo.x(span.end) - x0), h: r.h - 6 };
    if (box.x + box.w <= 0 || box.x >= W) continue;
    drawHatch(ctx, box, s.selection.has(b.id));
  }

  // Skim line: what the viewer shows while the playhead stays put.
  if (s.skim !== undefined) {
    const sx = geo.x(s.skim);
    ctx.fillStyle = pal.ink(0.55);
    ctx.fillRect(sx - 0.5, RULER, 1, H - RULER);
    ctx.fillRect(sx - 3, RULER - 6, 6, 6);
  }

  // Cut tool preview through the clip and its linked partners.
  if (s.cut) {
    const group = linked(p, [s.cut.id]);
    const cx = geo.x(s.cut.time);
    ctx.fillStyle = "#FFFFFF";
    for (const c of p.clips) {
      if (!group.has(c.id) || !(s.cut.time > c.start && s.cut.time < clipEnd(c))) continue;
      const r = geo.rect(c);
      if (r) ctx.fillRect(cx - 0.75, r.y, 1.5, r.h);
    }
  }

  // Snap guide: a line spanning the dragged clips ±4, a dot at each end.
  if (s.snapLine !== undefined) {
    const sx = geo.x(s.snapLine);
    const rects = [...s.overrides, ...s.ghosts].map((c) => geo.rect(c)).filter((r): r is Rect => !!r);
    const top = Math.max(RULER, (rects.length ? Math.min(...rects.map((r) => r.y)) : RULER) - 4);
    const bottom = Math.min(H, (rects.length ? Math.max(...rects.map((r) => r.y + r.h)) : H) + 4);
    ctx.fillStyle = pal.ink(0.9);
    ctx.fillRect(sx - 0.5, top, 1, bottom - top);
    for (const y of [top, bottom]) {
      ctx.beginPath();
      ctx.arc(sx, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Marquee
  if (s.marquee) {
    const m = s.marquee;
    ctx.fillStyle = withAlpha(pal.accent, 0.12);
    ctx.fillRect(m.x, m.y, m.w, m.h);
    ctx.strokeStyle = withAlpha(pal.accent, 0.8);
    ctx.lineWidth = 1;
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, Math.max(0, m.w - 1), Math.max(0, m.h - 1));
  }

  // Outside in/out is dimmed; markers run a faint line down through the tracks.
  const range = playRange(p);
  if (range) {
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    const a = geo.x(range[0]), b = geo.x(range[1]);
    if (a > 0) ctx.fillRect(0, RULER, a, H - RULER);
    if (b < W) ctx.fillRect(b, RULER, W - b, H - RULER);
  }
  for (const m of p.markers ?? []) {
    const mx = Math.round(geo.x(m.time));
    if (mx <= -1 || mx >= W + 1) continue;
    ctx.fillStyle = withAlpha(MARKER_HEX[m.tint], 0.45);
    ctx.fillRect(mx, RULER, 1, H - RULER);
  }

  drawRuler(ctx, s);

  // Value bubble (fade length, gain, trim duration)
  if (s.bubble) {
    ctx.font = `600 10.5px ${pal.mono}`;
    const tw = ctx.measureText(s.bubble.text).width;
    const bw = tw + 14, bh = 13 + 6;
    const bx = Math.min(Math.max(4, s.bubble.x - tw / 2 - 7), W - bw - 4);
    const by = Math.max(RULER + 2, s.bubble.y - bh / 2);
    ctx.fillStyle = "rgba(13,13,13,0.92)";
    roundRect(ctx, bx, by, bw, bh, 5);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textBaseline = "middle";
    ctx.fillText(s.bubble.text, bx + 7, by + bh / 2 + 0.5);
  }

  // The playhead's time beside its flag while something drags it.
  if (s.readout !== undefined) {
    ctx.font = `500 10px ${pal.mono}`;
    const text = timecode(s.readout, p.fps, s.timeStyle);
    const tw = ctx.measureText(text).width;
    const rw = tw + 12, rh = 12 + 4;
    let rx = geo.x(s.readout) + 10;
    if (rx + rw > W - 4) rx = geo.x(s.readout) - 10 - rw;
    ctx.fillStyle = pal.accent;
    roundRect(ctx, rx, 4, rw, rh, 4);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textBaseline = "middle";
    ctx.fillText(text, rx + 6, 4 + rh / 2 + 0.5);
  }
}

const NEW_V = "00000000-0000-0000-0000-0000000000A1";
const NEW_A = "00000000-0000-0000-0000-0000000000A2";

function audible(p: Project, t: Project["audioTracks"][number]) {
  if (t.muted) return false;
  return !p.audioTracks.some((x) => x.solo) || t.solo;
}

// ---- Helpers ----

export function withAlpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((v) => v.trim());
    return `rgba(${r},${g},${b},${a})`;
  }
  return color;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const rgbaCSS = (c: { r: number; g: number; b: number; a: number }) =>
  `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

function gradeIsNeutral(g: ColorGrade): boolean {
  const z = (w: { x: number; y: number }) => w.x === 0 && w.y === 0;
  return !g.look && g.exposure === 0 && g.contrast === 0 && g.saturation === 0 && g.temperature === 0 && g.tint === 0
    && z(g.shadows) && z(g.midtones) && z(g.highlights);
}

function lookLabel(look: string): string {
  if (!/[\\/]/.test(look)) return look;
  const base = look.split(/[\\/]/).pop() ?? look;
  return base.replace(/\.[^.]+$/, "");
}

/** Pictures fill the tile (aspect fill), clipped to it. */
function drawCover(ctx: CanvasRenderingContext2D, img: ImageBitmap, x: number, y: number, w: number, h: number) {
  const iw = img.width, ih = img.height;
  if (!iw || !ih || w <= 0 || h <= 0) return;
  const sc = Math.max(w / iw, h / ih);
  const sw = w / sc, sh = h / sc;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

// ---- Clips ----

function drawClip(ctx: CanvasRenderingContext2D, s: Scene, c: Clip, alpha: number, ghost: boolean) {
  const { geo, palette: pal } = s;
  const full = geo.rect(c);
  if (!full) return;
  if (full.x + full.w <= -4 || full.x >= s.width + 4 || full.y + full.h <= RULER || full.y >= s.height) return;
  const r = geo.body(full);
  const p = geo.project;
  const thumbs = s.thumbnails;
  const base = thumbs ? (c.kind === "audio" ? pal.audio : c.kind === "text" || c.kind === "solid" ? pal.textClip : pal.video) : FLAT[c.kind];
  const selected = s.selection.has(c.id) && !ghost;
  const hovered = s.hover?.id === c.id;
  let zone: Zone | undefined = hovered ? s.hover?.zone : undefined;
  // Hovering a selected clip's edge lights that edge on every selected clip (a drag trims them all).
  if (!hovered && s.hover && (s.hover.zone === "left" || s.hover.zone === "right") && s.selection.has(s.hover.id)
    && s.selection.has(c.id) && !isLocked(p, c.trackID)) zone = s.hover.zone;
  if (s.trimming?.ids.has(c.id)) zone = s.trimming.left ? "left" : "right";
  const radius = Math.min(7, r.w / 2);
  const visible = { x0: Math.max(r.x, -2), x1: Math.min(r.x + r.w, s.width + 2) };
  const a = findAsset(p, c.assetID);
  const usesFile = c.kind === "video" || c.kind === "audio" || c.kind === "image";
  const offline = usesFile && !a && !ghost;

  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, r.x, r.y, r.w, r.h, radius);
  ctx.clip();
  ctx.fillStyle = offline ? pal.offline : base;
  ctx.fillRect(r.x, r.y, r.w, r.h);

  if (c.kind === "video" && thumbs && a) drawFilmstrip(ctx, s, c, a, r, visible, alpha);
  else if (c.kind === "image" && thumbs && a) drawStills(ctx, s, c, a, r, visible, alpha);
  else if (c.kind === "audio") drawWaveform(ctx, s, c, r, visible);
  else if (c.kind === "solid") {
    ctx.fillStyle = rgbaCSS(c.color);
    ctx.fillRect(r.x, r.y + r.h - 5, r.w, 5);
  }

  // Title strip
  if (r.w > 26 && r.h > 20) {
    if (thumbs && (c.kind === "video" || c.kind === "image")) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(r.x, r.y, r.w, 17);
    }
    let label = ghost && !c.assetID && (c.kind === "video" || c.kind === "audio") ? (s.fileGhostLabel ?? "") : clipLabel(p, c);
    if (c.freeze) label += "   Freeze";
    else if (Math.abs(c.speed - 1) > 0.001) label += `   ${Math.round(c.speed * 100)}%`;
    if (c.reversed) label += "   Reversed";
    if (c.kind === "audio" && Math.abs(c.gainDB) > 0.05) label += "   " + formatDB(c.gainDB);
    let lx = Math.max(r.x, 0) + 8;
    if (r.w > 36 && c.fadeIn > 0) lx = Math.max(lx, geo.fadeHandleX(c, r, true) + 10);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, Math.max(0, r.w - 16), 18);
    ctx.clip();
    ctx.font = LABEL_FONT(pal);
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 2.5 * s.dpr;
    ctx.shadowOffsetY = 0.5 * s.dpr;
    ctx.fillText(label, lx, r.y + 3);
    if (c.grade && !gradeIsNeutral(c.grade) && c.kind !== "audio") {
      const gx = lx + ctx.measureText(label).width + 9;
      ctx.shadowColor = "transparent";
      drawGradeWheel(ctx, gx + 4.5, r.y + 9.5, 4.5);
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillText(c.grade.look ? lookLabel(c.grade.look) : "Graded", gx + 13, r.y + 3);
    }
    ctx.restore();
  }

  // Fades: a dark shade above the curve and a thin white curve line.
  for (const isIn of [true, false]) {
    const w = (isIn ? c.fadeIn : c.fadeOut) * geo.pps;
    if (w <= 0.5) continue;
    const curve = isIn ? c.fadeInCurve : c.fadeOutCurve;
    const edge = isIn ? r.x : r.x + r.w;
    const dir = isIn ? 1 : -1;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const n = i / 24;
      const px = edge + dir * n * w, py = r.y + r.h - applyCurve(curve, n) * r.h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.save();
    ctx.lineTo(edge, r.y);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const n = i / 24;
      const px = edge + dir * n * w, py = r.y + r.h - applyCurve(curve, n) * r.h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Gain line
  if (c.kind === "audio" && r.w > 8) {
    const gy = Math.round(r.y + gainNorm(c.gainDB) * r.h) + 0.5;
    const hot = zone === "gain";
    ctx.strokeStyle = `rgba(255,255,255,${hot ? 1 : 0.5})`;
    ctx.lineWidth = hot ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(r.x, gy);
    ctx.lineTo(r.x + r.w, gy);
    ctx.stroke();
  }

  // Lit trim edge
  if (zone === "left" || zone === "right") {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(zone === "left" ? r.x : r.x + r.w - 3.5, r.y, 3.5, r.h);
  }
  ctx.restore();

  // Border
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, radius);
  if (selected) {
    ctx.strokeStyle = pal.selection;
    ctx.lineWidth = 1.5;
  } else if (hovered) {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
  } else {
    ctx.strokeStyle = thumbs ? pal.clipStroke : blend(base, "#FFFFFF", 0.18);
    ctx.lineWidth = 1;
  }
  ctx.stroke();

  // Fade dots (only for fades that are set); the longer fade's dot draws last, on top.
  if (r.w > 36 && alpha === 1 && (c.fadeIn > 0 || c.fadeOut > 0)) {
    for (const isIn of c.fadeIn > c.fadeOut ? [false, true] : [true, false]) {
      if ((isIn ? c.fadeIn : c.fadeOut) <= 0) continue;
      const hot = zone === (isIn ? "fadeIn" : "fadeOut");
      const hx = geo.fadeHandleX(c, r, isIn);
      const rad = hot ? 5.5 : 4;
      ctx.beginPath();
      ctx.arc(hx, r.y + 8, rad, 0, Math.PI * 2);
      ctx.fillStyle = hot ? pal.accent : "#FFFFFF";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function clipLabel(p: Project, c: Clip): string {
  if (c.kind === "text") return c.text.string.replace(/\n/g, " ") || "Text";
  if (c.kind === "solid") return "Solid";
  return findAsset(p, c.assetID)?.name ?? "Missing";
}

function drawGradeWheel(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  const hues = [[1, 0.35, 0.29], [1, 0.82, 0.29], [0.35, 0.86, 0.42], [0.29, 0.72, 1], [0.6, 0.42, 1], [1, 0.35, 0.6]];
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 0.75, 0, Math.PI * 2);
  ctx.fill();
  hues.forEach(([r, g, b], i) => {
    const a0 = (i / hues.length) * 2 * Math.PI - Math.PI / 2;
    const a1 = ((i + 1) / hues.length) * 2 * Math.PI - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, a0, a1 + 0.02);
    ctx.closePath();
    ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    ctx.fill();
  });
}

function drawHatch(ctx: CanvasRenderingContext2D, r: Rect, selected: boolean) {
  ctx.save();
  roundRect(ctx, r.x, r.y, r.w, r.h, 4);
  ctx.clip();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let sx = r.x - r.h; sx < r.x + r.w; sx += 7) {
    ctx.moveTo(sx, r.y + r.h);
    ctx.lineTo(sx + r.h, r.y);
  }
  ctx.stroke();
  ctx.restore();
  roundRect(ctx, r.x, r.y, r.w, r.h, 4);
  ctx.strokeStyle = `rgba(255,255,255,${selected ? 1 : 0.75})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ---- Filmstrips ----

/** Frames side by side with a 1 pt dark gap; source step = smallest power of two keeping tiles ≥ a thumbnail wide. */
function drawFilmstrip(ctx: CanvasRenderingContext2D, s: Scene, c: Clip, a: MediaAsset, r: Rect, vis: { x0: number; x1: number }, alpha: number) {
  if (vis.x1 <= vis.x0 || a.height <= 0) return;
  const pps = s.geo.pps;
  const aspect = a.width / a.height;
  const tileW = Math.max(24, r.h * aspect);
  const th = thumbHeight(r.h * s.dpr);
  const backwards = c.reversed === true;
  const clampSrc = (t: number) => Math.min(Math.max(0, t), Math.max(0, a.duration - 0.05));
  ctx.save();
  ctx.globalAlpha = alpha * 0.88;
  let drawn = 0;
  if (c.ramp && playsSource(c)) {
    // Ramped: evenly spaced tiles from the clip's start, each showing the footage at that moment,
    // taken from a fixed grid of source times; a neighbour on the grid stands in until it loads.
    const average = Math.max(0.01, (sourceTime(c, clipEnd(c)) - c.sourceStart) / Math.max(1e-6, c.duration));
    let grid = 1 / 16;
    while ((grid / average) * pps < tileW && grid < 16384) grid *= 2;
    const at = (k: number) => clampSrc(backwards ? a.duration - k * grid : k * grid);
    let x = r.x + Math.floor(Math.max(0, vis.x0 - r.x) / tileW) * tileW;
    while (x < Math.min(r.x + r.w, vis.x1) && drawn < 240) {
      const t = c.start + (x + tileW / 2 - r.x) / pps;
      const k = Math.round(sourceTime(c, Math.min(t, clipEnd(c))) / grid);
      let img = thumbnail(a.id, at(k), th);
      for (const d of [1, -1, 2, -2]) img = img ?? cachedThumbnail(a.id, at(k + d), th);
      if (img) drawCover(ctx, img, x, r.y, Math.max(1, tileW - 1), r.h);
      x += tileW;
      drawn++;
    }
    ctx.restore();
    return;
  }
  let step = 1 / 16;
  while ((step / c.speed) * pps < tileW && step < 16384) step *= 2;
  const srcAt = (px: number) => c.sourceStart + ((px - r.x) / pps) * c.speed;
  let k = Math.floor(srcAt(vis.x0) / step);
  const kEnd = Math.ceil(srcAt(vis.x1) / step);
  const w = (step / c.speed) * pps;
  while (k <= kEnd && drawn < 240) {
    const ts = k * step;
    const tx = r.x + ((ts - c.sourceStart) / c.speed) * pps;
    const sample = c.freeze ? c.sourceStart : clampSrc(backwards ? a.duration - ts : ts);
    const img = thumbnail(a.id, sample, th);
    if (img) drawCover(ctx, img, tx, r.y, Math.max(1, w - 1), r.h);
    k++;
    drawn++;
  }
  ctx.restore();
}

function drawStills(ctx: CanvasRenderingContext2D, s: Scene, _c: Clip, a: MediaAsset, r: Rect, vis: { x0: number; x1: number }, alpha: number) {
  const img = thumbnail(a.id, 0, thumbHeight(r.h * s.dpr));
  if (!img) return;
  const tileW = Math.max(20, (r.h * img.width) / Math.max(1, img.height));
  let tx = r.x + Math.floor(Math.max(0, vis.x0 - r.x) / tileW) * tileW;
  ctx.save();
  ctx.globalAlpha = alpha * 0.85;
  while (tx < vis.x1) {
    drawCover(ctx, img, tx, r.y, tileW, r.h);
    tx += tileW;
  }
  ctx.restore();
}

// ---- Waveforms ----

/**
 * Average loudness as one filled shape growing up from the clip's bottom (taller = louder), on a
 * 1 pt grid tied to source time so it doesn't shimmer while scrolling; five-sample smoothing.
 */
function drawWaveform(ctx: CanvasRenderingContext2D, s: Scene, c: Clip, r: Rect, vis: { x0: number; x1: number }) {
  if (!c.assetID || vis.x1 <= vis.x0) return;
  const levels = waveform(c.assetID);
  if (!levels || !levels.length) return;
  const top = r.y + 2, base = r.y + r.h - 1;
  if (base - top <= 4) return;
  const room = base - top;
  const pps = s.geo.pps;
  const gain = dbToLinear(c.gainDB);
  const lift = 2, headroom = 0.92, step = 1;
  const secPerPx = (1 / pps) * c.speed;
  const ramped = !!c.ramp && playsSource(c);
  const origin = ramped ? r.x : r.x - c.sourceStart / secPerPx;
  const every = 4, from = vis.x0 - 16;
  const table: number[] = [];
  if (ramped) for (let x = from; x <= vis.x1 + 24; x += every) table.push(sourceTime(c, c.start + (x - r.x) / pps));
  const backwards = c.reversed === true;
  const fileDuration = levels.length / WAVE_RATE;
  const source = (x: number) => {
    let t: number;
    if (!ramped || table.length < 2) t = (x - origin) * secPerPx;
    else {
      const f = (x - from) / every;
      const i = Math.min(Math.max(0, Math.floor(f)), table.length - 2);
      t = table[i] + (table[i + 1] - table[i]) * (f - i);
    }
    return backwards ? fileDuration - t : t;
  };
  const count = levels.length;
  const level = (k: number) => {
    const x = origin + k * step;
    let i0 = Math.floor(source(x) * WAVE_RATE), i1 = Math.floor(source(x + step) * WAVE_RATE);
    if (i1 < i0) [i0, i1] = [i1, i0];
    if (i0 >= count || i1 < 0) return 0;
    const a = Math.max(0, i0), b = Math.min(count - 1, Math.max(i0, i1 - 1));
    if (a > b) return 0;
    const stride = Math.max(1, Math.floor((b - a) / 32));
    let sum = 0, n = 0;
    for (let i = a; i <= b; i += stride) {
      sum += levels[i] * levels[i];
      n++;
    }
    return Math.sqrt(sum / Math.max(1, n));
  };
  const k0 = Math.floor((vis.x0 - origin) / step) - 2;
  const k1 = Math.ceil((vis.x1 - origin) / step) + 2;
  if (k1 <= k0 + 4) return;
  const raw: number[] = [];
  for (let k = k0; k <= k1; k++) raw.push(level(k));
  ctx.beginPath();
  let first = true, lastX = 0;
  for (let j = 2; j < raw.length - 2; j++) {
    const v = (raw[j - 2] + raw[j - 1] + raw[j] + raw[j + 1] + raw[j + 2]) / 5;
    const x = Math.min(Math.max(origin + (k0 + j) * step, vis.x0), vis.x1);
    const h = Math.max(0.75, Math.min(1, v * lift * gain) * room * headroom);
    if (first) {
      ctx.moveTo(x, base);
      first = false;
    }
    ctx.lineTo(x, base - h);
    lastX = x;
  }
  ctx.lineTo(lastX, base);
  ctx.closePath();
  ctx.fillStyle = s.thumbnails ? "rgba(204,204,199,0.7)" : "rgba(224,247,230,0.55)";
  ctx.fill();
}

// ---- Captions ----

function drawCaptions(ctx: CanvasRenderingContext2D, s: Scene, lane: Rect, dim: boolean) {
  const { geo, palette: pal } = s;
  if (!s.captions.length) {
    ctx.font = `400 11.5px ${pal.font}`;
    ctx.fillStyle = pal.hint;
    ctx.textBaseline = "middle";
    ctx.fillText(s.captionsWaiting ? "Listening for what's said…" : "No speech heard in the captioned clips", 12, lane.y + lane.h / 2);
    return;
  }
  for (const b of s.captions) {
    const full = geo.captionRect(b.start, b.end);
    if (!full || full.x + full.w <= -4 || full.x >= s.width + 4) continue;
    const dx = Math.min(0.5, full.w / 4);
    const r = { x: full.x + dx, y: full.y + 3, w: full.w - 2 * dx, h: full.h - 6 };
    const rad = Math.min(5, r.w / 2);
    ctx.save();
    ctx.globalAlpha = dim ? 0.45 : 1;
    roundRect(ctx, r.x, r.y, r.w, r.h, rad);
    ctx.fillStyle = pal.textClip;
    ctx.fill();
    if (r.w > 18) {
      ctx.clip();
      ctx.font = `500 10.5px ${pal.font}`;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.textBaseline = "middle";
      ctx.fillText(b.text, Math.max(r.x, 0) + 6, r.y + r.h / 2);
    }
    ctx.restore();
    if (s.captionSelection.has(b.id)) {
      roundRect(ctx, r.x, r.y, r.w, r.h, rad);
      ctx.strokeStyle = pal.selection;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ---- Ruler ----

/** Width of a marker's name label (also its hit zone). */
export function markerLabelWidth(ctx: CanvasRenderingContext2D, pal: Palette, name: string) {
  ctx.font = `500 10px ${pal.mono}`;
  return ctx.measureText(name).width;
}

function drawRuler(ctx: CanvasRenderingContext2D, s: Scene) {
  const { geo, palette: pal, width: W } = s;
  const p = geo.project;
  ctx.fillStyle = pal.panel;
  ctx.fillRect(0, 0, W, RULER);
  ctx.fillStyle = pal.stroke;
  ctx.fillRect(0, RULER - 1, W, 1);

  const step = rulerStep(geo.pps, p.fps);
  const t0 = geo.time(0), t1 = geo.time(W);
  ctx.font = `400 10px ${pal.mono}`;
  ctx.textBaseline = "top";
  for (let k = Math.floor(t0 / step.major); k * step.major <= t1; k++) {
    const t = k * step.major;
    const px = geo.x(t);
    if (t >= 0) {
      ctx.fillStyle = pal.ink(0.28);
      ctx.fillRect(Math.round(px), RULER - 9, 1, 8);
      ctx.fillStyle = pal.textFaint;
      ctx.fillText(rulerLabel(t, step, p.fps, s.timeStyle), px + 5, 6);
    }
    if (step.subdivisions > 1) {
      ctx.fillStyle = pal.ink(0.13);
      for (let j = 1; j < step.subdivisions; j++) {
        const mt = t + (step.major * j) / step.subdivisions;
        if (mt >= 0) ctx.fillRect(Math.round(geo.x(mt)), RULER - 5, 1, 4);
      }
    }
  }

  // Markers: a coloured flag with the name beside it.
  for (const m of p.markers ?? []) {
    const mx = Math.round(geo.x(m.time));
    const lw = markerLabelWidth(ctx, pal, m.name);
    if (mx + 12 + lw <= 0 || mx >= W + 1) continue;
    const color = MARKER_HEX[m.tint];
    ctx.fillStyle = pal.panel;
    ctx.fillRect(mx + 1, 3, lw + 14, RULER - 5);
    ctx.fillStyle = color;
    ctx.fillRect(mx, 4, 1, RULER - 5);
    ctx.beginPath();
    ctx.moveTo(mx, 4);
    ctx.lineTo(mx + 8, 4);
    ctx.lineTo(mx + 6, 8);
    ctx.lineTo(mx + 8, 12);
    ctx.lineTo(mx, 12);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = withAlpha(pal.text, 0.92);
    ctx.textBaseline = "top";
    ctx.fillText(m.name, mx + 11, 6);
  }

  // In/out: the stretch between is lit, with a bracket at each end (feet pointing inward).
  if (p.inPoint !== undefined || p.outPoint !== undefined) {
    const range = playRange(p);
    if (range) {
      ctx.fillStyle = pal.ink(0.06);
      ctx.fillRect(geo.x(range[0]), 0, geo.x(range[1]) - geo.x(range[0]), RULER - 1);
    }
    ctx.fillStyle = pal.ink(1);
    for (const [edge, inward] of [[p.inPoint, 1], [p.outPoint, -1]] as [number | undefined, number][]) {
      if (edge === undefined) continue;
      const ex = Math.round(geo.x(edge));
      ctx.fillRect(ex - 1, 2, 2, RULER - 3);
      const fx = inward > 0 ? ex - 1 : ex - 5;
      ctx.fillRect(fx, 2, 6, 2);
      ctx.fillRect(fx, RULER - 3, 6, 2);
    }
  }
}
