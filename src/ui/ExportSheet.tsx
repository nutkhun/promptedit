// The export sheet (docs/spec/04-ui.md §1.7): name, folder, range, format, resolution, shape (with a
// draggable crop), codec, quality and loudness on the left; a preview, output size and file-size
// estimate on the right. Export queues a background job (title-bar pill) and closes the sheet.
// Beyond Editroom's MP4 and WAV: ProRes Video (a MOV; the codec menu picks the ProRes) and MP3 Audio
// (with a bit rate), offered when the bundled FFmpeg has their encoders.

import { useEffect, useRef, useState } from "react";
import { call } from "../api";
import { engine } from "../engine";
import { backend, type Encoders } from "../engine/backend";
import type { Snapshot } from "../model";
import { store, useStore } from "../store";
import { playRange, projectDuration, shortTime } from "../timing";
import { showAlert } from "./Alerts";
import { PillButton } from "./buttons";
import { Glyph } from "./icons";
import { openMenu, SEP, type MenuItem } from "./menu";
import { queueExport } from "./export/queue";
import {
  crops, cropWindow, defaultSettings, engineOptions, estimatedSize, extension, FORMATS, formatLabel, isVideo as hasPicture, kindLabel,
  LOUDNESS, loudnessLabel, MP3_RATES, PRORES, proresLabel, renderSize, resolutions, SHAPES, type ExportSettings, type Format,
} from "./export/settings";
import { dirName, pickFolder } from "./shell/files";
import * as playback from "./shell/playback";
import "./export/export.css";

const PREVIEW_W = 388;
const PREVIEW_H = Math.round((PREVIEW_W * 9) / 16);

/** "4.2s", "18s" or "m:ss": the range readout's length. */
const rangeLength = (d: number) => (d < 10 ? `${d.toFixed(1)}s` : d < 60 ? `${Math.round(d)}s` : shortTime(d));
const fpsLabel = (fps: number) => `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`;

interface Dirs { home?: string; desktop?: string }

