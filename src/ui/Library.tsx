// The Media panel (docs/spec/04-ui.md §1.3): header with Add Text / Add Solid / Import, a search field,
// imported items as thumbnails or a list, picking (⇧ range, ⌘/Ctrl toggle), double-click to add at the
// playhead, drag to the timeline, context menus, hover-scrub, and the drop overlay for files. Linked
// folders show as folder tiles that open (src/ui/library/folders.ts, FolderItem.tsx).

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { call, inTauri, isMac } from "../api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Snapshot } from "../model";
import { primaryKey, sequenceMatches } from "../commands";
import type { Id, MediaAsset } from "../model";
import { store, useStore } from "../store";
import { IconButton, Spinner } from "./buttons";
import { Glyph } from "./icons";
import { contextMenu, openMenu, SEP, type MenuItem } from "./menu";
import { AssetRow, AssetTile } from "./library/AssetItem";
import { looksForPictures, matches, parseSearch, saidSnippet, showsMatch, useSaidSearch, useShowsSearch } from "./library/search";
import { PictureSearchNote, usePictureSearch } from "./library/PictureSearch";
import { beginMediaDrag } from "./pointerDrag";
import { importDialog, importFolderDialog, showInFolder, showInFolderLabel } from "./shell/files";
import { removeAssets } from "./shell/media";
import { showAlert } from "./Alerts";
import { useReveal } from "./shell/reveal";
import { FolderRow, FolderTile, MediaTitle, MissingFolderBanner, useOpenFolder } from "./library/FolderItem";
import { assetKey, clickPick, folderKey, setPicks, useFolderWatch, useMediaFolders, useMissing } from "./library/folders";
import { MediaTree } from "./library/tree";
import "./library/library.css";

