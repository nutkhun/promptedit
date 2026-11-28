// Exports started by an AI agent over MCP (`export_video` tool). The MCP server can't render (the
// renderer lives in the webview), so it sends `mcp-export`; we run it through the same queue as
// the export sheet (it shows in the title bar's progress pill) and report back with
// `mcp_export_update` so the agent can follow it.

import { listen } from "@tauri-apps/api/event";
import { call, inTauri } from "../../api";
import { store } from "../../store";
import { engineOptions, kindLabel, type ExportSettings } from "./settings";
import { queueExport, type ExportJob } from "./queue";

/** Mirrors src-tauri/src/mcp/providers.rs `ExportRequest`. */
interface AgentExportRequest {
  id: string;
  file: string;
  /** video: MP4; prores: MOV; audio: WAV; mp3. */
  format: "video" | "prores" | "audio" | "mp3";
  shape: ExportSettings["shape"];
  height?: number | null;
  codec: "h264" | "hevc";
  quality: "high" | "web";
  includeAudio: boolean;
  loudness?: number | null;
  rangeOnly: boolean;
  reframeX: number;
  reframeY: number;
  proresProfile?: ExportSettings["prores"] | null;
}

const FORMAT: Record<AgentExportRequest["format"], ExportSettings["format"]> = { video: "mp4", prores: "mov", audio: "wav", mp3: "mp3" };

export function settingsFor(r: AgentExportRequest): ExportSettings {
  return {
    format: FORMAT[r.format] ?? "mp4",
    height: r.height ?? undefined,
    codec: r.codec,
    quality: r.quality,
    prores: r.proresProfile ?? "standard",
    // The tool's quality picks the MP3 bit rate.
    mp3Kbps: r.quality === "web" ? 192 : 320,
    includeAudio: r.includeAudio,
    loudness: r.loudness ?? undefined,
    shape: r.shape,
    reframe: { x: r.reframeX, y: r.reframeY },
    rangeOnly: r.rangeOnly,
  };
}

export function startAgentExports(): () => void {
  if (!inTauri) return () => {};
  const un = listen<AgentExportRequest>("mcp-export", (e) => {
    const r = e.payload;
    const project = store().project;
    const s = settingsFor(r);
    const name = r.file.split(/[\\/]/).pop() ?? r.file;
    let lastSent = -1;
    const report = (job: ExportJob) => {
      // Progress every 2 %, every status change.
      const step = Math.floor(job.progress * 50);
      if (job.status === "running" && step === lastSent) return;
      lastSent = step;
      void call("mcp_export_update", {
        id: r.id,
        status: job.status,
        progress: job.progress,
        error: job.status === "failed" ? job.message ?? "Export failed." : null,
      }).catch(() => {});
    };
    queueExport(name, kindLabel(s, project), engineOptions(s, project, r.file), report);
  });
  return () => void un.then((f) => f());
}
