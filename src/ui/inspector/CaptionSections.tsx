// Caption track focused or captions picked: the picked caption's words, and the style every caption
// shares (docs/spec/04-ui.md §1.5 Caption / Style; docs/spec/01-model.md §3.20). Sliders are one
// undo step per drag, the eye toggles one step each, colour wells auto-commit after a pause.

import { useEffect, useRef, useState } from "react";
import type { CaptionStyle, RGBA } from "../../model";
import { useStore, store } from "../../store";
import { captionBlocks, captionProvider, useCaptions, type CaptionBlock } from "../../timeline/captions";
import { ColourWell, InspectorSection, ParamRow, RowIcon } from "../controls";
import { Icon } from "./glyphs";
import { flushAutoCommit, sendAutoCommit } from "./live";
import { useCaptionText } from "./captionText";
import { useGesture } from "./useGesture";
import { whole } from "./values";

const SIZE_RANGE = [28, 140] as const;

export function CaptionSections() {
  const track = useStore((s) => s.project.captions);
  const project = useStore((s) => s.project);
  const picked = useCaptions((s) => s.selection);
  useCaptions((s) => s.version);
  if (!track) return null;
  const blocks = captionBlocks(project).filter((b) => picked.has(b.id));
  const waiting = captionProvider()?.waiting() ?? false;
  return (
    <>
      {blocks.length === 1 && (
        <InspectorSection title="Caption">
          <CaptionTextField block={blocks[0]} />
          <div className="insp-note">
            Fixed here, a word stays fixed wherever this clip is used. Delete leaves the caption's words out.
          </div>
        </InspectorSection>
      )}
      <StyleSection style={track.style} waiting={waiting} />
    </>
  );
}

const currentStyle = (): CaptionStyle | undefined => store().project.captions?.style;

function StyleSection({ style, waiting }: { style: CaptionStyle; waiting: boolean }) {
  const edit = useStore((s) => s.edit);
  const size = useGesture<number, CaptionStyle | undefined>({
    capture: currentStyle,
    make: (v, o) => (o ? [{ op: "setCaptionStyle", style: { ...o, size: Math.round(v) } }] : []),
  });
  const position = useGesture<number, CaptionStyle | undefined>({
    capture: currentStyle,
    make: (v, o) => (o ? [{ op: "setCaptionStyle", style: { ...o, y: Math.round((v / 100) * 1000) / 1000 } }] : []),
  });
  const toggle = (key: "highlight" | "outline") => {
    const s = currentStyle();
    if (s) void edit({ op: "setCaptionStyle", style: { ...s, [key]: !s[key] } });
  };
  const colour = (key: "textColor" | "highlightColor" | "outlineColor") => (c: RGBA) => {
    const s = currentStyle();
    if (s) sendAutoCommit([{ op: "setCaptionStyle", style: { ...s, [key]: c } }]);
  };

  return (
    <InspectorSection title="Style">
      <ParamRow icon="textformat.size" label="Size" value={style.size} range={SIZE_RANGE} format={whole} live={size} />
      <ParamRow icon="arrow.up.and.down" label="Position" value={style.y * 100} range={[10, 95]}
        format={(v) => `${whole(v)}%`} live={position} />
      <ColourRow label="Text" icon="textformat" color={style.textColor} onChange={colour("textColor")} />
      <ColourRow label="Word highlight" icon="highlighter" on={style.highlight} onToggle={() => toggle("highlight")}
        color={style.highlightColor} onChange={colour("highlightColor")} />
      <ColourRow label="Outline" icon="a.square" on={style.outline} onToggle={() => toggle("outline")}
        color={style.outlineColor} onChange={colour("outlineColor")} />
      {waiting && <div className="insp-note">Listening for what's said in the captioned clips…</div>}
    </InspectorSection>
  );
}

/** A caption colour: its well, and for a part that can be off (highlight, outline) an eye to show or hide it. */
function ColourRow({ label, icon, on, onToggle, color, onChange }: {
  label: string;
  icon: string;
  on?: boolean;
  onToggle?: () => void;
  color: RGBA;
  onChange: (c: RGBA) => void;
}) {
  const off = on === false;
  return (
    <div className="ctl-row" data-param={label}>
      <RowIcon symbol={icon} dim={off} />
      <span className="ctl-row-label auto" style={off ? { color: "var(--text-faint)" } : undefined}>{label}</span>
      <span className="ctl-spacer" />
      {on !== undefined && onToggle && (
        <button className={`insp-eye${on ? "" : " off"}`} onClick={onToggle} title={on ? "Hide" : "Show"}>
          <Icon symbol={on ? "eye" : "eye.slash"} size={9.5} weight="semibold" />
        </button>
      )}
      <ColourWell color={color} onChange={onChange} onDone={() => void flushAutoCommit()} dim={off} />
    </div>
  );
}

/**
 * The picked caption's words, retyped in place: shown in the viewer as typed, set on Return or
 * when the field is left, Esc puts them back. Read-only until a captions editor is registered.
 */
function CaptionTextField({ block }: { block: CaptionBlock }) {
  const editor = useCaptionText((s) => s.editor);
  const request = useCaptionText((s) => s.request);
  const [text, setText] = useState(block.text);
  const [focused, setFocused] = useState(false);
  // The caption as it was when typing began: its words are the ones retyped, however the text changes.
  const editing = useRef<CaptionBlock | undefined>(undefined);
  const cancelled = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!focused) setText(block.text); }, [block.text, focused]);
  useEffect(() => {
    if (request === block.id) {
      useCaptionText.setState({ request: undefined });
      ref.current?.focus();
    }
  }, [request, block.id]);
  // Grow with the text: one to four lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 4 * 16.2 + 14)}px`;
  }, [text]);

  return (
    <textarea
      ref={ref}
      className="insp-caption-text"
      rows={1}
      value={text}
      disabled={!editor}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        if (editing.current && editor) editor.type(editing.current, e.target.value);
      }}
      onFocus={() => {
        setFocused(true);
        cancelled.current = false;
        editing.current = block;
        const s = store();
        if (s.playhead < block.start || s.playhead >= block.end) s.seek((block.start + block.end) / 2);
      }}
      onBlur={() => {
        const b = editing.current;
        editing.current = undefined;
        setFocused(false);
        if (b && editor && !cancelled.current) editor.commit(b, text);
        cancelled.current = false;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          if (editing.current && editor) editor.cancel(editing.current);
          setText(block.text);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