/** Media files that can't be found (checked when the list changes and when the window comes back). */
function useOffline(assets: MediaAsset[]): Set<Id> {
  const [offline, setOffline] = useState<Set<Id>>(new Set());
  // Checked again after every look at the linked folders (a file deleted on disk that a clip uses).
  const looked = useMediaFolders((s) => s.looked);
  const key = assets.map((a) => a.id + a.path).join("|") + `#${looked}`;
  useEffect(() => {
    let live = true;
    const check = async () => {
      const missing = new Set<Id>();
      await Promise.all(assets.map(async (a) => {
        const exists = await call<boolean>("path_exists", { path: a.path }).catch(() => true);
        if (!exists) missing.add(a.id);
      }));
      if (live) setOffline(missing);
    };
    void check();
    window.addEventListener("focus", check);
    return () => { live = false; window.removeEventListener("focus", check); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return offline;
}

export function Library() {
  const assets = useStore((s) => s.project.assets);
  const picked = useStore((s) => s.mediaSelection);
  const layout = useStore((s) => s.mediaLayout);
  const importing = useStore((s) => s.importing > 0);
  const dropHover = useStore((s) => s.dropHover);
  const [search, setSearch] = useState("");
  const [width, setWidth] = useState(252);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const offline = useOffline(assets);
  const folderList = useStore((s) => s.project.folders);
  const tree = useMemo(() => new MediaTree({ assets, folders: folderList }), [assets, folderList]);
  const folder = useOpenFolder(tree);
  const pickedFolders = useMediaFolders((s) => s.picked);
  useFolderWatch();

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Search (§1.3): words in quotes are what's said (transcripts); other words match the name.
  const query = useMemo(() => parseSearch(search), [search]);
  const phrases = query.phrases;
  const searching = search.trim().length > 0;
  // Folders: what's in the one open; while searching, everything inside it (each result says where).
  const pool = useMemo(() => (searching ? (folder ? tree.assetsUnder(folder, assets) : assets) : tree.assetsIn(folder, assets)),
    [searching, folder, tree, assets]);
  const heard = useSaidSearch(pool, query);
  // Plain words also match what's in the picture (scene tags, src/scenes.ts).
  const seen = useShowsSearch(pool, query);
  usePictureSearch(assets);
  const shown = useMemo(() => (searching ? pool.filter((a) => matches(a, query)) : pool),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, query, heard, seen]);
  const folders = useMemo(() => (searching ? [] : tree.foldersIn(folder)), [searching, tree, folder]);
  const missing = useMissing(useMemo(() => [...new Set([...tree.roots.map((r) => r.path), ...folders])], [tree, folders]));
  const openRoot = folder ? tree.rootOf(folder) : undefined;
  const missingRoot = openRoot && missing.has(openRoot.path) ? openRoot : undefined;
  const place = (a: MediaAsset) => {
    const at = searching ? tree.folderOf(a) : null;
    return at && at !== folder ? tree.label(at) : undefined;
  };

  // A hand import (or Reveal in Media): scrolled into view once drawn.
  const reveal = useReveal((s) => s.nonce);
  useEffect(() => {
    const target = useReveal.getState().target;
    if (!target) return;
    setSearch("");
    // An item in a linked folder is shown in its folder (Reveal in Media opens it).
    const a = store().project.assets.find((x) => x.id === target);
    if (a) {
      const t = new MediaTree(store().project);
      if (t.linkedFolderHolding(a.path)) useMediaFolders.setState({ open: t.folderOf(a) });
      else useMediaFolders.setState({ open: null });
    }
    // Twice: once for the folder to open, once for it to be laid out.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const q = `[data-asset="${CSS.escape(target)}"], [data-folder="${CSS.escape(target)}"]`;
      body.current?.querySelector(q)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }));
  }, [reveal]);

  // Picking (⇧ range, ⌘/Ctrl toggle) runs across folders and items, in the order shown.
  const order = useMemo(() => [...folders.map(folderKey), ...shown.map((a) => assetKey(a.id))], [folders, shown]);
  const pickKey = useCallback((key: ReturnType<typeof assetKey>, e: MouseEvent) => {
    e.stopPropagation();
    clickPick(key, order, { shiftKey: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey });
  }, [order]);
  const pick = (id: Id, e: MouseEvent) => pickKey(assetKey(id), e);
  const pickedCount = picked.size + pickedFolders.size;

  const dragIds = (id: Id) => () => {
    const s = store();
    // Dragging one of several picked items takes them all, in the panel's order.
    return s.mediaSelection.has(id) && s.mediaSelection.size > 1 ? s.project.assets.map((a) => a.id).filter((x) => s.mediaSelection.has(x)) : [id];
  };
  const addAtPlayhead = (ids: Id[]) =>
    store().edit({ op: "addAtPlayhead", payloads: ids.map((id) => ({ type: "asset" as const, id })), playhead: store().playhead });

  const assetMenu = (a: MediaAsset) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const s = store();
    const folderPicks = [...useMediaFolders.getState().picked];
    const many = s.mediaSelection.has(a.id) && s.mediaSelection.size + folderPicks.length > 1;
    const ids = many ? [...s.mediaSelection] : [a.id];
    const isOffline = offline.has(a.id);
    const items: MenuItem[] = [];
    if (isOffline) items.push({ label: "Locate…", action: () => void locate(a) }, SEP);
    items.push({ label: "Add to Timeline", action: () => void addAtPlayhead([a.id]) });
    if (a.kind === "video") items.push({ label: "Match Sequence to Clip", enabled: !sequenceMatches(a.id), action: () => void s.edit({ op: "matchSequence", asset: a.id }) });
    items.push({ label: showInFolderLabel, action: () => void showInFolder(a.path) });
    if (!isOffline) items.push({ label: ids.length > 1 ? `Reload ${ids.length} Items from Disk` : "Reload from Disk", action: () => void reload(ids) });
    items.push(SEP, many
      ? { label: `Delete ${ids.length + folderPicks.length} Items`, action: () => void removeAssets(ids, folderPicks) }
      : { label: "Delete", action: () => void removeAssets(ids) });
    openMenu(items, { x: e.clientX, y: e.clientY });
  };

  const panelMenu = contextMenu(() => [
    { label: "Add Text", action: () => void store().edit({ op: "addAtPlayhead", payloads: [{ type: "text" }], playhead: store().playhead }) },
    { label: "Add Solid", action: () => void store().edit({ op: "addAtPlayhead", payloads: [{ type: "solid" }], playhead: store().playhead }) },
    { label: "Import Media…", shortcut: primaryKey("i"), action: () => void importDialog() },
    { label: "Import Folder…", action: () => void importFolderDialog() },
    SEP,
    { header: "View as" },
    { label: "Thumbnails", checked: layout === "thumbnails", action: () => store().setSetting("mediaLayout", "thumbnails") },
    { label: "List", checked: layout === "list", action: () => store().setSetting("mediaLayout", "list") },
  ]);

  const thumbWidth = Math.min(104, Math.max(64, 64 + (width - 252) * 0.21));
  const empty = assets.length === 0 && folders.length === 0;
  const folderProps = (f: string) => ({
    tree, folder: f, missing: missing.has(f), picked: pickedFolders.has(f), pickedCount,
    onPick: (e: MouseEvent) => pickKey(folderKey(f), e),
    onDelete: (all: boolean) => void (all ? removeAssets([...store().mediaSelection], [...pickedFolders]) : removeAssets([], [f])),
    onOpen: () => setSearch(""),
  });

  return (
    <div className="pe-library" ref={panel} onContextMenu={panelMenu}>
      <div className="pe-panel-header pe-library-header">
        {folder ? <MediaTitle tree={tree} folder={folder} /> : <span className="label">Media</span>}
        {importing && <Spinner size={14} style={{ marginLeft: 6, transform: "scale(0.85)" }} />}
        <span style={{ flex: 1 }} />
        <AddButton kind="text" />
        <AddButton kind="solid" />
        <IconButton symbol="square.and.arrow.down" size={26} help={`Import Media (${primaryKey("i")})`} onClick={() => void importDialog()} />
      </div>
      <div className="pe-library-body" ref={body} onClick={() => setPicks([])}>
        {missingRoot && !empty && <MissingFolderBanner id={missingRoot.id} path={missingRoot.path} />}
        <SearchField value={search} onChange={setSearch} placeholder={folder ? "Search folder" : "Search"} />
        {searching && query.words.length > 0 && <PictureSearchNote word={query.words.join(" ")} wanted={looksForPictures(pool, query)} />}
        {empty ? (
          <div className="pe-library-empty">Imported media<br />appears here</div>
        ) : (
          <>
            {layout === "thumbnails" ? (
              <div className="pe-grid">
                {folders.map((f) => <FolderTile key={f} {...folderProps(f)} />)}
                {shown.map((a) => (
                  <AssetTile key={a.id} asset={a} said={saidSnippet(a, query)} shows={searching ? showsMatch(a, query) : undefined} place={place(a)} picked={picked.has(a.id)} offline={offline.has(a.id)} dragIds={dragIds(a.id)}
                    onPick={(e) => pick(a.id, e)} onOpen={() => void addAtPlayhead([a.id])} onMenu={assetMenu(a)} />
                ))}
              </div>
            ) : (
              <div className="pe-list">
                {folders.map((f) => <FolderRow key={f} {...folderProps(f)} thumbWidth={thumbWidth} />)}
                {shown.map((a) => (
                  <AssetRow key={a.id} asset={a} said={saidSnippet(a, query)} shows={searching ? showsMatch(a, query) : undefined} place={place(a)} picked={picked.has(a.id)} offline={offline.has(a.id)} dragIds={dragIds(a.id)} thumbWidth={thumbWidth}
                    onPick={(e) => pick(a.id, e)} onOpen={() => void addAtPlayhead([a.id])} onMenu={assetMenu(a)} />
                ))}
              </div>
            )}
            {searching && shown.length === 0 && folders.length === 0 && (
              <div className="pe-library-nothing">{phrases.length ? `Nothing says ${search.trim()}` : `No media matches “${search.trim()}”`}</div>
            )}
          </>
        )}
      </div>
      {dropHover && (
        <div className="pe-drop-overlay" aria-hidden>
          <div className="fade" />
          <div className="say"><Glyph symbol="arrow.down.to.line" size={11} weight="semibold" /><span>Add to Media</span></div>
        </div>
      )}
    </div>
  );
}

