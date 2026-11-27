// A single text clip: its words, font, Bold, colour and size, and its position (docs/spec/04-ui.md
// §1.5 Text; docs/spec/01-model.md §3.20). Words, font, Bold and colour are live edits that become
// a step after a 0.8 s pause; the size and position sliders are one step per drag.
// Also the single solid clip's Fill.

import { useEffect, useRef, useState } from "react";
import type { Clip, RGBA, TextStyle } from "../../model";
import { useStore } from "../../store";
import { Chip, ColourWell, InspectorSection, ParamRow, RowIcon } from "../controls";
import { clipsNow, update } from "./edits";
import { FontPicker } from "./FontPicker";
import { flushAutoCommit, sendAutoCommit } from "./live";
import { useGesture } from "./useGesture";
import { whole } from "./values";

/** The clip's text style as it is now, with a change. */
function styled(id: string, body: (t: TextStyle) => TextStyle) {
  const c = clipsNow([id])[0];
  return c ? [update([id], { text: body({ ...c.text }) })] : [];
}

export function TextSection({ clip }: { clip: Clip }) {
  const id = clip.id;
  // Changes made in quick succession (a font, then Bold) build on each other even before the
  // backend's answer to the first has come back.
  const recent = useRef<{ id: string; text: TextStyle; at: number } | undefined>(undefined);
  const auto = (body: (t: TextStyle) => TextStyle) => {
    const r = recent.current;
    const base = r && r.id === id && performance.now() - r.at < 1500 ? r.text : clipsNow([id])[0]?.text;
    if (!base) return;
    const text = body({ ...base });
    recent.current = { id, text, at: performance.now() };
    sendAutoCommit([update([id], { text })]);
  };
  const size = useGesture<number, void>({
    capture: () => undefined,
    make: (v) => styled(id, (t) => ({ ...t, size: Math.round(v) })),
  });
  return (
    <InspectorSection title="Text">
      <TextEditor value={clip.text.string} onChange={(s) => auto((t) => ({ ...t, string: s }))} />
      <FontPicker selection={clip.text.fontName} onPick={(f) => auto((t) => ({ ...t, fontName: f }))} />
      <div className="ctl-row">
        <Chip label="Bold" on={clip.text.bold} onClick={() => auto((t) => ({ ...t, bold: !t.bold }))} />
        <ColourWell
          color={clip.text.color}
          onChange={(c: RGBA) => auto((t) => ({ ...t, color: { ...c, a: t.color.a } }))}
          onDone={() => void flushAutoCommit()}
        />
      </div>
      <ParamRow icon="textformat.size" label="Size" value={clip.text.size} range={[12, 600]} log format={whole} live={size} />
    </InspectorSection>
  );
}

/** The words: typed text shows as it's typed; pauses make undo steps. */
function TextEditor({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value); }, [value]);
  return (
    <textarea
      className="ctl-textarea"
      value={text}
      spellCheck={false}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        setText(value);
        void flushAutoCommit();
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

/** Position for a text clip, in frame pixels from the centre. No scale: the font size does that. */
export function TextTransformSection({ clip }: { clip: Clip }) {
  const w = useStore((s) => s.project.width), h = useStore((s) => s.project.height);
  const edit = useStore((s) => s.edit);
  const id = clip.id;
  const centred = Math.abs(clip.text.x - 0.5) < 1e-6 && Math.abs(clip.text.y - 0.5) < 1e-6;
  const x = useGesture<number, void>({
    capture: () => undefined,
    make: (v) => styled(id, (t) => ({ ...t, x: 0.5 + Math.round(v) / w })),
  });
  const y = useGesture<number, void>({
    capture: () => undefined,
    make: (v) => styled(id, (t) => ({ ...t, y: 0.5 + Math.round(v) / h })),
  });
  const reset = () => {
    const e = styled(id, (t) => ({ ...t, x: 0.5, y: 0.5 }));
    if (e[0]) void edit(e[0]);
  };
  return (
    <InspectorSection title="Transform" collapsedByDefault marked={!centred}
      action={centred ? undefined : { label: "Reset", onClick: reset }}>
      <ParamRow icon="arrow.left.and.right" label="X" value={(clip.text.x - 0.5) * w} range={[-w / 2, w / 2]} format={whole} live={x} />
      <ParamRow icon="arrow.up.and.down" label="Y" value={(clip.text.y - 0.5) * h} range={[-h / 2, h / 2]} format={whole} live={y} />
    </InspectorSection>
  );
}

/** A solid's colour, as a row like the others. Live, a step after a pause. */
export function SolidSection({ clip }: { clip: Clip }) {
  return (
    <InspectorSection title="Solid">
      <div className="ctl-row">
        <RowIcon symbol="paintbrush" />
        <span className="ctl-row-label">Fill</span>
        <span className="ctl-spacer" />
        <ColourWell
          color={clip.color}
          onChange={(c) => sendAutoCommit([update([clip.id], { color: { ...c, a: clip.color.a } })])}
          onDone={() => void flushAutoCommit()}
        />
      </div>
    </InspectorSection>
  );
}
