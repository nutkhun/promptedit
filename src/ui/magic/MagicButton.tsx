// The Magic button in the title bar (docs/spec/04-ui.md §1.1) and everything around a run: the
// popover, the status line beside the button, Stop (the button on hover, or Esc), the lock on the
// editor while Magic works, the note when it's done (Undo / Done), and the agents' cursors.
//
// Capsule 26 tall, padding 11, `ink(0.08)` fill (hover 0.14), wand + "Magic" 11.5 semibold. While
// working: a spinner and the worker's name; hovering shows a Stop square in the accent and "Stop".
// Disabled (40 %) with no media.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri, isMac } from "../../api";
import { useStore } from "../../store";
import { showAlert } from "../Alerts";
import { PillButton, Spinner } from "../buttons";
import { Glyph } from "../icons";
import { AgentCursors } from "./AgentCursors";
import { agentName, magicApi, type MagicNote } from "./magicApi";
import { useMagic } from "./magicStore";
import { AgentLogo, MagicPopover } from "./MagicPopover";
import "./magic.css";

export function MagicButton() {
  const hasMedia = useStore((s) => s.project.assets.length > 0 || s.project.clips.length > 0);
  const open = useMagic((s) => s.open);
  const run = useMagic((s) => s.run);
  const set = useMagic((s) => s.set);
  const [hover, setHover] = useState(false);
  const button = useRef<HTMLDivElement>(null);

  usePolling();
  useReportView();
  usePlaybackFromAgents();

  // Other parts of the app (menus) open Magic with this event.
  useEffect(() => {
    const onOpen = () => { if (!useMagic.getState().run.running) set({ open: true }); };
    window.addEventListener("promptedit:magic", onOpen);
    return () => window.removeEventListener("promptedit:magic", onOpen);
  }, [set]);

  const working = run.running;
  const status = working ? (run.activity ? `${agentName(run.tab === "local" ? null : run.tab)} is ${run.activity}` : run.status) : null;
  const click = () => {
    if (working) void stop();
    else set({ open: !open });
  };

  return (
    <div className="mg-anchor" ref={button}>
      {status && <span className="mg-status" title={status}>{status.length > 40 ? `${status.slice(0, 39)}…` : status}</span>}
      <button type="button" className={`pe-magic mg-button${working ? " working" : ""}`} disabled={!hasMedia && !working}
        title={working ? "Stop (Esc)" : hasMedia ? "Magic: have Claude or ChatGPT edit, or make a quick cut" : "Import some clips first"}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={click} aria-haspopup="dialog" aria-expanded={open}>
        {working && hover ? (
          <><span className="mg-stop" /><span>Stop</span></>
        ) : working ? (
          <><Spinner size={11} /><span>{agentName(run.tab === "local" ? null : run.tab)}</span></>
        ) : (
          <><Glyph symbol="wand.and.sparkles" size={11} weight="semibold" /><span>Magic</span></>
        )}
      </button>
      {open && !working && (
        <Floating anchor={button} onClose={() => set({ open: false })}>
          <MagicPopover close={() => set({ open: false })} />
        </Floating>
      )}
      {!working && run.note && !run.note.title && (
        <Floating anchor={button} onClose={() => void dismiss()}>
          <NoteView note={run.note} />
        </Floating>
      )}
      {working && <Lock />}
      {createPortal(<AgentCursors />, document.body)}
    </div>
  );
}

async function stop() {
  useMagic.getState().set({ run: await magicApi.stop() });
}

async function dismiss() {
  await magicApi.dismissNote().catch(() => {});
  await useMagic.getState().poll();
}

/** A panel under the button, right-aligned to it; Esc or a click outside closes it. */
function Floating({ anchor, onClose, children }: { anchor: React.RefObject<HTMLDivElement | null>; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 48, right: 120 });
  useEffect(() => {
    const place = () => {
      const r = anchor.current?.querySelector(".mg-button")?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right - 60) });
    };
    place();
    window.addEventListener("resize", place);
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} className="mg-floating" style={{ top: pos.top, right: pos.right }}>{children}</div>, document.body);
}

