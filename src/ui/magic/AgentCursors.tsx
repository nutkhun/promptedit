// Agents' cursors (Editroom's `AgentPresence`): after a live agent's edit, its cursor is parked where
// it happened on the timeline, with a name tag in its colour, bobbing gently, for 12 seconds (fading
// over the last half second). Driven by the server's `agent-presence` events.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "../../api";
import { useStore } from "../../store";
import { RULER, makeLayout } from "../../timeline/layout";

interface Presence {
  name: string;
  color: string;
  label: string;
  time?: number | null;
  track?: string | null;
  clipIds: string[];
  linger: number;
}

interface Parked extends Presence { at: number; seed: number }

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Where on screen a timeline time and track are; the Magic button when it's off the timeline. */
function place(p: Presence): { x: number; y: number } {
  const canvas = document.querySelector(".tl-canvas")?.getBoundingClientRect();
  const s = useStore.getState();
  if (canvas && p.time != null) {
    const x = canvas.left + p.time * s.view.pps - s.view.scrollX;
    const layout = makeLayout(s.project, s.view.rowHeight);
    const kind = p.track?.startsWith("A") ? "audio" : "video";
    const index = Number(p.track?.slice(1) ?? 1) - 1;
    const row = layout.rows.find((r) => r.track.kind === kind && r.index === index);
    const y = canvas.top + RULER + (row ? row.y + row.height / 2 : 40) - s.view.scrollY;
    return { x: Math.min(canvas.right - 20, Math.max(canvas.left, x)), y: Math.min(canvas.bottom - 20, Math.max(canvas.top + RULER, y)) };
  }
  const b = document.querySelector(".mg-button")?.getBoundingClientRect();
  return b ? { x: b.left + b.width / 2, y: b.bottom + 4 } : { x: window.innerWidth - 160, y: 60 };
}

export function AgentCursors() {
  const [cursors, setCursors] = useState<Parked[]>([]);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!inTauri) return;
    const un = listen<Presence>("agent-presence", (e) => {
      const p = e.payload;
      // The next call by the same agent takes its cursor from where it was.
      setCursors((c) => [...c.filter((x) => x.name !== p.name), { ...p, at: performance.now(), seed: hash(p.name) % 7 }]);
    });
    return () => { un.then((f) => f()); };
  }, []);

  // 30 Hz while any cursor is up.
  useEffect(() => {
    if (!cursors.length) return;
    const t = setInterval(() => {
      const now = performance.now();
      setCursors((c) => c.filter((x) => now - x.at < x.linger * 1000));
      tick((n) => n + 1);
    }, 33);
    return () => clearInterval(t);
  }, [cursors.length]);

  const now = performance.now();
  return (
    <div className="mg-cursors" aria-hidden>
      {cursors.map((c) => {
        const { x, y } = place(c);
        const age = (now - c.at) / 1000;
        const opacity = Math.min(1, Math.max(0, (c.linger - age) / 0.5));
        const bob = Math.sin((now / 1000) * 2.2 + c.seed) * 2;
        return (
          <div key={c.name} className="mg-cursor" style={{ transform: `translate(${x - 2}px, ${y - 2 + bob}px)`, opacity }}>
            <svg width="18" height="24" viewBox="0 0 18 24"><path d="M2 2 L2 19 L6.5 14.8 L9.6 21.6 L12.4 20.4 L9.4 13.8 L15.4 13.6 Z" fill={c.color} stroke="#000" strokeOpacity="0.55" strokeWidth="1.2" strokeLinejoin="round" /></svg>
            <span className="tag" style={{ background: `color-mix(in srgb, ${c.color} 82%, black)` }}>{c.name}{c.label ? ` · ${c.label}` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