export function ExportSheet() {
  const project = useStore((s) => s.project);
  const title = useStore((s) => s.title);
  const [settings, setSettings] = useState<ExportSettings>(() => defaultSettings(store().project));
  const [name, setName] = useState(() => store().project.exportName ?? store().title);
  const [folder, setFolder] = useState<string>("");
  const [dirs, setDirs] = useState<Dirs>({});
  const [failure, setFailure] = useState<string>();
  /** Undefined until known (everything is offered meanwhile; the export itself says if it can't). */
  const [encoders, setEncoders] = useState<Encoders>();
  const nameInput = useRef<HTMLInputElement>(null);
  const update = (p: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...p }));
  const close = () => store().set({ exportOpen: false });

  // Where it goes: last export folder if it's still there, else beside the project file, else the Desktop.
  useEffect(() => {
    playback.pause();
    backend.exportEncoders().then(setEncoders, () => {});
    (async () => {
      const d = await call<Dirs>("user_dirs").catch(() => ({} as Dirs));
      setDirs(d);
      const p = store().project;
      const last = p.exportDir && (await call<boolean>("path_exists", { path: p.exportDir }).catch(() => false)) ? p.exportDir : undefined;
      const file = store().file;
      setFolder(last ?? (file ? dirName(file) : d.desktop ?? d.home ?? ""));
    })();
  }, []);

  const range = playRange(project);
  const isVideo = hasPicture(settings.format);
  const size = renderSize(settings, project);
  const duration = projectDuration(project);

  const start = async () => {
    playback.pause();
    let clean = name.trim().replace(/\//g, "-");
    if (!clean) clean = title;
    setName(clean);
    const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
    const file = `${clean}.${extension(settings)}`;
    const path = `${folder.replace(/[\\/]+$/, "")}${sep}${file}`;
    if (await call<boolean>("path_exists", { path }).catch(() => false)) {
      const r = await showAlert({
        title: `Replace “${file}”?`,
        text: `A file with this name already exists in ${folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}.`,
        buttons: ["Replace", "Cancel"],
      });
      if (r !== 0) return;
    }
    await store().commitLive();
    const p = store().project;
    if (!isVideo && !p.clips.some((c) => c.kind === "audio")) {
      setFailure("There's no audio on the timeline.");
      return;
    }
    try { store().apply(await call<Snapshot>("set_export_target", { name: clean, dir: folder })); } catch { /* not remembered */ }
    queueExport(file, kindLabel(settings, p), engineOptions(settings, p, path));
    close();
  };

  // Esc cancels, Return exports (when no menu or alert is up).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".pe-menu, .pe-alert")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Enter" && duration > 0) { e.preventDefault(); e.stopPropagation(); void start(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const menu = (items: MenuItem[]) => (e: React.MouseEvent<HTMLElement>) =>
    openMenu(items, { anchor: e.currentTarget.getBoundingClientRect() });
  const home = dirs.home;
  const shownFolder = home && folder.startsWith(home) ? "~" + folder.slice(home.length) : folder;
  const resList = resolutions(settings, project);
  const available = (f: Format) => !encoders || (f === "mov" ? encoders.prores != null : f === "mp3" ? encoders.mp3 : true);
  const formatItem = ([f, label]: [Format, string]): MenuItem => ({
    label, checked: settings.format === f, enabled: available(f), action: () => update({ format: f }),
  });

  return (
    <div className="pe-sheet-scrim" data-modal-open onPointerDown={(e) => e.stopPropagation()}>
      <div className="pe-sheet" role="dialog" aria-label="Export">
        <div className="pe-sheet-title">Export</div>
        <div className="pe-sheet-columns">
          <div className="pe-sheet-form">
            <Row label="Filename">
              <div className="pe-field pe-filename" onClick={() => nameInput.current?.focus()}>
                {/* Sized to its text (a hidden copy in the same grid cell), so the extension follows the name. */}
                <span className="autosize" data-value={name || " "}>
                  <input ref={nameInput} value={name} spellCheck={false} size={1} onChange={(e) => setName(e.target.value)} />
                </span>
                <span className="ext">.{extension(settings)}</span>
              </div>
            </Row>
            <Row label="Location">
              <button type="button" className="pe-field pe-folder" title="Choose where exports are saved"
                onClick={async () => { const f = await pickFolder(folder); if (f) setFolder(f); }}>
                <span className="path">{shownFolder || "Choose…"}</span>
                <Glyph symbol="folder" size={12} weight="regular" />
              </button>
            </Row>
            {range && (
              <Row label="Range">
                <Menu label={settings.rangeOnly ? `In to out · ${rangeLength(range[1] - range[0])}` : "Whole timeline"} onOpen={menu([
                  { label: `In to out · ${rangeLength(range[1] - range[0])}`, checked: settings.rangeOnly, action: () => update({ rangeOnly: true }) },
                  { label: "Whole timeline", checked: !settings.rangeOnly, action: () => update({ rangeOnly: false }) },
                ])} />
              </Row>
            )}
            <Row label="Format">
              <Menu label={formatLabel(settings.format)} symbol={isVideo ? "film" : "waveform"} accent={isVideo} onOpen={menu([
                ...FORMATS.filter(([f]) => hasPicture(f)).map(formatItem), SEP, ...FORMATS.filter(([f]) => !hasPicture(f)).map(formatItem),
              ])} />
            </Row>
            {isVideo && (
              <>
                <Row label="Resolution">
                  <Menu label={(resList.find(([, h]) => h === settings.height) ?? resList[0])[0]} onOpen={menu(
                    resList.map(([label, h]) => ({ label, checked: h === settings.height, action: () => update({ height: h }) })),
                  )} />
                </Row>
                <Row label="Shape">
                  <Menu label={SHAPES.find(([s]) => s === settings.shape)![1]} onOpen={menu(
                    SHAPES.map(([s, label]) => ({ label, checked: s === settings.shape, action: () => update({ shape: s, reframe: { x: 0.5, y: 0.5 } }) })),
                  )} />
                </Row>
                {settings.format === "mov" ? (
                  // The ProRes is the quality: no separate Quality row.
                  <Row label="Codec">
                    <Menu label={proresLabel(settings.prores)} onOpen={menu(
                      PRORES.map(([v, label]) => ({ label, checked: settings.prores === v, action: () => update({ prores: v }) })),
                    )} />
                  </Row>
                ) : (
                  <>
                    <Row label="Codec">
                      <Menu label={settings.codec === "hevc" ? "HEVC" : "H.264"} onOpen={menu([
                        { label: "H.264", checked: settings.codec === "h264", action: () => update({ codec: "h264" }) },
                        { label: "HEVC", checked: settings.codec === "hevc", action: () => update({ codec: "hevc" }) },
                      ])} />
                    </Row>
                    <Row label="Quality">
                      <Menu label={settings.quality === "high" ? "High" : "Web"} onOpen={menu([
                        { label: "High", checked: settings.quality === "high", action: () => update({ quality: "high" }) },
                        { label: "Web", checked: settings.quality === "web", action: () => update({ quality: "web" }) },
                      ])} />
                    </Row>
                  </>
                )}
              </>
            )}
            {settings.format === "mp3" && (
              <Row label="Bit rate">
                <Menu label={`${settings.mp3Kbps} kbps`} onOpen={menu(
                  MP3_RATES.map((k) => ({ label: `${k} kbps`, checked: settings.mp3Kbps === k, action: () => update({ mp3Kbps: k }) })),
                )} />
              </Row>
            )}
            <Row label="Audio">
              <Menu label={isVideo && !settings.includeAudio ? "No audio" : loudnessLabel(settings.loudness)} onOpen={menu([
                ...(isVideo ? [{ label: "No audio", checked: !settings.includeAudio, action: () => update({ includeAudio: false }) }, SEP] : []),
                ...LOUDNESS.map(([label, v]): MenuItem => ({
                  label, checked: (settings.includeAudio || !isVideo) && settings.loudness === v, action: () => update({ includeAudio: true, loudness: v }),
                })),
              ])} />
            </Row>
          </div>
          <div className="pe-sheet-divider" />
          <div className="pe-sheet-summary">
            <PreviewBox settings={settings} setReframe={(r) => update({ reframe: r })} />
            <div className="pe-stats">
              {isVideo ? (
                <>
                  <Stat symbol="display" text={`${size.width} × ${size.height}`} />
                  <span className="sep" />
                  <Stat text={fpsLabel(project.fps)} />
                </>
              ) : (
                <Stat symbol="waveform" text={settings.format === "mp3" ? `48 kHz · ${settings.mp3Kbps} kbps` : "48 kHz · 24-bit"} />
              )}
              <span className="sep" />
              <Stat symbol="doc" text={estimatedSize(settings, project)} />
            </div>
          </div>
        </div>
        <div className="pe-sheet-footer">
          {failure && <span className="failure">{failure}</span>}
          <span style={{ flex: 1 }} />
          <PillButton large onClick={close}>Cancel</PillButton>
          <PillButton large prominent disabled={duration <= 0} onClick={() => void start()}>Export</PillButton>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pe-sheet-row">
      <span className="label-text">{label}</span>
      {children}
    </div>
  );
}

