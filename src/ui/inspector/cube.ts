// Grade looks: the built-in names and loading a .cube LUT (docs/spec/01-model.md §2.12;
// Editroom's BuiltInLook and CubeLUT).

import { open } from "@tauri-apps/plugin-dialog";
import { fileURL, inTauri } from "../../api";

/** Built-in looks, in menu order (exact names stored in the project). */
export const BUILT_IN_LOOKS = [
  "Warm film", "Golden hour", "Film print", "Teal and orange", "Pastel", "Bleach bypass", "Mono", "Cool night",
];
/** Retired but still read from older projects. */
const RETIRED_LOOKS = ["Faded"];

export const isBuiltInLook = (look: string) => BUILT_IN_LOOKS.includes(look) || RETIRED_LOOKS.includes(look);

/** What the Look menu shows: the look's name, or a .cube file's name without its extension. */
export function lookLabel(look: string | undefined | null): string {
  if (!look) return "None";
  if (isBuiltInLook(look)) return look;
  const name = look.split(/[\\/]/).pop() ?? look;
  return name.replace(/\.[^.]*$/, "");
}

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Whether a .cube file is a 3D LUT Editroom can read: a LUT_3D_SIZE of 2…256 and exactly size³
 * RGB rows (comments and other keywords ignored).
 */
export function isReadableCube(text: string): boolean {
  let size = 0, rows = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(" ").filter(Boolean);
    if (parts[0] === "LUT_3D_SIZE" && parts.length > 1) {
      size = /^[+-]?\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 0;
    } else if (parts.length === 3 && parts.every((p) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(p))) {
      rows++;
    }
  }
  return size >= 2 && size <= 256 && rows === size * size * size;
}

/** Asks for a .cube file: the system file dialog in the app, else (browser dev mode) a file chooser. */
export async function chooseCubeFile(): Promise<string | undefined> {
  if (inTauri) {
    try {
      const picked = await open({ multiple: false, directory: false, filters: [{ name: "3D LUT", extensions: ["cube"] }] });
      return picked ?? undefined;
    } catch {
      // The dialog couldn't open (e.g. not allowed in this window): use the web file chooser below.
    }
  }
  const file = await pickWithInput();
  if (!file) return undefined;
  // Webviews hide a chosen file's location; some (Electron-style) expose it as `path`.
  const path = (file as File & { path?: string }).path;
  if (path) return path;
  const typed = window.prompt(`Where is “${file.name}”? Enter its full path.`, file.name);
  return typed?.trim() || undefined;
}

function pickWithInput(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".cube";
    input.style.display = "none";
    let done = false;
    const finish = (f?: File) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener("change", () => finish(input.files?.[0]));
    input.addEventListener("cancel", () => finish(undefined));
    document.body.appendChild(input);
    input.click();
  });
}

/** Reads the file the look would use and checks it. */
export async function checkCube(path: string): Promise<boolean> {
  try {
    const r = await fetch(fileURL(path));
    if (!r.ok) return false;
    return isReadableCube(await r.text());
  } catch {
    return false;
  }
}
