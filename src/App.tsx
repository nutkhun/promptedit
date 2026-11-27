// The editor window: title bar, library | viewer | inspector, then the timeline
// (docs/spec/04-ui.md §1.2).

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { Snapshot } from "./model";
import { useStore } from "./store";
import { TitleBar } from "./ui/TitleBar";
import { Library } from "./ui/Library";
import { Viewer } from "./ui/Viewer";
import { Inspector } from "./ui/Inspector";
import { ExportSheet } from "./ui/ExportSheet";
import { SettingsWindow } from "./ui/SettingsWindow";
import { Timeline } from "./timeline/Timeline";
import "./App.css";

export default function App() {
  const theme = useStore((s) => s.theme);
  const exportOpen = useStore((s) => s.exportOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [libraryWidth, setLibraryWidth] = useState(252);
  const [timelineHeight, setTimelineHeight] = useState(360);
  const [windowHeight, setWindowHeight] = useState(window.innerHeight);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    api.getProject().then(useStore.getState().apply).catch(() => {});
    // Edits made elsewhere (MCP tools, Magic) arrive as events.
    const un = listen<Snapshot>("project-changed", (e) => useStore.getState().apply(e.payload));
    const onResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => {
      un.then((f) => f());
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const shownTimeline = Math.min(timelineHeight, Math.max(170, windowHeight - 240));

  const dragLibrary = (e: React.PointerEvent) => {
    const move = (ev: PointerEvent) => setLibraryWidth(Math.min(440, Math.max(190, ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };
  const dragTimeline = (e: React.PointerEvent) => {
    const move = (ev: PointerEvent) =>
      setTimelineHeight(Math.min(Math.max(200, window.innerHeight - 240), Math.max(170, window.innerHeight - ev.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  return (
    <div className="app" ref={root}>
      <TitleBar />
      <div className="upper">
        <div className="library-pane" style={{ width: libraryWidth }}>
          <Library />
        </div>
        <div className="splitter-v" onPointerDown={dragLibrary} />
        <div className="viewer-pane">
          <Viewer />
        </div>
        <div className="hairline-v" />
        <div className="inspector-pane">
          <Inspector />
        </div>
      </div>
      <div className="splitter-h" onPointerDown={dragTimeline} />
      <div className="timeline-pane" style={{ height: shownTimeline }}>
        <Timeline />
      </div>
      {exportOpen && <ExportSheet />}
      {settingsOpen && <SettingsWindow />}
    </div>
  );
}
