// Calls into the Magic, MCP and agent-connect backend (src-tauri/src/magic, src/mcp, src/agents.rs).

import { call } from "../../api";
import type { Id } from "../../model";

export type Tab = "claude" | "chatgpt" | "local";
export type AiKind = "claude" | "chatgpt";
export type AgentApp = "claude" | "chatgpt" | "claudeCode";

export interface MagicNote {
  /** claude, chatgpt, or null for Local. */
  agent?: string | null;
  text: string;
  changed: boolean;
  /** "Opus 5.5 · Low · 54s" */
  detail: string;
  /** Shown as an alert with this title instead of a note. */
  title?: string | null;
  /** The alert offers Sign In. */
  signIn: boolean;
}

export interface MagicState {
  running: boolean;
  tab?: Tab | null;
  status?: string | null;
  activity?: string | null;
  note?: MagicNote | null;
  seconds: number;
}

export interface Availability {
  installed: boolean;
  connected: boolean;
  runnable: boolean;
  waiting: boolean;
  connectApp: AgentApp;
}

export interface ModelOption {
  id: string;
  name: string;
  blurb: string;
  efforts: string[];
  defaultEffort: string;
}

export type AgentStateName = "missing" | "ready" | "waiting" | "connected" | "working" | "failed";

export interface AgentRow {
  app: AgentApp;
  title: string;
  state: AgentStateName;
  /** Why it failed. */
  message?: string;
  download?: string | null;
  cursorName: string;
}

export interface McpStatus {
  running: boolean;
  port?: number | null;
  endpoint: string;
  problem?: string | null;
  enabled: boolean;
  clients: { name: string; color: string }[];
}

export interface Pointers {
  playhead: number;
  selected: Id[];
  range: [number, number] | null;
}

export interface StartArgs {
  tab: Tab;
  prompt: string;
  pointers: Pointers;
  model: string;
  effort: string;
}

export const magicApi = {
  state: () => call<MagicState>("magic_state"),
  start: (args: StartArgs) => call<MagicState>("magic_start", { args }),
  stop: () => call<MagicState>("magic_stop"),
  dismissNote: () => call<void>("magic_dismiss_note"),
  models: (kind: AiKind) => call<ModelOption[]>("magic_models", { kind }),
  availability: () => call<Record<AiKind, Availability>>("magic_availability"),
  localStatus: () => call<{ model?: string | null; note?: string | null }>("magic_local_status"),
  signIn: (kind: AiKind) => call<void>("magic_sign_in", { kind }),
  mcpStatus: () => call<McpStatus>("mcp_status"),
  setAgentsEnabled: (enabled: boolean) => call<McpStatus>("mcp_set_enabled", { enabled }),
  reportView: (playhead: number, playing: boolean) => call<void>("mcp_report_view", { playhead, playing }),
  agents: () => call<AgentRow[]>("agents_status_cmd"),
  connect: (app: AgentApp) => call<AgentRow>("agents_connect", { app }),
  disconnect: (app: AgentApp) => call<AgentRow>("agents_disconnect", { app }),
  cancelWaiting: () => call<void>("agents_cancel_waiting"),
  reopenClaude: () => call<void>("agents_reopen_claude"),
  connectPrompt: () => call<string>("agents_connect_prompt"),
};

/** The cursor colours (src-tauri/src/mcp/presence.rs): Claude orange, OpenAI green, Local white. */
export const agentColor = (agent?: string | null) =>
  agent === "claude" ? "#D97857" : agent === "chatgpt" ? "#0FA380" : "#F2F2F2";

export const agentName = (agent?: string | null) => (agent === "claude" ? "Claude" : agent === "chatgpt" ? "ChatGPT" : "Local");

/** Effort labels: "xhigh" → "Extra high", else capitalised. */
export const effortName = (e: string) => (e === "xhigh" ? "Extra high" : e.charAt(0).toUpperCase() + e.slice(1));
export const effortBlurb = (e: string) => (e === "low" ? "Quickest" : e === "max" ? "Slowest" : "");
