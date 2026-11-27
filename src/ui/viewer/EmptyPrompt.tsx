// What the viewer shows on an empty timeline (§1.4): a dashed drop area with a film frame and an arrow.
// The viewer is black in every theme, so this always uses the Dark palette's colours (viewer.css).

import { primaryKey } from "../../commands";
import { importDialog } from "../shell/files";

export function EmptyPrompt({ hasMedia }: { hasMedia: boolean }) {
  return (
    <div className="pe-empty-prompt">
      <div className={`box${hasMedia ? "" : " clickable"}`} onClick={hasMedia ? undefined : () => void importDialog()}>
        {/* On a 74-wide grid: a film frame with sprocket rows, and an arrow coming down into it. */}
        <svg width="96" height="70" viewBox="0 0 74 54" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <g stroke="var(--prompt-faint)" strokeWidth="1.3" vectorEffect="non-scaling-stroke">
            <rect x="1" y="9" width="58" height="40" rx="5" vectorEffect="non-scaling-stroke" />
            <path d="M1 17H59 M1 41H59 M9 9V17 M19 9V17 M29 9V17 M39 9V17 M49 9V17 M9 41V49 M19 41V49 M29 41V49 M39 41V49 M49 41V49" vectorEffect="non-scaling-stroke" />
          </g>
          <path d="M66 4V24 M59 17L66 24L73 17" stroke="var(--prompt-text)" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="headline">{hasMedia ? "Drag media from the library to the timeline" : "Drop video, audio or images anywhere"}</div>
        <div className="sub">
          {hasMedia
            ? "or double-click it to add it at the playhead"
            : `or press ${primaryKey("i")} to import  ·  MP4, MOV, MKV, WebM, WAV, MP3, JPG, PNG`}
        </div>
      </div>
    </div>
  );
}
