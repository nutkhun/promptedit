// Linked folders in the Media panel (LibraryView.swift "Folders"): a folder as a tile (Thumbnails) or a
// row (List), the panel's title inside a folder (back, and the folder's name), the banner inside a
// folder that can't be found, and the line under a search result saying which folder it's in.

import type { MouseEvent } from "react";
import { isMac } from "../../api";
import { Glyph } from "../icons";
import { openMenu, SEP, type MenuItem } from "../menu";
import { showInFolder, showInFolderLabel } from "../shell/files";
import { locateFolder, openFolder, reloadFolder, useMediaFolders } from "./folders";
import { MiddleText } from "./MiddleText";
import { nameOf, type MediaTree } from "./tree";

/** SF Symbols' `folder`, light, on the icons' 16-point grid. */
function FolderIcon({ size }: { size: number }) {
  const box = size * 1.2;
  return (
    <svg width={box} height={box} viewBox="0 0 16 16" aria-hidden style={{ display: "block", overflow: "visible" }}>
      <path
        d="M1.8 4.4Q1.8 3 3.2 3L6 3Q6.6 3 7 3.5L7.8 4.5L12.8 4.5Q14.2 4.5 14.2 5.9L14.2 11.6Q14.2 13 12.8 13L3.2 13Q1.8 13 1.8 11.6Z M1.8 6.6L14.2 6.6"
        fill="none" stroke="currentColor" strokeWidth={(0.8 * size) / 13} strokeLinejoin="round" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A folder's picture: a faint fill and a folder, so it sits back among the clips' pictures; a warning when it's missing. */
function FolderPicture({ missing, compact }: { missing: boolean; compact?: boolean }) {
  return (
    <div className={`pe-folder-picture${compact ? " compact" : ""}`}>
      <span className="symbol"><FolderIcon size={compact ? 14 : 21} /></span>
      {missing && (
        <span className="missing"><Glyph symbol="exclamationmark.triangle.fill" size={compact ? 11 : 13} /></span>
      )}
    </div>
  );
}

export interface FolderItemProps {
  tree: MediaTree;
  folder: string;
  missing: boolean;
  picked: boolean;
  /** Items and folders picked in the panel, for "Delete N Items". */
  pickedCount: number;
  onPick: (e: MouseEvent) => void;
  /** Deletes the picked things (when this folder is one of several picked) or just this folder. */
  onDelete: (all: boolean) => void;
  /** Opening a folder clears the search. */
  onOpen: () => void;
}

function tooltip(p: FolderItemProps) {
  const name = nameOf(p.folder);
  const n = p.tree.countUnder(p.folder);
  return p.missing
    ? `${name} can't be found. Right-click to locate it.`
    : `${name} · ${n} item${n === 1 ? "" : "s"}. Double-click to open; it follows the folder on your ${isMac ? "Mac" : "computer"}.`;
}

/** A folder's right-click menu (Swift `FolderActions`). */
function folderMenu(p: FolderItemProps, open: () => void) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const root = p.tree.roots.find((r) => r.path === p.folder);
    const items: MenuItem[] = [];
    if (p.missing && root) items.push({ label: "Locate…", action: () => void locateFolder(root.id) }, SEP);
    items.push({ label: "Open", action: open });
    if (!p.missing) {
      items.push({ label: "Reload Folder from Disk", action: () => void reloadFolder(p.folder) });
      items.push({ label: showInFolderLabel, action: () => void showInFolder(p.folder) });
    }
    items.push(SEP);
    if (p.picked && p.pickedCount > 1) items.push({ label: `Delete ${p.pickedCount} Items`, action: () => p.onDelete(true) });
    else items.push({ label: "Delete Folder", action: () => p.onDelete(false) });
    openMenu(items, { x: e.clientX, y: e.clientY });
  };
}

function useOpen(p: FolderItemProps) {
  return () => {
    p.onOpen();
    openFolder(p.folder);
  };
}

export function FolderTile(p: FolderItemProps) {
  const open = useOpen(p);
  const n = p.tree.countUnder(p.folder);
  return (
    <div
      className={`pe-tile pe-folder${p.picked ? " picked" : ""}`}
      data-folder={p.folder}
      onClick={p.onPick}
      onDoubleClick={open}
      onContextMenu={folderMenu(p, open)}
      title={tooltip(p)}
    >
      <div className="pe-tile-picture">
        <FolderPicture missing={p.missing} />
      </div>
      <div className="pe-folder-name">
        <MiddleText className="pe-tile-name" text={nameOf(p.folder)} />
        {!p.missing && <span className="count mono">{n}</span>}
      </div>
    </div>
  );
}

export function FolderRow(p: FolderItemProps & { thumbWidth: number }) {
  const open = useOpen(p);
  const n = p.tree.countUnder(p.folder);
  return (
    <div
      className={`pe-row pe-folder${p.picked ? " picked" : ""}`}
      data-folder={p.folder}
      onClick={p.onPick}
      onDoubleClick={open}
      onContextMenu={folderMenu(p, open)}
      title={tooltip(p)}
    >
      <div className="pe-row-picture" style={{ width: p.thumbWidth, height: Math.round((p.thumbWidth * 9) / 16) }}>
        <FolderPicture missing={p.missing} compact />
      </div>
      <div className="pe-row-text">
        <MiddleText className="pe-row-name" text={nameOf(p.folder)} />
        <div className="pe-row-detail mono">{p.missing ? "Missing" : `${n} item${n === 1 ? "" : "s"}`}</div>
      </div>
    </div>
  );
}

/** The panel's title inside a folder: back (up one folder), and the open folder's name. */
export function MediaTitle({ tree, folder }: { tree: MediaTree; folder: string }) {
  const up = tree.up(folder);
  return (
    <div className="pe-media-title">
      <button
        type="button"
        className="pe-media-back"
        title={up ? `Back to ${nameOf(up)}` : "Back to Media"}
        aria-label={up ? `Back to ${nameOf(up)}` : "Back to Media"}
        onClick={() => openFolder(up)}
      >
        <Glyph symbol="chevron.left" size={10} weight="semibold" />
      </button>
      <span className="label" title={tree.label(folder)}>{nameOf(folder).toUpperCase()}</span>
    </div>
  );
}

/** Inside a linked folder that can't be found: where to find it. */
export function MissingFolderBanner({ id, path }: { id: string; path: string }) {
  return (
    <div className="pe-missing-folder" onClick={(e) => e.stopPropagation()}>
      <Glyph symbol="exclamationmark.triangle.fill" size={10.5} style={{ color: "#F5C518", flex: "none" }} />
      <span className="say">“{nameOf(path)}” can't be found</span>
      <button type="button" className="locate" onClick={() => void locateFolder(id)}>Locate…</button>
    </div>
  );
}

/** Under a search result from another folder: the folder it's in ("Shoot / Drone"), cut at the start. */
export function PlaceLine({ place }: { place: string }) {
  return <div className="pe-place" title={place}><bdi>{place}</bdi></div>;
}

/** The open folder, if it's still there (it can go while open: deleted, or emptied on disk). */
export function useOpenFolder(tree: MediaTree): string | null {
  const open = useMediaFolders((s) => s.open);
  return open !== null && tree.exists(open) ? open : null;
}