/** Markdown links in a note ("[track](https://…)") are clickable. */
function linked(text: string) {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(at, m.index));
    parts.push(<a key={m.index} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a>);
    at = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(at));
  return parts;
}

function NoteView({ note }: { note: MagicNote }) {
  const undo = useStore((s) => s.undo);
  // Return is Done (Esc too, through the panel).
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void dismiss(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="mg-note" role="status">
      <div className="mg-note-head">
        <AgentLogo tab={(note.agent as "claude" | "chatgpt" | null) ?? null} size={18} />
        <span className="who">{agentName(note.agent)}</span>
        {note.detail && <span className="detail">{note.detail}</span>}
      </div>
      <div className="mg-note-text">{linked(note.text)}</div>
      <div className="mg-row end">
        {note.changed && <PillButton onClick={() => { void undo(); void dismiss(); }}>Undo</PillButton>}
        <PillButton prominent onClick={() => void dismiss()}>Done</PillButton>
      </div>
    </div>
  );
}

/** While Magic works the editor is locked: clicks and keys don't reach it, except Esc (stop). */
function Lock() {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void stop();
        return;
      }
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Quit, hide and minimise still work.
      if (mod && ["q", "h", "m"].includes(e.key.toLowerCase())) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const top = document.querySelector(".pe-titlebar")?.getBoundingClientRect().bottom ?? 52;
  return createPortal(<div className="mg-lock" style={{ top }} aria-hidden />, document.body);
}

/** Polls the run while it works (and once at start), and picks up the project when it ends. */
function usePolling() {
  const running = useMagic((s) => s.run.running);
  useEffect(() => {
    void useMagic.getState().poll();
  }, []);
  useEffect(() => {
    if (!running) return;
    let was = true;
    const t = setInterval(async () => {
      const r = await useMagic.getState().poll();
      if (r && !r.running && was) {
        was = false;
        // The finished edit (the app also sends `project-changed`; the browser dev server doesn't).
        useStore.getState().apply(await api.getProject());
        if (r.note?.title) void alertFor(r.note);
      }
    }, 400);
    return () => clearInterval(t);
  }, [running]);
}

async function alertFor(note: MagicNote) {
  const choice = await showAlert({ title: note.title ?? "", text: note.text, buttons: note.signIn ? ["Sign In", "Cancel"] : ["OK"] });
  await dismiss();
  if (note.signIn && choice === 0 && (note.agent === "claude" || note.agent === "chatgpt")) {
    try {
      await magicApi.signIn(note.agent);
      useMagic.getState().set({ open: true, tab: note.agent });
    } catch (e) {
      await showAlert({ title: `${agentName(note.agent)} isn't signed in`, text: String(e) });
    }
  }
}

/** The playhead and transport go to the backend (for get_project and get_frame), at most 4 times a second. */
function useReportView() {
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      const s = useStore.getState();
      last = Date.now();
      void magicApi.reportView(s.playhead, s.playing).catch(() => {});
    };
    send();
    return useStore.subscribe((s, prev) => {
      if (s.playhead === prev.playhead && s.playing === prev.playing) return;
      clearTimeout(timer);
      if (Date.now() - last > 250) send();
      else timer = setTimeout(send, 250);
    });
  }, []);
}

/** The playback tool: play, pause or seek, from an agent. */
function usePlaybackFromAgents() {
  useEffect(() => {
    if (!inTauri) return;
    const un = listen<{ action: string; time: number }>("mcp-playback", (e) => {
      const s = useStore.getState();
      if (e.payload.action === "seek") s.seek(e.payload.time);
      else s.set({ playing: e.payload.action === "play" });
    });
    return () => { un.then((f) => f()); };
  }, []);
}
