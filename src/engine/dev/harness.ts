// Development harness for the engine (not part of the app): exposes the engine, the backend API and
// the store on `window.pe`, with the viewer canvas attached, so tests can drive it from Playwright.
// Open /src/engine/dev/harness.html on the Vite dev server.

import { api, call } from "../../api";
import { store } from "../../store";
import { engine } from "../index";

const canvas = document.getElementById("viewer") as HTMLCanvasElement;
engine.attachViewer(canvas);

(window as unknown as { pe: unknown }).pe = { engine, api, call, store };
document.getElementById("log")!.textContent = "ready";
