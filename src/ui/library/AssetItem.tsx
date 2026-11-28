// One Media item, as a tile (Thumbnails layout) or a row (List layout) (LibraryView.swift `AssetTile`,
// `AssetRow`): click picks, double-click adds at the playhead, drag to the timeline, right-click for more.

import type { MouseEvent } from "react";
import { store } from "../../store";
import { beginMediaDrag } from "../pointerDrag";
import type { MediaAsset } from "../../model";
import { shortTime } from "../../timing";
import { MediaThumb } from "./MediaThumb";
import { MiddleText } from "./MiddleText";
import type { Snippet } from "../../captions/said";
import "../../captions/captions.css";
import { PlaceLine } from "./FolderItem";
import "./pictureSearch.css";

/** Drag payload type: a JSON array of asset ids, in the Media panel's order. */
export const MEDIA_DRAG_TYPE = "application/x-promptedit-media";
export const TEXT_DRAG_TYPE = "application/x-promptedit-text";
export const SOLID_DRAG_TYPE = "application/x-promptedit-solid";

export interface ItemProps {
  asset: MediaAsset;
  picked: boolean;
  offline: boolean;
  /** Ids a drag of this item carries (all picked items when it's one of several). */
  dragIds: () => string[];
  onPick: (e: MouseEvent) => void;
  onOpen: () => void;
  onMenu: (e: MouseEvent) => void;
  /** While searching what's said: the words around where it's said. */
  said?: Snippet;
  /** While searching from a folder: the folder this result is in, when that's not the open one. */
  place?: string;
  /** While searching by plain words: what it shows that matched (its scene tags), not in its name. */
  shows?: string[];
}

/** What a search result shows that the search found ("shows beach"), from its scene tags. */
function ShowsLine({ shows }: { shows: string[] }) {
  return <div className="pe-shows" title={`Shows ${shows.join(", ")}`}>shows <b>{shows.join(", ")}</b></div>;
}

/** What a clip says around the words searched for, those words in bold (Editroom `SaidLine`). */
function SaidLine({ said }: { said: Snippet }) {
  return (
    <div className="pe-said">
      “{said.before ? `${said.before} ` : ""}<b>{said.match}</b>{said.after ? ` ${said.after}` : ""}”
    </div>
  );
}

function startDrag(e: React.PointerEvent, ids: () => string[]) {
  beginMediaDrag(
    e,
    () => ids().map((id) => ({ type: "asset" as const, id })),
    () => {
      const list = ids();
      const first = store().project.assets.find((a) => a.id === list[0])?.name ?? "";
      return list.length > 1 ? `${first} + ${list.length - 1} more` : first;
    },
  );
}

const detail = (a: MediaAsset) =>
  a.kind === "video" ? shortTime(a.duration) : a.kind === "audio" ? `${shortTime(a.duration)}  ·  Audio` : "Photo";

/** On hover: everything about the file. */
export function details(a: MediaAsset): string {
  const parts = [a.name];
  if (a.kind !== "image") parts.push(shortTime(a.duration));
  if (a.width > 0) parts.push(`${a.width}×${a.height}`);
  if (a.kind === "video" && a.fps > 0) parts.push(`${Math.round(a.fps * 100) / 100} fps`);
  if (a.kind === "audio") parts.push("Audio");
  return parts.join(" · ");
}

export function AssetTile(p: ItemProps) {
  const { asset } = p;
  return (
    <div
      className={`pe-tile${p.picked ? " picked" : ""}`}
      data-asset={asset.id}
      onPointerDown={(e) => startDrag(e, p.dragIds)}
      onClick={p.onPick}
      onDoubleClick={p.onOpen}
      onContextMenu={p.onMenu}
      title={details(asset)}
    >
      <div className="pe-tile-picture">
        <MediaThumb asset={asset} offline={p.offline} />
        {asset.kind !== "image" && <span className="pe-duration mono">{shortTime(asset.duration)}</span>}
      </div>
      <MiddleText className="pe-tile-name" text={asset.name} />
      {p.place && <PlaceLine place={p.place} />}
      {p.said && <SaidLine said={p.said} />}
      {p.shows && <ShowsLine shows={p.shows} />}
    </div>
  );
}

export function AssetRow(p: ItemProps & { thumbWidth: number }) {
  const { asset } = p;
  return (
    <div
      className={`pe-row${p.picked ? " picked" : ""}`}
      data-asset={asset.id}
      onPointerDown={(e) => startDrag(e, p.dragIds)}
      onClick={p.onPick}
      onDoubleClick={p.onOpen}
      onContextMenu={p.onMenu}
      title={details(asset)}
    >
      <div className="pe-row-picture" style={{ width: p.thumbWidth, height: Math.round((p.thumbWidth * 9) / 16) }}>
        <MediaThumb asset={asset} offline={p.offline} compact />
      </div>
      <div className="pe-row-text">
        <MiddleText className="pe-row-name" text={asset.name} />
        <div className="pe-row-detail mono">{detail(asset)}</div>
        {p.place && <PlaceLine place={p.place} />}
        {p.said && <SaidLine said={p.said} />}
        {p.shows && <ShowsLine shows={p.shows} />}
      </div>
    </div>
  );
}