function Menu({ label, symbol, accent, onOpen }: { label: string; symbol?: string; accent?: boolean; onOpen: (e: React.MouseEvent<HTMLElement>) => void }) {
  return (
    <button type="button" className="pe-field pe-menu-field" onClick={onOpen}>
      {symbol && <Glyph symbol={symbol} size={11.5} weight="regular" style={{ color: accent ? "var(--accent)" : "var(--sheet-label)" }} />}
      <span className="value">{label}</span>
      <Glyph symbol="chevron.down" size={8.5} weight="bold" style={{ color: "var(--text-dim)" }} />
    </button>
  );
}

function Stat({ symbol, text }: { symbol?: string; text: string }) {
  return (
    <span className="stat">
      {symbol && <Glyph symbol={symbol} size={11.5} weight="regular" />}
      <span>{text}</span>
    </span>
  );
}

/**
 * The preview: the main engine draws into this box's canvas while the sheet is open (the viewer gets it
 * back on close). Click plays and pauses; the bar along the bottom scrubs; a crop dims what's left out
 * and its bright window drags to choose what to keep.
 */
function PreviewBox({ settings, setReframe }: { settings: ExportSettings; setReframe: (r: { x: number; y: number }) => void }) {
  const project = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const playhead = useStore((s) => s.playhead);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  const isVideo = hasPicture(settings.format);
  const aspect = project.width / Math.max(1, project.height);
  const pw = Math.min(PREVIEW_W, PREVIEW_H * aspect), ph = pw / aspect;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !isVideo) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(pw * dpr);
    c.height = Math.round(ph * dpr);
    engine.attachViewer(c);
    engine.showFrame(store().playhead);
    return () => {
      playback.pause();
      engine.attachViewer(document.querySelector<HTMLCanvasElement>(".pe-viewer .pe-canvas"));
      engine.showFrame(store().playhead);
    };
  }, [isVideo, pw, ph]);

  // Progress through what's exported (the in/out range when that's all that goes out).
  const r = settings.rangeOnly ? playRange(project) : undefined;
  const [t0, t1] = r ?? [0, projectDuration(project)];
  const progress = t1 > t0 ? Math.min(1, Math.max(0, (playhead - t0) / (t1 - t0))) : 0;
  const seek = (f: number) => playback.seekTo(t0 + f * (t1 - t0));
  const toggle = () => {
    if (playing) { playback.pause(); return; }
    if (playhead < t0 || playhead >= t1 - 1 / project.fps) playback.seekTo(t0);
    playback.play();
  };

  return (
    <div className={`pe-preview${hover ? " hover" : ""}`} style={{ width: PREVIEW_W, height: PREVIEW_H }}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onClick={toggle} title="Play preview">
      {isVideo ? (
        <div className="picture" style={{ width: pw, height: ph }}>
          <canvas ref={canvas} />
          {crops(settings, project) && <CropOverlay settings={settings} pw={pw} ph={ph} setReframe={setReframe} />}
        </div>
      ) : (
        <Glyph symbol="waveform" size={30} weight="light" style={{ color: "var(--text-faint)" }} />
      )}
      {isVideo && <UpscaleBadge settings={settings} />}
      {(playing || hover) && <ScrubBar progress={progress} onSeek={seek} />}
      {(!playing || hover) && (
        <span className="big-play"><Glyph symbol={playing ? "pause.fill" : "play.fill"} size={26} weight="bold" /></span>
      )}
    </div>
  );
}

