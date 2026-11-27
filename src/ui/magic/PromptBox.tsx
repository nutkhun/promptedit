// The Magic prompt box (Editroom's `PromptBox` + `MentionField`): grows with its text (66–198 px,
// then scrolls), shows mentions and recognised times strong, and has the @ list. Return sends,
// Shift-Return is a new line; with the @ list open ↑/↓ move, Return/Tab pick and Esc closes it.
// ↑ in an empty box recalls earlier prompts from history (↓ goes back).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Project } from "../../model";
import { useStore } from "../../store";
import { Glyph } from "../icons";
import { findMentions, mentionOptions, openQuery, recognisedTimes, type MentionOption } from "./mentions";

const MIN = 66;
const MAX = 198;

/** The text with mentions and times wrapped, for the layer drawn under the transparent textarea. */
function highlighted(text: string, p: Project) {
  const marks = [...findMentions(text, p), ...recognisedTimes(text)].sort((a, b) => a[0] - b[0]);
  const parts: (string | { strong: string })[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    parts.push(text.slice(at, s), { strong: text.slice(s, e) });
    at = e;
  }
  parts.push(text.slice(at));
  // A trailing newline needs something after it to take up its line.
  return parts.map((x, i) => (typeof x === "string" ? <span key={i}>{x}</span> : <span key={i} className="strong">{x.strong}</span>)).concat(text.endsWith("\n") ? [<span key="end"> </span>] : []);
}

const ICONS: Record<string, string> = {
  video: "film", audio: "waveform", image: "photo", clock: "clock", text: "textformat", solid: "solid",
  selected: "rectangle.on.rectangle", range: "arrow.left.and.right", media: "folder", clip: "film", marker: "circle.fill",
};
const iconFor = (o: MentionOption) => ICONS[o.icon ?? ""] ?? "circle.dotted";

export function PromptBox({ value, onChange, placeholder, onSubmit, onEscape, autoFocus = true }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSubmit: () => void;
  onEscape: () => void;
  autoFocus?: boolean;
}) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const playhead = useStore((s) => s.playhead);
  const ref = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(MIN);
  const [caret, setCaret] = useState(value.length);
  const [list, setList] = useState<{ at: number; query: string } | null>(null);
  const [hot, setHot] = useState(0);
  const [recall, setRecall] = useState(-1);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Height follows the text: measured on the highlight layer, which wraps the same way.
  useLayoutEffect(() => {
    const h = layer.current?.scrollHeight ?? MIN;
    setHeight(Math.min(MAX, Math.max(MIN, h)));
  }, [value]);

  const range = useMemo<[number, number] | null>(() => {
    const p = project;
    if (p.inPoint == null && p.outPoint == null) return null;
    const a = p.inPoint ?? 0, b = p.outPoint ?? Math.max(0, ...p.clips.map((c) => c.start + c.duration));
    return [Math.min(a, b), Math.max(a, b)];
  }, [project]);
  const options = useMemo(() => (list ? mentionOptions(list.query, project, selection.size, range, playhead) : []), [list, project, selection, range, playhead]);

  const updateList = (text: string, pos: number) => {
    const q = openQuery(text, pos);
    setList(q);
    setHot(0);
  };

  const pick = (o: MentionOption) => {
    if (!list || o.disabled) return;
    const before = value.slice(0, list.at);
    const after = value.slice(caret);
    const insert = `@${o.insert}${o.opens ? "" : " "}`;
    const next = before + insert + after.replace(/^\S*/, "");
    const pos = before.length + insert.length;
    onChange(next);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
      updateList(next, pos);
    });
  };

  const history = project.magicHistory ?? [];

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // IME composition is left alone
    if (list && options.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(options.length - 1, h + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(0, h - 1)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[hot]); return; }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (list) setList(null); else onEscape();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    // Earlier prompts, newest first, from an empty box (or one being recalled).
    if (e.key === "ArrowUp" && (value === "" || recall >= 0) && history.length) {
      e.preventDefault();
      const i = Math.min(history.length - 1, recall + 1);
      setRecall(i);
      onChange(history[i].text);
      return;
    }
    if (e.key === "ArrowDown" && recall >= 0) {
      e.preventDefault();
      const i = recall - 1;
      setRecall(i);
      onChange(i >= 0 ? history[i].text : "");
    }
  };

  return (
    <div className="mg-prompt" style={{ height }}>
      <div ref={layer} className="mg-prompt-layer" aria-hidden>
        {value ? highlighted(value, project) : <span className="mg-placeholder">{placeholder}</span>}
      </div>
      <textarea
        ref={ref}
        className="mg-prompt-input"
        value={value}
        spellCheck={false}
        aria-label="What should Magic do?"
        onChange={(e) => {
          onChange(e.target.value);
          setRecall(-1);
          const pos = e.target.selectionStart ?? e.target.value.length;
          setCaret(pos);
          updateList(e.target.value, pos);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onScroll={(e) => { if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop; }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setList(null), 150)}
      />
      {list && options.length > 0 && (
        <div className="mg-mentions" role="listbox">
          {options.map((o, i) => (
            <div key={o.label + i} role="option" aria-selected={i === hot} aria-disabled={o.disabled}
              className={`mg-mention${i === hot ? " hot" : ""}${o.disabled ? " disabled" : ""}`}
              onMouseEnter={() => setHot(i)} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              {o.tint ? <span className="dot" style={{ background: `var(--marker-${o.tint}, #F2B33D)` }} /> : <Glyph symbol={iconFor(o)} size={10.5} />}
              <span className="name">@{o.label}</span>
              {o.opens && <Glyph symbol="chevron.right" size={8} />}
              <span className="detail">{o.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
