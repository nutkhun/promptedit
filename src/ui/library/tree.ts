// The Media panel's folders, worked out from the project (Editroom MediaFolders.swift `MediaTree`):
// the linked folders at the top, and inside each, the folders its files are in. Folders inside a linked
// folder aren't stored; where an item sits in Media is where its file sits on disk. A folder is named by
// its path (in the path's own spelling, `/` or `\`).

import type { Id, MediaAsset, MediaFolder, Project } from "../../model";

/** Whether `path` is `folder` or inside it (either separator). */
export function contains(folder: string, path: string): boolean {
  if (path === folder) return true;
  const f = folder.replace(/[\\/]+$/, "");
  return path.startsWith(`${f}/`) || path.startsWith(`${f}\\`);
}

/** The folder a path is in (Swift `deletingLastPathComponent`). */
export function parentOf(path: string): string {
  const t = path.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i < 0 ? "" : i === 0 ? t.slice(0, 1) : t.slice(0, i);
}

/** The last part of a path. */
export const nameOf = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

const sepOf = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");

/** Finder-like name order (`localizedStandardCompare`): case-insensitive, numbers by value. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const naturalCompare = (a: string, b: string) => collator.compare(a, b);

export class MediaTree {
  readonly roots: MediaFolder[];
  /** For each item in a linked folder, the folder its file is in. */
  private readonly place = new Map<Id, string>();

  constructor(project: Pick<Project, "assets" | "folders">) {
    this.roots = [...(project.folders ?? [])].sort((a, b) => naturalCompare(nameOf(a.path), nameOf(b.path)));
    for (const a of project.assets) {
      if (this.linkedFolderHolding(a.path)) this.place.set(a.id, parentOf(a.path));
    }
  }

  /** The linked folder that holds a path (the innermost, if nested). */
  linkedFolderHolding(path: string): MediaFolder | undefined {
    let best: MediaFolder | undefined;
    for (const f of this.roots) if (contains(f.path, path) && (!best || f.path.length > best.path.length)) best = f;
    return best;
  }

  /** The folder an item is shown in; null for the top of the panel. */
  folderOf(asset: Pick<MediaAsset, "id">): string | null {
    return this.place.get(asset.id) ?? null;
  }

  rootOf(folder: string): MediaFolder | undefined {
    return this.linkedFolderHolding(folder);
  }

  isRoot(folder: string): boolean {
    return this.roots.some((r) => r.path === folder);
  }

  /** Whether a folder can be shown: a linked folder, or a folder with something in it. */
  exists(folder: string): boolean {
    if (this.isRoot(folder)) return true;
    for (const p of this.place.values()) if (contains(folder, p)) return true;
    return false;
  }

  /** The folders shown inside `folder` (null: the top), in name order. */
  foldersIn(folder: string | null): string[] {
    if (folder === null) return this.roots.map((r) => r.path);
    const sep = sepOf(folder);
    const base = folder.replace(/[\\/]+$/, "");
    const names = new Set<string>();
    for (const p of this.place.values()) {
      if (!contains(base, p) || p === base) continue;
      const first = p.slice(base.length + 1).split(/[\\/]/)[0];
      if (first) names.add(first);
    }
    return [...names].sort(naturalCompare).map((n) => `${base}${sep}${n}`);
  }

  /** The items shown directly in `folder` (null: the top), in the library's order. */
  assetsIn<T extends Pick<MediaAsset, "id">>(folder: string | null, all: T[]): T[] {
    return all.filter((a) => (this.place.get(a.id) ?? null) === folder);
  }

  /** The items in a folder and every folder inside it. */
  assetsUnder<T extends Pick<MediaAsset, "id">>(folder: string, all: T[]): T[] {
    return all.filter((a) => {
      const p = this.place.get(a.id);
      return p !== undefined && contains(folder, p);
    });
  }

  countUnder(folder: string): number {
    let n = 0;
    for (const p of this.place.values()) if (contains(folder, p)) n++;
    return n;
  }

  /** The folder's path in the panel: its linked folder's name and the folders inside, "B-roll / Drone". */
  label(folder: string): string {
    const r = this.rootOf(folder);
    if (!r) return nameOf(folder);
    const rest = folder.slice(r.path.length).split(/[\\/]/).filter(Boolean);
    return [nameOf(r.path), ...rest].join(" / ");
  }

  /** The folders from the top down to `folder`. */
  trail(folder: string): string[] {
    const r = this.rootOf(folder);
    if (!r) return [folder];
    const out = [r.path];
    let p = r.path.replace(/[\\/]+$/, "");
    const sep = sepOf(r.path);
    for (const part of folder.slice(r.path.length).split(/[\\/]/).filter(Boolean)) {
      p += sep + part;
      out.push(p);
    }
    return out;
  }

  /** The folder one up from `folder` in the panel; null when that's the top. */
  up(folder: string): string | null {
    const t = this.trail(folder);
    return t.length > 1 ? t[t.length - 2] : null;
  }

  /** The nearest folder at or above `folder` that's still there (null: the top). */
  nearest(folder: string | null): string | null {
    let f = folder;
    while (f !== null && !this.exists(f)) f = this.rootOf(f) ? parentOf(f) || null : null;
    return f;
  }
}