/**
 * "Upscaled from 1080p" over the preview when the export is bigger than the sequence: its video is
 * enlarged by the upscaler (sharpened as it's enlarged), not stretched (spec 02-engine §12).
 */
function UpscaleBadge({ settings }: { settings: ExportSettings }) {
  const project = useStore((s) => s.project);
  const size = renderSize(settings, project);
  if (!engine.canUpscale?.() || Math.max(size.width, size.height) <= Math.max(project.width, project.height) + 1) return null;
  return (
    <span className="pe-upscaled">
      <Glyph symbol="arrow.up.left.and.arrow.down.right" size={9.5} weight="semibold" />
      Upscaled from {Math.min(project.width, project.height)}p
    </span>
  );
}

function CropOverlay({ settings, pw, ph, setReframe }: {
  settings: ExportSettings; pw: number; ph: number; setReframe: (r: { x: number; y: number }) => void;
}) {
  const project = useStore((s) => s.project);
  const win = cropWindow(settings, project);
  const ww = win.w * pw, wh = win.h * ph;
  const half = { x: win.w / 2, y: win.h / 2 };
  const cx = Math.min(Math.max(half.x, settings.reframe.x), 1 - half.x);
  const cy = Math.min(Math.max(half.y, settings.reframe.y), 1 - half.y);
  const left = cx * pw - ww / 2, top = cy * ph - wh / 2;
  const drag = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  return (
    <>
      <svg className="crop-dim" width={pw} height={ph} aria-hidden>
        <path fillRule="evenodd" fill="rgba(0,0,0,0.6)" d={`M0 0H${pw}V${ph}H0Z M${left} ${top}h${ww}v${wh}h${-ww}Z`} />
      </svg>
      <div
        className="crop-window"
        style={{ left, top, width: ww, height: wh }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          drag.current = { x: e.clientX, y: e.clientY, sx: cx, sy: cy };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setReframe({
            x: Math.min(Math.max(half.x, d.sx + (e.clientX - d.x) / pw), 1 - half.x),
            y: Math.min(Math.max(half.y, d.sy + (e.clientY - d.y) / ph), 1 - half.y),
          });
        }}
        onPointerUp={() => { drag.current = null; }}
      />
    </>
  );
}

function ScrubBar({ progress, onSeek }: { progress: number; onSeek: (f: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))));
  };
  return (
    <div className="scrub-wrap" onClick={(e) => e.stopPropagation()}>
      <div ref={ref} className="scrub"
        onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); at(e); }}
        onPointerMove={(e) => { if (e.buttons) at(e); }}>
        <span className="track" />
        <span className="fill" style={{ width: `${progress * 100}%` }} />
        <span className="head" style={{ left: `calc(${progress * 100}% - 1px)` }} />
      </div>
    </div>
  );
}
