// Track headers beside the canvas (docs/spec/04-ui.md §1.6): labels, show/hide, mute, solo, lock,
// the gain pill and level meter, the caption header, the add-track zones and the header menus.

import { useEffect, useRef, useState } from "react";
import type { Id, Track, TrackPatch } from "../model";
import { useStore } from "../store";
import { formatDB } from "../timing";
import { CAPTION_ROW, HEADER_WIDTH, RULER, ZONE, makeLayout, trackLabel, trackOff } from "./layout";
import { LineIcon } from "./icons";
import { openMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { addTrack, duck, removeTrack } from "./actions";
import { commitLive, sendLive } from "./live";
import { useCaptions } from "./captions";
import { EMPTY_READING, METER_FLOOR, useMeters } from "./meters";

const setTrack = (id: Id, patch: TrackPatch) => useStore.getState().edit({ op: "setTrack", id, patch });

function MiniKey({ icon, on, help, onClick }: { icon: string; on: boolean; help: string; onClick: () => void }) {
  return (
    <button className={`tl-minikey${on ? " on" : ""}`} title={help} onClick={onClick}>
      <LineIcon name={icon} size={9.5} />
    </button>
  );
}

function LetterToggle({ letter, on, help, onClick }: { letter: string; on: boolean; help: string; onClick: () => void }) {
  return <button className={`tl-minikey tl-letter${on ? " on" : ""}`} title={help} onClick={onClick}>{letter}</button>;
}

/** Track level: drag sideways (0.15 dB/pt, one undo step), or click to type (Return/blur commits, Esc cancels). */
export function GainPill({ track }: { track: Track }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const db = track.gainDB;

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing || e.button !== 0) return;
    const startX = e.clientX, startDB = db;
    let moved = false;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) {
        moved = true;
        setDragging(true);
      }
      const value = Math.min(12, Math.max(-60, Math.round((startDB + dx * 0.15) * 10) / 10));
      sendLive({ op: "setTrack", id: track.id, patch: { gainDB: value } });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (moved) {
        setDragging(false);
        commitLive();
      } else {
        setText(db <= -59.5 ? "-60" : db.toFixed(1));
        setEditing(true);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const commit = () => {
    const cleaned = text.replace(/,/g, ".").replace(/−/g, "-").replace(/[^0-9.-]/g, "");
    const v = parseFloat(cleaned);
    if (Number.isFinite(v)) setTrack(track.id, { gainDB: Math.min(12, Math.max(-60, Math.round(v * 10) / 10)) });
    setEditing(false);
  };

  return (
    <div className={`tl-gain${editing ? " editing" : ""}${dragging ? " dragging" : ""}${Math.abs(db) > 0.05 ? " set" : ""}`}
      title="Track level — drag, or click to type" onPointerDown={onPointerDown}>
      {editing ? (
        <input ref={input} value={text} autoFocus onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => editing && commit()} />
      ) : formatDB(db).replace(" dB", "")}
    </div>
  );
}

const meterColor = (db: number) => (db > -3 ? "var(--alert)" : db > -12 ? "var(--snap)" : "var(--meter-low)");

/** Vertical segmented meter: top segment is the clip light; the rest span −60…0 dB; one holds the peak. */
export function LevelMeter({ track }: { track: Id }) {
  const r = useMeters((s) => s.tracks[track]) ?? EMPTY_READING;
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(40);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const count = Math.max(4, Math.floor((height + 1) / 3));
  const span = count - 1;
  const clampI = (v: number) => Math.min(span, Math.max(0, v));
  const lit = Math.floor(clampI(span * ((r.level - METER_FLOOR) / -METER_FLOOR)));
  const peak = Math.floor(clampI(span * ((r.peak - METER_FLOOR) / -METER_FLOOR))) - 1;
  const segments = [];
  for (let i = span - 1; i >= 0; i--) {
    const on = i < lit || (i === peak && r.peak > METER_FLOOR + 0.5);
    segments.push(<div key={i} style={{ background: on ? meterColor(METER_FLOOR * (1 - (i + 1) / span)) : "var(--well)" }} />);
  }
  return (
    <div ref={ref} className="tl-meter" title={r.clipped ? "Clipping" : "Level"}>
      <div style={{ background: r.clipped ? "var(--alert)" : "var(--well)" }} />
      {segments}
    </div>
  );
}

