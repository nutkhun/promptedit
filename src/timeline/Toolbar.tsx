// The timeline toolbar (docs/spec/04-ui.md §1.6): tools, Split, Delete, the in/out readout, the
// mode chips and Zoom to Fit.

import { isMac } from "../api";
import { useStore } from "../store";
import { playRange, projectDuration, shortTime, timecode } from "../timing";
import { engine } from "../engine";
import { LineIcon } from "./icons";
import { deleteSelected, splitAtPlayhead, zoomToFit } from "./actions";

const mod = isMac ? "⌘" : "Ctrl+";
const shift = isMac ? "⇧" : "Shift+";

function ToolKey({ icon, on, help, onClick }: { icon: string; on: boolean; help: string; onClick: () => void }) {
  return (
    <button className={`tl-toolkey${on ? " on" : ""}`} title={help} onClick={onClick}>
      <LineIcon name={icon} size={12} />
    </button>
  );
}

function Chip({ title, on, help, onClick }: { title: string; on: boolean; help: string; onClick: () => void }) {
  return <button className={`tl-chip${on ? " on" : ""}`} title={help} onClick={onClick}>{title}</button>;
}

/** "4.2s", "18s", or m:ss. */
export function rangeLength(s: number): string {
  if (s < 60) return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  return shortTime(s);
}

function RangeReadout() {
  const project = useStore((s) => s.project);
  const timeStyle = useStore((s) => s.timeStyle);
  const range = playRange(project);
  const go = (t: number) => {
    useStore.getState().seek(t);
    engine.showFrame(useStore.getState().playhead);
  };
  const point = (label: "In" | "Out", t: number) => (
    <button className="tl-range-point" title={`Go to ${label} (${label === "In" ? "I" : "O"} sets it)`} onClick={() => go(t)}>
      <span className="tl-range-label">{label}</span>
      <span className="tl-range-time">{timecode(t, project.fps, timeStyle)}</span>
    </button>
  );
  return (
    <div className="tl-range">
      {point("In", project.inPoint ?? 0)}
      {point("Out", project.outPoint ?? projectDuration(project))}
      {range && <span className="tl-range-length">· {rangeLength(range[1] - range[0])}</span>}
      <button className="tl-range-clear" title={`Clear In and Out (${shift}X)`}
        onClick={() => useStore.getState().edit({ op: "clearInOut" })}>✕</button>
    </div>
  );
}

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const set = useStore((s) => s.set);
  const setSetting = useStore((s) => s.setSetting);
  const thumbnails = useStore((s) => s.thumbnails);
  const snapping = useStore((s) => s.snapping);
  const sticky = useStore((s) => s.sticky);
  const skimming = useStore((s) => s.skimming);
  const audioScrubbing = useStore((s) => s.audioScrubbing);
  const canDelete = useStore((s) => s.selection.size > 0 || s.mediaSelection.size > 0);
  const hasRange = useStore((s) => s.project.inPoint !== undefined || s.project.outPoint !== undefined);
  return (
    <div className="tl-toolbar">
      <div className="tl-tools">
        <ToolKey icon="cursorarrow" on={tool === "select"} help="Select (V or A)" onClick={() => set({ tool: "select" })} />
        <ToolKey icon="scissors" on={tool === "cut"} help="Cut (C)" onClick={() => set({ tool: "cut" })} />
      </div>
      <button className="tl-text-action" title={`Split at Playhead (${mod}K)`} onClick={splitAtPlayhead}>Split</button>
      <button className="tl-text-action" title={isMac ? "Delete (⌫)" : "Delete (Backspace)"} disabled={!canDelete}
        onClick={() => deleteSelected()}>Delete</button>
      {hasRange && <RangeReadout />}
      <div className="tl-spacer" />
      <Chip title="Strip" on={thumbnails} help="Filmstrip: pictures in clips. Off shows clips as flat colour by type"
        onClick={() => setSetting("thumbnails", !thumbnails)} />
      <Chip title="Snap" on={snapping} help="Snapping (S)" onClick={() => set({ snapping: !snapping })} />
      <Chip title="Sticky" on={sticky} help="Sticky Edges (R): clips touching a clip that changes length move with it"
        onClick={() => setSetting("sticky", !sticky)} />
      <Chip title="Skim" on={skimming} help="Skimming (K): hover the timeline to preview frames"
        onClick={() => setSetting("skimming", !skimming)} />
      <Chip title="Audio" on={audioScrubbing} help={`Audio Scrubbing (${shift}S): hear sound while dragging the playhead or skimming`}
        onClick={() => setSetting("audioScrubbing", !audioScrubbing)} />
      <button className="tl-icon-button" title={`Zoom to Fit (${shift}Z)`} onClick={zoomToFit}>
        <LineIcon name="arrow.left.and.right" size={12.9} />
      </button>
    </div>
  );
}
