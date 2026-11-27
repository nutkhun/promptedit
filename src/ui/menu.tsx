// Pop-up and context menus drawn in the page (so they work in the browser build and theme with the
// app). One menu at a time; it closes on a pick, Esc, a click outside or the window losing focus.
//
//   onContextMenu={contextMenu(() => [{ label: "Add Text", action: addText }, SEP, …])}
//   openMenu(items, { anchor: buttonEl.getBoundingClientRect() })   // a drop-down under a field

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import { Glyph } from "./icons";
import "./menu.css";

export type MenuItem =
  | { label: string; action?: () => void; enabled?: boolean; checked?: boolean; shortcut?: string; submenu?: MenuItem[] }
  | { separator: true }
  | { header: string };
export const SEP: MenuItem = { separator: true };

interface Placement { x: number; y: number; anchor?: DOMRect; minWidth?: number }
interface OpenMenu { items: MenuItem[]; at: Placement; onClose?: () => void }

const useMenu = create<{ open?: OpenMenu }>(() => ({}));

/** Opens a menu at a point (context menu) or under an element's rect (drop-down). */
export function openMenu(items: MenuItem[], at: { x?: number; y?: number; anchor?: DOMRect; minWidth?: number }, onClose?: () => void) {
  const x = at.x ?? at.anchor?.left ?? 0;
  const y = at.y ?? (at.anchor ? at.anchor.bottom + 4 : 0);
  useMenu.setState({ open: { items: tidy(items), at: { x, y, anchor: at.anchor, minWidth: at.minWidth ?? at.anchor?.width }, onClose } });
}
export const closeMenu = () => {
  const o = useMenu.getState().open;
  useMenu.setState({ open: undefined });
  o?.onClose?.();
};
export const menuIsOpen = () => useMenu.getState().open !== undefined;

/** A right-click handler that opens the menu `build` returns (nothing when it returns []). */
export function contextMenu(build: (e: ReactMouseEvent) => MenuItem[]) {
  return (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items = build(e);
    if (items.length) openMenu(items, { x: e.clientX, y: e.clientY });
  };
}

/** No separator at either end or two in a row (Editroom's MenuCleanup). */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if ("separator" in it && (out.length === 0 || "separator" in out[out.length - 1])) continue;
    out.push("submenu" in it && it.submenu ? { ...it, submenu: tidy(it.submenu) } : it);
  }
  while (out.length && "separator" in out[out.length - 1]) out.pop();
  return out;
}

/** Renders the open menu. Mounted once by the app shell. */
export function MenuLayer() {
  const open = useMenu((s) => s.open);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      // Clicks on the menu, or on what opened it (a menu bar title toggles it itself), aren't "away".
      if (!(e.target as HTMLElement).closest?.(".pe-menu, [data-menu-anchor]")) closeMenu();
    };
    const blur = () => closeMenu();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
    };
  }, [open]);
  if (!open) return null;
  return <MenuPanel items={open.items} at={open.at} root />;
}

function MenuPanel({ items, at, root = false }: { items: MenuItem[]; at: Placement; root?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: at.x, y: at.y });
  const [hot, setHot] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);

  // Keep on screen: flip above an anchor / to the left of a point when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let { x, y } = at;
    if (x + r.width > window.innerWidth - 4) x = Math.max(4, (root && !at.anchor ? at.x - r.width : window.innerWidth - r.width - 4));
    if (y + r.height > window.innerHeight - 4) {
      y = at.anchor ? Math.max(4, at.anchor.top - r.height - 4) : Math.max(4, window.innerHeight - r.height - 4);
    }
    setPos({ x, y });
  }, [at, root]);

  const choose = (it: MenuItem) => {
    if (!("label" in it) || it.enabled === false || it.submenu) return;
    closeMenu();
    it.action?.();
  };

  useEffect(() => {
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const usable = items.map((it, i) => ("label" in it && it.enabled !== false ? i : -1)).filter((i) => i >= 0);
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!usable.length) return;
        const at = usable.indexOf(hot);
        const next = e.key === "ArrowDown" ? usable[(at + 1) % usable.length] : usable[(at - 1 + usable.length) % usable.length];
        setHot(next ?? usable[0]);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (hot >= 0) choose(items[hot]);
      } else {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const hasChecks = items.some((it) => "label" in it && it.checked !== undefined);
  return (
    <>
      <div ref={ref} className="pe-menu" role="menu" data-modal-open style={{ left: pos.x, top: pos.y, minWidth: Math.max(160, at.minWidth ?? 0) }}
        onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) => {
          if ("separator" in it) return <div key={i} className="pe-menu-sep" />;
          if ("header" in it) return <div key={i} className="pe-menu-header">{it.header}</div>;
          const off = it.enabled === false;
          return (
            <div
              key={i}
              role="menuitem"
              aria-disabled={off}
              className={`pe-menu-item${off ? " off" : ""}${hot === i ? " hot" : ""}`}
              onPointerEnter={(e) => {
                setHot(off ? -1 : i);
                setSub(it.submenu && !off ? { index: i, rect: e.currentTarget.getBoundingClientRect() } : null);
              }}
              onClick={() => choose(it)}
            >
              {hasChecks && <span className="check">{it.checked ? <Glyph symbol="checkmark" size={10} weight="semibold" /> : null}</span>}
              <span className="text">{it.label}</span>
              {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
              {it.submenu && <span className="chev"><Glyph symbol="chevron.right" size={9} weight="semibold" /></span>}
            </div>
          );
        })}
      </div>
      {sub && "label" in items[sub.index] && (items[sub.index] as { submenu?: MenuItem[] }).submenu && (
        <MenuPanel items={(items[sub.index] as { submenu: MenuItem[] }).submenu} at={{ x: sub.rect.right + 2, y: sub.rect.top - 5 }} />
      )}
    </>
  );
}
