// The menu bar drawn in the title bar, for Windows (and the browser build), from the same description
// as the macOS native menu (menuModel.ts). Moving across the titles while one is open switches menus.

import { useRef, useState } from "react";
import { closeMenu, menuIsOpen, openMenu, type MenuItem } from "../menu";
import { buildMenus, comboText, type MenuNode } from "./menuModel";

function toItems(nodes: MenuNode[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const n of nodes) {
    if (n.kind === "separator") out.push({ separator: true });
    else if (n.kind === "submenu") out.push({ label: n.text, enabled: n.enabled ?? true, submenu: toItems(n.items) });
    else if (n.kind === "item") out.push({ label: n.text, action: n.run, enabled: n.enabled, checked: n.checked, shortcut: comboText(n.combo) });
  }
  return out;
}

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Built when a menu opens, so enabled states are current.
  const titles = buildMenus().map((m) => m.text);
  const show = (i: number) => {
    const el = refs.current[i];
    if (!el) return;
    const menu = buildMenus()[i];
    setOpen(i);
    openMenu(toItems(menu.items), { anchor: el.getBoundingClientRect(), minWidth: 220 }, () => setOpen((o) => (o === i ? null : o)));
  };
  return (
    <div className="pe-menubar" role="menubar" data-menu-anchor>
      {titles.map((t, i) => (
        <button
          key={t}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="menuitem"
          className={open === i ? "open" : undefined}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (open === i && menuIsOpen()) closeMenu();
            else show(i);
          }}
          onPointerEnter={() => { if (open !== null && open !== i && menuIsOpen()) show(i); }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
