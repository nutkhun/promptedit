// The marker popover (docs/spec/04-ui.md §1.11): name, colour, delete, and every marker to jump to.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { MARKER_HEX } from "../model";
import type { Id, MarkerTint } from "../model";
import { useStore } from "../store";
import { timecode } from "../timing";
import { engine } from "../engine";
import { LineIcon } from "./icons";
import { commitLive, sendLive } from "./live";

interface PanelState {
  id?: Id;
  /** Window x of the flag and y of the ruler's top, where the panel points. */
  anchor?: { x: number; y: number };
}
export const useMarkerPanel = create<PanelState>(() => ({}));

const TINTS: MarkerTint[] = ["white", "yellow", "green", "blue", "purple", "red"];

/** Opens the panel for a marker (a flag click, or Add Marker on an existing marker). */
export function openMarkerPanel(id: Id, anchor?: { x: number; y: number }) {
  useMarkerPanel.setState({ id, anchor: anchor ?? useMarkerPanel.getState().anchor });
}
export const closeMarkerPanel = () => useMarkerPanel.setState({ id: undefined });

export function MarkerPanel({ locate }: { locate: (id: Id) => { x: number; y: number } | undefined }) {
  const { id } = useMarkerPanel();
  const project = useStore((s) => s.project);
  const timeStyle = useStore((s) => s.timeStyle);
  const marker = project.markers?.find((m) => m.id === id);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setName(marker?.name ?? "");
    field.current?.focus();
    field.current?.select();
  }, [id]);

  // Transient: closes on a click outside, or Esc.
  useEffect(() => {
    if (!id) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) finish();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  });

  if (!id || !marker) return null;
  const at = locate(id);
  if (!at) return null;

  // Typing renames live; each pause in typing is one undo step.
  const rename = (v: string) => {
    setName(v);
    sendLive({ op: "updateMarker", marker: { ...marker, name: v } });
    clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(() => commitLive(), 800);
  };
  function finish() {
    clearTimeout(renameTimer.current);
    commitLive();
    closeMarkerPanel();
  }
  const all = [...(project.markers ?? [])].sort((a, b) => a.time - b.time);
  const left = Math.min(Math.max(8, at.x - 135), window.innerWidth - 278);

  return createPortal(
    <div ref={ref} className="tl-marker-panel" style={{ left, bottom: window.innerHeight - at.y + 6 }}>
      <div className="tl-marker-head">
        <span className="label">Marker</span>
        <span className="tl-marker-time">{timecode(marker.time, project.fps, timeStyle)}</span>
      </div>
      <input ref={field} className="tl-marker-name" placeholder="Name" value={name}
        onChange={(e) => rename(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish();
          if (e.key === "Escape") finish();
        }} />
      <div className="tl-marker-tints">
        {TINTS.map((tint) => (
          <button key={tint} className={`tl-marker-tint${marker.tint === tint ? " on" : ""}`} title={tint[0].toUpperCase() + tint.slice(1)}
            onClick={() => useStore.getState().edit({ op: "updateMarker", marker: { ...marker, name, tint } })}>
            <span style={{ background: MARKER_HEX[tint] }} />
          </button>
        ))}
        <div className="tl-spacer" />
        <button className="tl-marker-delete" title="Delete Marker"
          onClick={() => {
            closeMarkerPanel();
            useStore.getState().edit({ op: "removeMarker", id: marker.id });
          }}>
          <LineIcon name="trash" size={12} />
        </button>
      </div>
      {all.length > 1 && (
        <>
          <div className="tl-marker-divider" />
          <div className="tl-marker-list" style={{ height: Math.min(all.length * 28, 196), overflowY: all.length > 7 ? "auto" : "hidden" }}>
            {all.map((m) => (
              <button key={m.id} className={`tl-marker-row${m.id === id ? " current" : ""}`}
                onClick={() => {
                  commitLive();
                  useStore.getState().seek(m.time);
                  engine.showFrame(useStore.getState().playhead);
                  openMarkerPanel(m.id);
                }}>
                <span className="tl-marker-dot" style={{ background: MARKER_HEX[m.tint] }} />
                <span className="tl-marker-row-name">{m.name}</span>
                <span className="tl-marker-row-time">{timecode(m.time, project.fps, timeStyle)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
