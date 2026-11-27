// The title bar's export progress pill and its list (docs/spec/04-ui.md §1.7, ExportProgress.swift).

import { useEffect, useRef, useState } from "react";
import { shortTime } from "../../timing";
import { IconButton, Spinner } from "../buttons";
import { Glyph } from "../icons";
import { showInFolder, showInFolderLabel } from "../shell/files";
import { cancelExport, clearFinished, useExports, type ExportJob } from "./queue";
import "./export.css";

export function ExportProgressPill() {
  const jobs = useExports((s) => s.jobs);
  const timeLeft = useExports((s) => s.timeLeft);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [open]);
  useEffect(() => { if (!jobs.length) setOpen(false); }, [jobs.length]);
  if (!jobs.length) return null;

  const running = jobs.find((j) => j.status === "running");
  const waiting = jobs.filter((j) => j.status === "waiting").length;
  const pct = running ? `${Math.floor(running.progress * 100)}%` : "";
  return (
    <div className="pe-export-pill-wrap" ref={ref}>
      <button type="button" className="pe-export-pill" title="Exports" onClick={() => setOpen(!open)}>
        {running ? (
          <>
            <span className="bar"><span style={{ width: Math.max(4, 72 * running.progress) }} /></span>
            <span className="mono status">{timeLeft !== undefined ? `${pct}  ·  ${shortTime(timeLeft)} left` : pct}</span>
          </>
        ) : jobs.some((j) => j.status === "failed") ? (
          <><Glyph symbol="exclamationmark.triangle.fill" size={11} style={{ color: "var(--error)" }} /><span className="word">Export failed</span></>
        ) : jobs.some((j) => j.status === "done") ? (
          <><Glyph symbol="checkmark.circle.fill" size={11} style={{ color: "var(--success)" }} /><span className="word">Exported</span></>
        ) : (
          <span className="word">Exports</span>
        )}
        {waiting > 0 && <span className="mono waiting">+{waiting}</span>}
      </button>
      {open && <ExportList jobs={jobs} />}
    </div>
  );
}

function detail(j: ExportJob) {
  switch (j.status) {
    case "running": return `${j.kind} · ${Math.floor(j.progress * 100)}%`;
    case "waiting": return `${j.kind} · waiting`;
    case "done": return `${j.kind} · done`;
    case "failed": return j.message ?? "Export failed";
    case "cancelled": return `${j.kind} · cancelled`;
  }
}

function StatusIcon({ j }: { j: ExportJob }) {
  switch (j.status) {
    case "running": return <Spinner size={13} />;
    case "waiting": return <Glyph symbol="clock" size={12} style={{ color: "var(--text-dim)" }} />;
    case "done": return <Glyph symbol="checkmark.circle.fill" size={12} style={{ color: "var(--success)" }} />;
    case "failed": return <Glyph symbol="exclamationmark.triangle.fill" size={12} style={{ color: "var(--error)" }} />;
    case "cancelled": return <Glyph symbol="xmark.circle" size={12} style={{ color: "var(--text-faint)" }} />;
  }
}

function ExportList({ jobs }: { jobs: ExportJob[] }) {
  return (
    <div className="pe-export-list" role="dialog" aria-label="Exports">
      {jobs.map((j) => (
        <div key={j.id} className="row">
          <span className="icon"><StatusIcon j={j} /></span>
          <span className="text">
            <span className="name" title={j.options.path}>{j.name}</span>
            <span className="detail">{detail(j)}</span>
          </span>
          {(j.status === "running" || j.status === "waiting") && <IconButton symbol="xmark" size={22} help="Cancel" onClick={() => cancelExport(j.id)} />}
          {j.status === "done" && <IconButton symbol="magnifyingglass" size={22} help={showInFolderLabel} onClick={() => void showInFolder(j.options.path)} />}
        </div>
      ))}
      {jobs.some((j) => j.status !== "running" && j.status !== "waiting") && (
        <button type="button" className="clear" onClick={clearFinished}>Clear Finished</button>
      )}
    </div>
  );
}
