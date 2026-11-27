// A native-looking context menu with submenus and check marks (the timeline's NSMenus).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

export type MenuItem =
  | { label: string; action?: () => void; enabled?: boolean; checked?: boolean; submenu?: MenuItem[] }
  | "separator";

interface MenuState {
  open?: { items: MenuItem[]; x: number; y: number; at: number };
}
const useMenu = create<MenuState>(() => ({}));

/** Show a menu at a window point (clientX/Y). */
export function openMenu(items: MenuItem[], x: number, y: number) {
  // No leading, trailing or doubled separators (Editroom tidies its menus the same way).
  const tidy = (list: MenuItem[]) => list.filter((it, i, a) => it !== "separator" || (i > 0 && i < a.length - 1 && a[i - 1] !== "separator"));
  useMenu.setState({ open: { items: tidy(items), x, y, at: performance.now() } });
}
export const closeMenu = () => useMenu.setState({ open: undefined });

function Panel({ items, x, y, depth }: { items: MenuItem[]; x: number; y: number; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | undefined>();

  // Keep the menu on screen: flip left/up when it would run past the window edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x, ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = depth > 0 ? x - r.width - 180 + 4 : Math.max(4, window.innerWidth - r.width - 4);
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: Math.max(4, nx), y: ny });
  }, [x, y, depth]);

  return (
    <>
      <div ref={ref} className="tl-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) => {
          if (it === "separator") return <div key={i} className="tl-menu-sep" />;
          const enabled = it.enabled !== false;
          return (
            <div key={i}
              className={`tl-menu-item${enabled ? "" : " disabled"}${sub?.index === i ? " open" : ""}`}
              onPointerEnter={(e) => {
                if (it.submenu && enabled) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSub({ index: i, x: r.right - 2, y: r.top - 5 });
                } else setSub(undefined);
              }}
              onPointerUp={() => {
                // The release of the click that opened the menu doesn't pick an item.
                const opened = useMenu.getState().open?.at ?? 0;
                if (!enabled || it.submenu || performance.now() - opened < 250) return;
                closeMenu();
                it.action?.();
              }}>
              <span className="tl-menu-check">{it.checked ? "✓" : ""}</span>
              <span className="tl-menu-label">{it.label}</span>
              {it.submenu && <span className="tl-menu-arrow">›</span>}
            </div>
          );
        })}
      </div>
      {sub && (() => {
        const it = items[sub.index];
        return it !== "separator" && it.submenu ? <Panel items={it.submenu} x={sub.x} y={sub.y} depth={depth + 1} /> : null;
      })()}
    </>
  );
}

/** Mount once; renders whatever menu is open. */
export function MenuHost() {
  const open = useMenu((s) => s.open);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".tl-menu")) closeMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", closeMenu);
    };
  }, [open]);
  if (!open) return null;
  return createPortal(<Panel items={open.items} x={open.x} y={open.y} depth={0} />, document.body);
}
