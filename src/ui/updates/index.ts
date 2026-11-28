// Software updates: imported once at startup (main.tsx). Starts the updater's automatic checks,
// answers the menu's Check for Updates… (`promptedit:check-updates`, src/ui/shell/menuModel.ts) and
// draws the update boxes in a layer of their own.
//
// Answering an event (preventDefault) is how other modules learn the updater runs: unanswered, Check
// for Updates… says "This build doesn't check for updates." — in a browser, in a build without the
// update signing key, or before the updater has said it runs.

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { checkNow, startUpdates, useUpdates } from "./controller";
import { UpdateLayer } from "./UpdateWindow";

function install() {
  startUpdates();
  window.addEventListener("promptedit:check-updates", (e) => {
    if (!useUpdates.getState().enabled) return;
    e.preventDefault();
    void checkNow();
  });
  window.addEventListener("promptedit:updater-present", (e) => {
    if (useUpdates.getState().enabled) e.preventDefault();
  });
  const host = document.createElement("div");
  host.id = "pe-updates";
  document.body.appendChild(host);
  createRoot(host).render(createElement(UpdateLayer));
}

// Once, even if a development reload imports this again.
const flag = "__promptedit_updates_installed";
if (!(window as unknown as Record<string, boolean>)[flag]) {
  (window as unknown as Record<string, boolean>)[flag] = true;
  install();
}