/** Points items at their files again (Locate…, Reload from Disk): probed afresh, same item and clips. */
async function relink(id: Id, path: string) {
  try {
    store().apply(await call<Snapshot>("relink_asset", { asset: id, path }));
  } catch (e) {
    await showAlert({ title: "Locate", text: String(e) });
  }
}

/** Locate…: pick the file where it is now. */
async function locate(a: MediaAsset) {
  let path: string | undefined;
  if (inTauri) {
    const r = await openDialog({ title: `Locate “${a.name}”`, multiple: false, directory: false });
    path = typeof r === "string" ? r : undefined;
  } else {
    path = window.prompt(`Where is “${a.name}” now? (absolute path)`) ?? undefined;
  }
  if (path) await relink(a.id, path);
}

/** Reload from Disk: each file is read again (a file overwritten with a new version updates in place). */
async function reload(ids: Id[]) {
  for (const a of store().project.assets.filter((x) => ids.includes(x.id))) await relink(a.id, a.path);
}

/** Add Text / Add Solid: click adds at the playhead; drag onto the timeline. */
function AddButton({ kind }: { kind: "text" | "solid" }) {
  const help = kind === "text"
    ? "Text: click to add at the playhead, or drag to the timeline"
    : "Solid: click to add at the playhead, or drag to the timeline";
  return (
    <button
      type="button"
      className="pe-add-button"
      title={help}
      aria-label={kind === "text" ? "Add Text" : "Add Solid"}
      onPointerDown={(e) => beginMediaDrag(e, () => [{ type: kind }], () => (kind === "text" ? "Text" : "Solid"))}
      onClick={() => void store().edit({ op: "addAtPlayhead", payloads: [{ type: kind }], playhead: store().playhead })}
    >
      <Glyph symbol={kind === "text" ? "textformat" : "solid"} size={12} />
    </button>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const saying = value.includes('"') || value.includes("“");
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="pe-search" onClick={(e) => { e.stopPropagation(); input.current?.focus(); }}>
      <Glyph symbol={saying ? "text.bubble" : "magnifyingglass"} size={10.5} title={saying ? "Searching what's said in your clips" : undefined}
        style={{ color: saying ? "var(--text)" : "var(--text-faint)" }} />
      <input
        ref={input}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { onChange(""); input.current?.blur(); e.stopPropagation(); } }}
      />
      {value && (
        <button type="button" className="clear" aria-label="Clear search" onClick={() => onChange("")}>
          <Glyph symbol="xmark.circle.fill" size={11} />
        </button>
      )}
    </div>
  );
}