function TrackHeader({ track, index, canDelete }: { track: Track; index: number; canDelete: boolean }) {
  const project = useStore((s) => s.project);
  const off = trackOff(project, track);
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [];
    if (track.kind === "audio") {
      const others = project.audioTracks.map((t, i) => ({ t, i })).filter(({ t }) => t.id !== track.id);
      items.push({
        label: "Duck Under",
        submenu: [
          { label: "None", checked: !track.duckUnder, action: () => duck(track.id, null) },
          "separator",
          ...others.map(({ t, i }) => ({ label: `A${i + 1}`, checked: track.duckUnder === t.id, action: () => duck(track.id, t.id) })),
          "separator",
          ...[-6, -12, -18, -24].map((db) => ({
            label: `Down ${-db} dB`, checked: Math.abs(track.duckDB - db) < 0.01, action: () => duck(track.id, track.duckUnder ?? null, db),
          })),
        ],
      }, "separator");
    }
    items.push({ label: "Add Video Track", action: () => addTrack("video") }, { label: "Add Audio Track", action: () => addTrack("audio") });
    if (canDelete) items.push("separator", { label: "Delete Track", action: () => removeTrack(track.id) });
    openMenu(items, e.clientX, e.clientY);
  };
  return (
    <div className="tl-header" onContextMenu={menu}>
      <div className={`tl-header-label${off ? " off" : ""}`}>
        {trackLabel(track, index)}
        {track.duckUnder && <span className="tl-duck" title="Ducks under another track">↓</span>}
      </div>
      {track.kind === "audio" ? (
        <>
          <LetterToggle letter="M" on={track.muted} help="Mute" onClick={() => setTrack(track.id, { muted: !track.muted })} />
          <LetterToggle letter="S" on={track.solo} help="Solo" onClick={() => setTrack(track.id, { solo: !track.solo })} />
        </>
      ) : (
        <MiniKey icon={track.hidden ? "eye.slash" : "eye"} on={track.hidden} help={track.hidden ? "Show" : "Hide"}
          onClick={() => setTrack(track.id, { hidden: !track.hidden })} />
      )}
      <MiniKey icon="lock" on={track.locked} help={track.locked ? "Unlock" : "Lock"} onClick={() => setTrack(track.id, { locked: !track.locked })} />
      <div className="tl-spacer" />
      {track.kind === "audio" && (
        <>
          <GainPill track={track} />
          <LevelMeter track={track.id} />
        </>
      )}
    </div>
  );
}

function CaptionHeader() {
  const hidden = useStore((s) => s.project.captions?.hidden ?? false);
  const focused = useCaptions((s) => s.focused || s.selection.size > 0);
  const toggle = () => useStore.getState().edit({ op: "setCaptionsHidden", hidden: !hidden });
  return (
    <div className="tl-header tl-caption-header" title="Captions: click for their style"
      onClick={() => {
        useStore.getState().set({ selection: new Set() });
        useCaptions.setState({ focused: true, selection: new Set() });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu([
          { label: hidden ? "Show Captions" : "Hide Captions", action: toggle },
          "separator",
          { label: "Delete Caption Track", action: () => useStore.getState().edit({ op: "removeCaptionTrack" }) },
        ], e.clientX, e.clientY);
      }}>
      <div className={`tl-header-label${hidden ? " off" : ""}`}>C1</div>
      <span onClick={(e) => e.stopPropagation()}>
        <MiniKey icon={hidden ? "eye.slash" : "eye"} on={hidden} help={hidden ? "Show Captions" : "Hide Captions"} onClick={toggle} />
      </span>
      <span className={`tl-caption-title${focused ? " focused" : ""}`}>Captions</span>
    </div>
  );
}

function AddTrackZone({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="tl-add-track" title={`Add ${label} Track`} onClick={onClick}>
      <span className="tl-add-plus">+</span>
      <span>{label}</span>
    </button>
  );
}

export function TrackHeaders() {
  const project = useStore((s) => s.project);
  const rowHeight = useStore((s) => s.view.rowHeight);
  const scrollY = useStore((s) => s.view.scrollY);
  const layout = makeLayout(project, rowHeight);
  const top = (y: number) => RULER + y - scrollY;
  return (
    <div className="tl-headers" style={{ width: HEADER_WIDTH }}>
      {layout.rows.map((row) => (
        <div key={row.track.id} className="tl-header-slot" style={{ top: top(row.y), height: row.height }}>
          <TrackHeader track={row.track} index={row.index}
            canDelete={(row.track.kind === "video" ? project.videoTracks : project.audioTracks).length > 1} />
        </div>
      ))}
      {layout.captionY !== undefined && project.captions && (
        <div className="tl-header-slot" style={{ top: top(layout.captionY), height: CAPTION_ROW }}><CaptionHeader /></div>
      )}
      <div className="tl-header-slot" style={{ top: top(layout.videoZoneY), height: ZONE }}>
        <AddTrackZone label="Video" onClick={() => addTrack("video")} />
      </div>
      <div className="tl-header-slot" style={{ top: top(layout.audioZoneY), height: ZONE }}>
        <AddTrackZone label="Audio" onClick={() => addTrack("audio")} />
      </div>
      {/* Corner above the headers, level with the ruler. */}
      <div className="tl-corner" style={{ height: RULER }} />
    </div>
  );
}
