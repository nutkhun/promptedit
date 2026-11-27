// Font family chooser (docs/spec/04-ui.md §1.5 Text): a field with the current family that opens a
// searchable list, each name drawn in its own face. Type to filter; Return picks the first match.

import { useEffect, useMemo, useRef, useState } from "react";
import { Popover, useAnchored } from "../controls";
import { Icon } from "./glyphs";
import { cssFamily, fontFamilies } from "./fonts";

export function FontPicker({ selection, onPick }: { selection: string; onPick: (family: string) => void }) {
  const a = useAnchored<HTMLButtonElement>();
  return (
    <>
      <button ref={a.ref} className={`ctl-menu-field insp-font-field${a.open ? " open" : ""}`} onClick={a.toggle} data-menu="font">
        <span className="ctl-menu-field-label">{selection || "System"}</span>
        <Icon symbol="chevron.down" size={8.5} weight="bold" className="ctl-chevron" />
      </button>
      {a.open && a.ref.current && (
        <Popover anchor={a.ref.current} placement="left" onClose={a.close} style={{ background: "var(--panel)" }}>
          <FontList selection={selection} onPick={(f) => { onPick(f); a.close(); }} />
        </Popover>
      )}
    </>
  );
}

function FontList({ selection, onPick }: { selection: string; onPick: (family: string) => void }) {
  const [families, setFamilies] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    let live = true;
    void fontFamilies().then((f) => live && setFamilies(f));
    return () => { live = false; };
  }, []);

  const matches = useMemo(() => {
    // The clip's font stays listed even if this machine doesn't have it.
    const all = ["", ...families, ...(selection && !families.includes(selection) ? [selection] : [])];
    const q = query.trim().toLowerCase();
    return q ? all.filter((f) => (f || "System").toLowerCase().includes(q)) : all;
  }, [families, query, selection]);

  // Open with the current family in view.
  useEffect(() => {
    if (scrolled.current || families.length === 0) return;
    scrolled.current = true;
    const row = list.current?.querySelector<HTMLElement>("[data-current]");
    row?.scrollIntoView({ block: "center" });
  }, [families]);

  return (
    <div className="insp-fonts" onKeyDown={(e) => e.stopPropagation()}>
      <div className="insp-fonts-search">
        <Icon symbol="magnifyingglass" size={11} />
        <input
          autoFocus
          placeholder="Search fonts"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && matches.length > 0) onPick(matches[0]); }}
        />
      </div>
      <div className="insp-fonts-rule" />
      <div className="insp-fonts-list" ref={list}>
        {matches.map((f) => (
          <button
            key={f || "(system)"}
            className="insp-font-row"
            data-current={f === selection || undefined}
            onClick={() => onPick(f)}
          >
            <span style={{ fontFamily: cssFamily(f) }}>{f || "System"}</span>
            {f === selection && <Icon symbol="checkmark" size={10} weight="bold" className="check" />}
          </button>
        ))}
        {matches.length === 0 && <div className="insp-fonts-empty">No fonts match</div>}
      </div>
    </div>
  );
}
