#!/usr/bin/env node
// The app's version lives in four places that must agree: package.json, src-tauri/tauri.conf.json
// (what the updater compares and the installers are named after), the workspace Cargo.toml and
// Cargo.lock (CI builds with --locked).
//
//   node scripts/version.mjs              print the version (fails if the files disagree)
//   node scripts/version.mjs 0.2.0        set it everywhere
//   node scripts/version.mjs --check v0.2.0   fail unless every file says 0.2.0 (CI, on a tag)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The workspace's own crates, whose Cargo.lock entries carry the workspace version. */
const CRATES = ["promptedit", "promptedit-core"];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v0.2.0" (a tag) or "0.2.0" → "0.2.0"; throws if it isn't a semantic version. */
export function normalizeVersion(input) {
  const version = String(input ?? "").trim().replace(/^v/, "");
  if (!SEMVER.test(version)) throw new Error(`“${input}” isn't a version like 1.2.3`);
  return version;
}

/** The [workspace.package] version line in the root Cargo.toml. */
const WORKSPACE_VERSION = /(\[workspace\.package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;
const lockEntry = (name) => new RegExp(`(\\[\\[package\\]\\]\\nname = "${name.replace(/[-]/g, "\\-")}"\\nversion = ")([^"]+)(")`);

/** Reads each file's version. */
export function readVersions(files) {
  const out = {
    "package.json": JSON.parse(files["package.json"]).version,
    "src-tauri/tauri.conf.json": JSON.parse(files["src-tauri/tauri.conf.json"]).version,
    "Cargo.toml": WORKSPACE_VERSION.exec(files["Cargo.toml"])?.[2],
  };
  for (const name of CRATES) out[`Cargo.lock (${name})`] = lockEntry(name).exec(files["Cargo.lock"])?.[2];
  return out;
}

/** The files with `version` set; JSON keeps its layout, TOML only has the one value changed. */
export function setVersion(files, version) {
  const json = (text) => {
    const data = JSON.parse(text);
    data.version = version;
    return JSON.stringify(data, null, 2) + "\n";
  };
  const replace = (text, re, what) => {
    if (!re.test(text)) throw new Error(`No version found in ${what}`);
    return text.replace(re, `$1${version}$3`);
  };
  let lock = files["Cargo.lock"];
  for (const name of CRATES) lock = replace(lock, lockEntry(name), `Cargo.lock for ${name}`);
  return {
    "package.json": json(files["package.json"]),
    "src-tauri/tauri.conf.json": json(files["src-tauri/tauri.conf.json"]),
    "Cargo.toml": replace(files["Cargo.toml"], WORKSPACE_VERSION, "Cargo.toml [workspace.package]"),
    "Cargo.lock": lock,
  };
}

const FILES = ["package.json", "src-tauri/tauri.conf.json", "Cargo.toml", "Cargo.lock"];
const load = (root) => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(root, f), "utf8")]));

function agreed(versions) {
  const values = new Set(Object.values(versions));
  return values.size === 1 && !values.has(undefined) ? [...values][0] : null;
}

function describe(versions) {
  return Object.entries(versions).map(([file, v]) => `  ${file}: ${v ?? "(none)"}`).join("\n");
}

export function main(args, root = ROOT) {
  const files = load(root);
  if (args[0] === "--check") {
    const want = normalizeVersion(args[1]);
    const versions = readVersions(files);
    const bad = Object.entries(versions).filter(([, v]) => v !== want);
    if (bad.length) {
      throw new Error(`The tag says ${want}, but:\n${describe(Object.fromEntries(bad))}\nRun: node scripts/version.mjs ${want}`);
    }
    console.log(`Version ${want} everywhere.`);
    return want;
  }
  if (args[0]) {
    const version = normalizeVersion(args[0]);
    // WiX (the Windows .msi) takes only a number after the dash, and fails the build otherwise.
    if (/-(?!\d+(?:\+|$))/.test(version)) console.warn(`warning: the Windows MSI installer needs a numeric pre-release (like ${version.split("-")[0]}-1).`);
    const next = setVersion(files, version);
    for (const f of FILES) writeFileSync(join(root, f), next[f]);
    console.log(`Version set to ${version} in ${FILES.join(", ")}.`);
    return version;
  }
  const versions = readVersions(files);
  const version = agreed(versions);
  if (!version) throw new Error(`The versions disagree:\n${describe(versions)}`);
  console.log(version);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
