// What the update flow shows (docs/spec/04-ui.md §6.1). Editroom draws the update-found alert itself
// and leaves every other step to Sparkle's small status windows; here both are the app's alert box
// (Alerts.tsx's look: app icon, bold title, text, buttons at the right, the default one grey with black
// type), the status steps with Sparkle's wording and a progress bar.

import { useEffect, useRef, type ReactNode } from "react";
import appIcon from "../../../src-tauri/icons/128x128@2x.png";
import "../alerts.css";
import "./updates.css";
import {
  chooseInstall, chooseRemindLater, chooseSkip, dismiss, installAndRelaunch, setAutoDownload, useUpdates,
} from "./controller";
import { changeLines, downloadProgressText } from "./notes";

const APP = "PromptEdit";

export function UpdateLayer() {
  const step = useUpdates((s) => s.step);
  const shown = useUpdates((s) => s.shown);
  const current = useUpdates((s) => s.currentVersion);
  const autoDownload = useUpdates((s) => s.autoDownload);
  if (!shown) return null;

  switch (step.kind) {
    case "idle":
      return null;
    case "checking":
      return (
        <Panel title="Checking for updates…" buttons={[{ title: "Cancel", run: dismiss }]} cancel={0} plainDefault>
          <Progress />
        </Panel>
      );
    case "upToDate":
      return (
        <Panel title="You’re up to date!" buttons={[{ title: "OK", run: dismiss }]}>
          <div className="pe-alert-text">{APP} {current} is currently the newest version available.</div>
        </Panel>
      );
    case "found": {
      const { update, downloaded } = step;
      const changes = changeLines(update.notes);
      const have = update.currentVersion || current;
      return (
        <Panel wide label="Software Update" title={`A new version of ${APP} is available!`} cancel={1} buttons={[
          { title: downloaded ? "Install and Relaunch" : "Install Update", run: () => void chooseInstall() },
          { title: "Remind Me Later", run: chooseRemindLater },
          { title: "Skip This Version", run: chooseSkip },
        ]} footer={
          <label className="pe-check pe-update-auto">
            <input type="checkbox" checked={autoDownload} onChange={(e) => setAutoDownload(e.target.checked)} />
            <span>Automatically download and install updates in the future</span>
          </label>
        }>
          <div className="pe-alert-text">
            {downloaded
              ? `${APP} ${update.version} is ready to install — you have ${have}.`
              : `${APP} ${update.version} is now available — you have ${have}. Would you like to download it now?`}
          </div>
          {changes.length > 0 && (
            <div className="pe-update-changes">
              <div className="pe-update-changes-title">What’s new</div>
              <ul>{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
        </Panel>
      );
    }
    case "downloading":
      return (
        <Panel title="Downloading update…" buttons={[{ title: "Cancel", run: dismiss }]} cancel={0} plainDefault>
          <Progress value={step.total ? step.received / step.total : undefined} />
          <div className="pe-update-status">{step.received > 0 || step.total ? downloadProgressText(step.received, step.total) : "Starting…"}</div>
        </Panel>
      );
    case "ready":
      return (
        <Panel title="Ready to Install" cancel={1} buttons={[
          { title: "Install and Relaunch", run: () => void installAndRelaunch() },
          { title: "Cancel", run: dismiss },
        ]}>
          <Progress value={1} />
          <div className="pe-alert-text">{APP} {step.update.version} has been downloaded and is ready to use! Would you like to install it and relaunch {APP} now?</div>
        </Panel>
      );
    case "installing":
      return (
        <Panel title="Installing update…" buttons={[]}>
          <Progress />
        </Panel>
      );
    case "error":
      return (
        <Panel title="Update Error!" buttons={[{ title: "OK", run: dismiss }]}>
          <div className="pe-alert-text">{step.text}</div>
          {step.detail && <div className="pe-update-detail">{step.detail}</div>}
        </Panel>
      );
  }
}

interface Button { title: string; run: () => void }

/**
 * One step's box. `buttons[0]` is the default (Return); `cancel` is the one Esc presses. A box whose
 * only button is Cancel (checking, downloading) has no default look: Return shouldn't cancel a download.
 */
function Panel({ title, label, buttons, cancel, wide, plainDefault, footer, children }: {
  title: string; label?: string; buttons: Button[]; cancel?: number; wide?: boolean; plainDefault?: boolean;
  footer?: ReactNode; children?: ReactNode;
}) {
  const first = useRef<HTMLButtonElement>(null);
  const latest = useRef({ buttons, cancel, plainDefault });
  latest.current = { buttons, cancel, plainDefault };
  useEffect(() => { first.current?.focus(); }, [title]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { buttons: b, cancel: c, plainDefault: plain } = latest.current;
      // Modal, like an alert: nothing reaches the editor.
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); if (c !== undefined) b[c]?.run(); }
      else if (e.key === "Enter") { e.preventDefault(); if (!plain) b[0]?.run(); }
      else if (e.key !== "Tab" && e.key !== " ") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // As Alerts.tsx lays them out: the default at the right end, a third ("Skip This Version") at the left.
  const order = buttons.map((_, i) => i);
  const left = buttons.length > 2 ? [order[2]] : [];
  const right = buttons.length > 2 ? [order[1], order[0]] : order.slice().reverse();
  const button = (i: number) => (
    <button key={i} ref={i === 0 ? first : undefined} type="button"
      className={`pe-alert-button${i === 0 && !plainDefault ? " default" : ""}`} onClick={buttons[i].run}>
      {buttons[i].title}
    </button>
  );
  return (
    <div className="pe-alert-scrim pe-update-scrim" data-modal-open onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className={`pe-alert pe-update${wide ? " wide" : ""}`} role="alertdialog" aria-label={label ?? title}>
        <img className="pe-alert-icon" src={appIcon} alt="" draggable={false} />
        <div className="pe-alert-body">
          <div className="pe-alert-title">{title}</div>
          {children}
          {footer}
          {buttons.length > 0 && (
            <div className="pe-alert-buttons">
              {left.map(button)}
              <span style={{ flex: 1 }} />
              {right.map(button)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A progress bar; without a value it's indeterminate (a bar sweeping across). */
function Progress({ value }: { value?: number }) {
  const known = value !== undefined && Number.isFinite(value);
  return (
    <div className={`pe-update-progress${known ? "" : " indeterminate"}`} role="progressbar"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(value * 100) : undefined}>
      <div style={known ? { width: `${Math.min(1, Math.max(0, value)) * 100}%` } : undefined} />
    </div>
  );
}
