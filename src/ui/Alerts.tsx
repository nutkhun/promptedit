// App alerts (docs/spec/04-ui.md §1.9): Editroom uses system alerts (`EditroomAlert`); the web UI
// draws the same thing: app icon on the left, bold title, informative text, buttons right-aligned with
// the default (Return) button in grey with black text. Centred on the window a little above the middle.
// One at a time: later alerts wait in a queue. Clicks and keys that were already queued are dropped
// (nothing reaches the editor while an alert is up).
//
//   const choice = await showAlert({ title: "Replace “a.mp4”?", text: "…", buttons: ["Replace", "Cancel"] });
//   if (choice === 0) …

import { useEffect, useRef } from "react";
import { create } from "zustand";
import appIcon from "../../src-tauri/icons/128x128@2x.png";
import "./alerts.css";

export interface AlertOptions {
  title: string;
  text?: string;
  /** Button titles, first = default (Return). Defaults to ["OK"]. */
  buttons?: string[];
  /** Which button Esc presses: by default "Cancel" if present, else the last. */
  cancel?: number;
}

interface Pending extends AlertOptions { resolve: (i: number) => void }
const useAlerts = create<{ queue: Pending[] }>(() => ({ queue: [] }));

/** Shows an alert; resolves with the index of the button pressed. */
export function showAlert(o: AlertOptions): Promise<number> {
  return new Promise((resolve) => useAlerts.setState((s) => ({ queue: [...s.queue, { ...o, resolve }] })));
}

/** Whether an alert is showing (keyboard shortcuts stay quiet). */
export const alertOpen = () => useAlerts.getState().queue.length > 0;

/** Renders the front alert. Mounted once by the app shell. */
export function AlertLayer() {
  const current = useAlerts((s) => s.queue[0]);
  if (!current) return null;
  return <AlertBox key={useAlerts.getState().queue.length + current.title} alert={current} />;
}

function AlertBox({ alert }: { alert: Pending }) {
  const buttons = alert.buttons?.length ? alert.buttons : ["OK"];
  const cancelIndex = alert.cancel ?? (buttons.indexOf("Cancel") >= 0 ? buttons.indexOf("Cancel") : buttons.length - 1);
  const first = useRef<HTMLButtonElement>(null);
  const done = (i: number) => {
    useAlerts.setState((s) => ({ queue: s.queue.slice(1) }));
    alert.resolve(i);
  };
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Everything stops here: an alert is modal.
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(cancelIndex); }
      else if (e.key === "Enter") { e.preventDefault(); done(0); }
      else if (e.key !== "Tab") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Buttons right-aligned: default at the right end, as macOS lays them out; a third ("Don't Save") at the left.
  const order = buttons.map((_, i) => i);
  const left = buttons.length > 2 ? [order[2]] : [];
  const right = (buttons.length > 2 ? [order[1], order[0]] : order.slice().reverse());
  const button = (i: number) => (
    <button key={i} ref={i === 0 ? first : undefined} type="button" className={`pe-alert-button${i === 0 ? " default" : ""}`} onClick={() => done(i)}>
      {buttons[i]}
    </button>
  );
  return (
    <div className="pe-alert-scrim" data-modal-open onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="pe-alert" role="alertdialog" aria-label={alert.title}>
        <img className="pe-alert-icon" src={appIcon} alt="" draggable={false} />
        <div className="pe-alert-body">
          <div className="pe-alert-title">{alert.title}</div>
          {alert.text && <div className="pe-alert-text">{alert.text}</div>}
          <div className="pe-alert-buttons">
            {left.map(button)}
            <span style={{ flex: 1 }} />
            {right.map(button)}
          </div>
        </div>
      </div>
    </div>
  );
}
