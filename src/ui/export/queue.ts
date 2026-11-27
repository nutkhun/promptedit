// Background exports (docs/spec/04-ui.md §1.7): the export sheet queues a job and closes; jobs run one
// after another through `engine.export`, and the title bar's progress pill shows how they're going.

import { create } from "zustand";
import { engine, type ExportOptions, type ExportProgress } from "../../engine";

export type ExportStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

export interface ExportJob {
  id: number;
  /** File name with extension. */
  name: string;
  options: ExportOptions;
  /** "H.264 · 1080p" / "WAV": the list's detail line. */
  kind: string;
  status: ExportStatus;
  progress: number;
  message?: string;
  startedAt?: number;
  /** Told about every change, for exports an AI agent started (reported back over MCP). */
  report?: (job: ExportJob) => void;
}

interface QueueState {
  jobs: ExportJob[];
  /** Seconds left for the running job, once there's enough progress to tell. */
  timeLeft?: number;
}

export const useExports = create<QueueState>(() => ({ jobs: [] }));

let nextId = 1;
const patch = (id: number, p: Partial<ExportJob>) => {
  useExports.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));
  const job = useExports.getState().jobs.find((j) => j.id === id);
  job?.report?.(job);
};

export function queueExport(name: string, kind: string, options: ExportOptions, report?: ExportJob["report"]) {
  useExports.setState((s) => ({ jobs: [...s.jobs, { id: nextId++, name, kind, options, status: "waiting", progress: 0, report }] }));
  void runNext();
}

async function runNext() {
  const { jobs } = useExports.getState();
  if (jobs.some((j) => j.status === "running")) return;
  const job = jobs.find((j) => j.status === "waiting");
  if (!job) return;
  const startedAt = performance.now();
  patch(job.id, { status: "running", startedAt, progress: 0 });
  useExports.setState({ timeLeft: undefined });
  const onProgress = (p: ExportProgress) => {
    const fraction = Math.max(0, Math.min(1, p.fraction));
    const elapsed = (performance.now() - startedAt) / 1000;
    // Time left once a few percent are done, so the estimate isn't wild at the start.
    const timeLeft = fraction > 0.03 && elapsed > 1 ? (elapsed / fraction) * (1 - fraction) : undefined;
    patch(job.id, { progress: fraction });
    useExports.setState({ timeLeft });
    if (p.phase === "cancelled") patch(job.id, { status: "cancelled" });
  };
  try {
    await engine.export(job.options, onProgress);
    const now = useExports.getState().jobs.find((j) => j.id === job.id);
    if (now?.status === "running") patch(job.id, { status: "done", progress: 1 });
  } catch (e) {
    const now = useExports.getState().jobs.find((j) => j.id === job.id);
    if (now?.status === "running") patch(job.id, { status: "failed", message: e instanceof Error ? e.message : String(e) });
  }
  useExports.setState({ timeLeft: undefined });
  void runNext();
}

export function cancelExport(id: number) {
  const job = useExports.getState().jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.status === "running") engine.cancelExport();
  if (job.status === "running" || job.status === "waiting") patch(id, { status: "cancelled" });
  void runNext();
}

export function clearFinished() {
  useExports.setState((s) => ({ jobs: s.jobs.filter((j) => j.status === "running" || j.status === "waiting") }));
}
