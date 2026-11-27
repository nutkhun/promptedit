// Settings › Shortcuts (docs/spec/04-ui.md §1.8): every action by group, its keys, click to record a
// new one (Esc cancels), right-click to remove or restore, a note when a key is taken from another
// action, and "While skimming, play from" under Play / Pause.

import { useEffect, useRef, useState } from "react";
import { ACTION, ACTIONS, comboFromEvent, defaultsFor, displayCombo, GROUPS, shortcuts, useShortcuts, type ActionId } from "../../commands";
import { useStore } from "../../store";
import { KeyCap, PillButton, Segmented } from "../buttons";
import { Glyph } from "../icons";
import { openMenu } from "../menu";

export function ShortcutSettings() {
  const changed = useShortcuts((s) => s.changed);
  const recording = useShortcuts((s) => s.recording);
  const [search, setSearch] = useState("");
  const [note, setNote] = useState<string>();
  const noteTimer = useRef<number | undefined>(undefined);

  const stop = () => useShortcuts.setState({ recording: undefined });
  const start = (a: ActionId) => useShortcuts.setState({ recording: a });
  const show = (s: string) => {
    setNote(s);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(undefined), 6000);
  };

  // While recording, the next key press is the new shortcut (Esc cancels); nothing else gets it.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { stop(); return; }
      const combo = comboFromEvent(e);
      if (!combo) return; // a modifier on its own: keep listening
      const taken = shortcuts.set(recording, combo);
      if (taken) {
        const t = ACTION[taken].title;
        show(`${displayCombo(combo)} was ${t}'s shortcut, so ${t} no longer has it.`);
      }
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);
  useEffect(() => () => { stop(); window.clearTimeout(noteTimer.current); }, []);

  const q = search.trim().toLowerCase();
  const matches = (a: ActionId) => !q || ACTION[a].title.toLowerCase().includes(q) ||
    shortcuts.combos(a).some((c) => displayCombo(c).toLowerCase().includes(q));
  const showsSkim = matches("playPause") || (!!q && ["skim", "playhead", "space"].some((w) => w.startsWith(q) || q.startsWith(w)));

  return (
    <div className="pe-shortcuts">
      <div className="pe-settings-search">
        <Glyph symbol="magnifyingglass" size={11} style={{ color: "var(--text-faint)" }} />
        <input value={search} placeholder="Search shortcuts" spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="pe-shortcut-groups">
        {GROUPS.map((g) => {
          const actions = ACTIONS.filter((a) => a.group === g && matches(a.id));
          const skim = g === "Playback" && showsSkim;
          if (!actions.length && !skim) return null;
          return (
            <div key={g} className="pe-shortcut-group">
              <div className="pe-settings-label" style={{ paddingLeft: 10 }}>{g}</div>
              <div className="box">
                {skim && !actions.some((a) => a.id === "playPause") && <SkimRow />}
                {actions.map((a) => (
                  <div key={a.id}>
                    <ShortcutRow id={a.id} changed={changed[a.id] !== undefined} recording={recording === a.id}
                      onClick={() => (recording === a.id ? stop() : start(a.id))} onRecord={() => start(a.id)} />
                    {a.id === "playPause" && skim && <SkimRow />}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="pe-shortcuts-footer">
        <span className={`hint${note ? " note" : ""}`}>
          {note ?? (recording ? "Press the new shortcut, or Esc to cancel." : "Click a shortcut to change it. Right-click for more.")}
        </span>
        <PillButton disabled={Object.keys(changed).length === 0} onClick={() => { stop(); shortcuts.resetAll(); }}>Restore Defaults</PillButton>
      </div>
    </div>
  );
}

function ShortcutRow({ id, changed, recording, onClick, onRecord }: {
  id: ActionId; changed: boolean; recording: boolean; onClick: () => void; onRecord: () => void;
}) {
  const combos = shortcuts.combos(id);
  return (
    <div
      className={`pe-shortcut-row${recording ? " recording" : ""}`}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu([
          { label: "Change Shortcut", action: onRecord },
          { label: "Remove Shortcut", enabled: combos.length > 0, action: () => shortcuts.clear(id) },
          { label: `Restore Default (${defaultsFor(id).map((c) => displayCombo(c)).join(", ")})`, enabled: changed, action: () => shortcuts.reset(id) },
        ], { x: e.clientX, y: e.clientY });
      }}
    >
      <span className="title">{ACTION[id].title}</span>
      {changed && <span className="changed" title="Changed from the default" />}
      <span style={{ flex: 1 }} />
      {recording ? (
        <span className="recording-pill">Press keys…</span>
      ) : combos.length === 0 ? (
        <span className="none">None</span>
      ) : (
        <span className="keys">{combos.map((c, i) => <KeyCap key={i}>{displayCombo(c)}</KeyCap>)}</span>
      )}
    </div>
  );
}

/** Under Play / Pause: where Space plays from while skimming. */
function SkimRow() {
  const fromSkimmer = useStore((s) => s.playFromSkimmer);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <div className="pe-skim-row">
      <span>↳  While skimming, play from</span>
      <span style={{ flex: 1 }} />
      <Segmented options={[[false, "Playhead"], [true, "Skimmer"]]} value={fromSkimmer} onChange={(v) => setSetting("playFromSkimmer", v)} />
    </div>
  );
}
