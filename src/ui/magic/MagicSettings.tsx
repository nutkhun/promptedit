// Settings › Magic, the AI part (docs/spec/04-ui.md §1.8, 03-mcp-magic.md §2): rows for Claude,
// ChatGPT and Claude Code (only when it's installed) with Connect / Disconnect / Try Again / Get <app>,
// then "Editing from other apps": Let AI apps edit, Connect another AI app (Copy Prompt), the server's
// problem if it has one, and who's working now. The settings window embeds `AgentSettings`.

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { inTauri } from "../../api";
import { useStore } from "../../store";
import { PillButton, Spinner, Switch } from "../buttons";
import { Section, SettingRow } from "../settings/GeneralSettings";
import { magicApi, type AgentApp, type AgentRow, type McpStatus } from "./magicApi";
import { AgentLogo } from "./MagicPopover";
import "./magic.css";

const note = (r: AgentRow): string => {
  switch (r.state) {
    case "connected":
      return r.app === "claude" ? "Connected. Claude can edit in PromptEdit from the Claude app." : r.app === "chatgpt" ? "Connected. Codex can edit in PromptEdit, in the ChatGPT app too." : "Connected. Claude Code can edit in PromptEdit while it's open.";
    case "ready":
      return r.app === "claudeCode" ? "Add PromptEdit to Claude Code for your user." : `Let ${r.title} edit in PromptEdit, with your ${r.title} plan.`;
    case "waiting":
      return "Finish in the Claude app: click Install there.";
    case "missing":
      return `${r.title} isn't on this computer.`;
    case "failed":
      return r.message ?? "That didn't work.";
    default:
      return "Working…";
  }
};

function AppRow({ row, onChange }: { row: AgentRow; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch { /* the row shows the failure */ }
    setBusy(false);
    onChange();
  };
  const logo = row.app === "chatgpt" ? "chatgpt" : "claude";
  const button = busy || row.state === "working" ? <Spinner /> : row.state === "connected" ? (
    <PillButton onClick={() => void act(() => magicApi.disconnect(row.app))}>Disconnect</PillButton>
  ) : row.state === "waiting" ? (
    <div className="mg-row">
      <PillButton onClick={() => void act(magicApi.cancelWaiting)}>Cancel</PillButton>
      <PillButton onClick={() => void act(magicApi.reopenClaude)}>Open Claude Again</PillButton>
    </div>
  ) : row.state === "missing" ? (
    row.download && <PillButton onClick={() => (inTauri ? void openUrl(row.download!) : window.open(row.download!, "_blank"))}>Get {row.title}</PillButton>
  ) : (
    <PillButton prominent={row.state !== "failed"} onClick={() => void act(() => magicApi.connect(row.app))}>{row.state === "failed" ? "Try Again" : "Connect"}</PillButton>
  );
  return (
    <div className="pe-settings-row mg-app-row">
      <AgentLogo tab={logo} size={32} />
      <div className="text">
        <div className="title mg-app-title">{row.title}</div>
        <div className={`detail${row.state === "failed" ? " mg-error" : ""}`}>{note(row)}</div>
      </div>
      <span style={{ flex: 1 }} />
      {button}
    </div>
  );
}

export function AgentSettings() {
  const setSetting = useStore((s) => s.setSetting);
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [status, setStatus] = useState<McpStatus>();
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const [r, s] = await Promise.all([magicApi.agents().catch(() => []), magicApi.mcpStatus().catch(() => undefined)]);
    setRows(r);
    setStatus(s);
  }, []);
  useEffect(() => {
    void refresh();
    // "Working now" is refreshed every 5 s; waiting for Claude's install box, every second.
    const t = setInterval(() => void refresh(), rows.some((r) => r.state === "waiting") ? 1000 : 5000);
    return () => clearInterval(t);
  }, [refresh, rows]);

  const enabled = status?.enabled ?? true;
  const setEnabled = async (v: boolean) => {
    setSetting("agentsEnabled", v);
    setStatus(await magicApi.setAgentsEnabled(v));
  };
  const copy = async () => {
    const text = await magicApi.connectPrompt();
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* clipboard refused */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  // Claude Code is listed only when it's installed.
  const shown = rows.filter((r) => r.app !== "claudeCode" || r.state !== "missing");

  return (
    <>
      <Section title="AI apps">
        {shown.length === 0 && <div className="pe-settings-row"><Spinner /></div>}
        {shown.map((r, i) => (
          <div key={r.app}>
            {i > 0 && <div className="pe-settings-divider" />}
            <AppRow row={r} onChange={() => void refresh()} />
          </div>
        ))}
      </Section>
      <div className="mg-footnote">Magic and AI apps use your own Claude or ChatGPT plan. No API key needed; nothing is shared until you ask for an edit.</div>
      <Section title="Editing from other apps">
        <SettingRow title="Let AI apps edit in PromptEdit" detail="Claude, ChatGPT and other AI apps can make edits in the open project, each as a step you can undo.">
          <Switch on={enabled} label="Let AI apps edit in PromptEdit" onChange={(v) => void setEnabled(v)} />
        </SettingRow>
        <div className="pe-settings-divider" />
        <SettingRow title="Connect another AI app" detail="Copies a prompt that tells an AI app how to connect to PromptEdit.">
          <PillButton onClick={() => void copy()}>{copied ? "Copied" : "Copy Prompt"}</PillButton>
        </SettingRow>
        {status?.problem && <div className="pe-settings-row"><div className="mg-problem">{status.problem}</div></div>}
        {status && status.clients.length > 0 && (
          <div className="pe-settings-row mg-working">
            <span className="label">Working now:</span>
            {status.clients.map((c) => (
              <span key={c.name} className="mg-client"><span className="dot" style={{ background: c.color }} />{c.name}</span>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

export type { AgentApp };
