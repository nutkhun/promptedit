// The transport bar under the viewer (docs/spec/04-ui.md §1.4): timecode field and duration on the
// left; Previous Edit, Back One Frame, Play, Forward One Frame, Next Edit in the centre; Loop, output
// meters, viewer zoom and Full Screen on the right.

import { useCallback, useEffect, useRef, useState } from "react";
import { shortcuts, useShortcuts } from "../../commands";
import { engine } from "../../engine";
import { useStore } from "../../store";
import { parseTimecode, projectDuration, timecode } from "../../timing";
import { IconButton } from "../buttons";
import { Glyph } from "../icons";
import { openMenu } from "../menu";
import * as playback from "../shell/playback";
import { LevelMeter } from "./LevelMeter";

export type ViewerZoom = number | undefined;
export const ZOOMS: [string, ViewerZoom][] = [["Fit", undefined], ["25%", 0.25], ["50%", 0.5], ["100%", 1], ["200%", 2]];

export function Transport({ zoom, setZoom }: { zoom: ViewerZoom; setZoom: (z: ViewerZoom) => void }) {
  const fps = useStore((s) => s.project.fps);
  const playhead = useStore((s) => s.playhead);
  const duration = useStore((s) => projectDuration(s.project));
  const style = useStore((s) => s.timeStyle);
  const playing = useStore((s) => s.playing);
  const loop = useStore((s) => s.loop);
  const viewerOnly = useStore((s) => s.viewerOnly);
  const set = useStore((s) => s.set);
  useShortcuts((s) => s.changed); // tooltips follow shortcut changes
  const left = useCallback(() => engine.meters()[0], []);
  const right = useCallback(() => engine.meters()[1], []);
  const zoomLabel = ZOOMS.find(([, z]) => z === zoom)?.[0] ?? "Fit";

  return (
    <div className="pe-transport">
      <div className="pe-transport-side">
        <TimecodeField time={playhead} fps={fps} style={style} />
        <span className="pe-duration-total mono">/ {timecode(duration, fps, style)}</span>
        <span style={{ flex: 1 }} />
        <IconButton symbol="repeat" active={loop} size={28} help={shortcuts.help("loop")} onClick={() => set({ loop: !loop })} />
        <div className="pe-output-meters" title="Output level, left and right">
          <LevelMeter read={left} active={playing} title="Output level, left and right" />
          <LevelMeter read={right} active={playing} title="Output level, left and right" />
        </div>
        <button type="button" className="pe-zoom-menu" title="Viewer zoom"
          onClick={(e) => openMenu(ZOOMS.map(([label, z]) => ({ label, checked: z === zoom, action: () => setZoom(z) })),
            { anchor: e.currentTarget.getBoundingClientRect(), minWidth: 90 })}>
          <span>{zoomLabel}</span>
          <Glyph symbol="chevron.down" size={7.5} weight="bold" />
        </button>
        <IconButton
          symbol={viewerOnly ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"}
          size={28}
          help={viewerOnly ? "Exit Full Screen (F or Esc)" : shortcuts.help("fullScreenViewer", "Full Screen Viewer")}
          onClick={() => void playback.toggleViewerFullScreen()}
        />
      </div>
      <div className="pe-transport-centre">
        <IconButton symbol="backward.end.fill" size={32} help={shortcuts.help("previousEdit")} onClick={() => playback.jumpToEdit(false)} />
        <IconButton symbol="backward.frame.fill" size={32} help={shortcuts.help("stepBack")} onClick={() => playback.step(-1)} />
        <PlayButton playing={playing} />
        <IconButton symbol="forward.frame.fill" size={32} help={shortcuts.help("stepForward")} onClick={() => playback.step(1)} />
        <IconButton symbol="forward.end.fill" size={32} help={shortcuts.help("nextEdit")} onClick={() => playback.jumpToEdit(true)} />
      </div>
    </div>
  );
}

function PlayButton({ playing }: { playing: boolean }) {
  return (
    <button type="button" className="pe-play" title={shortcuts.help("playPause")} aria-label={playing ? "Pause" : "Play"} onClick={playback.togglePlay}>
      <span className="disc">
        <Glyph symbol={playing ? "pause.fill" : "play.fill"} size={17} weight="bold" style={playing ? undefined : { transform: "translateX(1.5px)" }} />
      </span>
    </button>
  );
}

/** The current time. Click to type a time: Return or clicking away goes there, Esc cancels. */
function TimecodeField({ time, fps, style }: { time: number; fps: number; style: "timecode" | "simple" }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
  }, [editing]);
  const commit = () => {
    if (!cancelled.current) {
      const t = parseTimecode(text, fps, style);
      if (t !== undefined) playback.seekTo(t);
    }
    cancelled.current = false;
    setEditing(false);
  };
  return (
    <div className={`pe-timecode mono${editing ? " editing" : ""}`} title="Click to type a time"
      onClick={() => { if (!editing) { setText(timecode(time, fps, style)); cancelled.current = false; setEditing(true); } }}>
      {editing ? (
        <input
          ref={input}
          value={text}
          spellCheck={false}
          size={Math.max(8, text.length)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); input.current?.blur(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; input.current?.blur(); }
          }}
        />
      ) : (
        timecode(time, fps, style)
      )}
    </div>
  );
}
