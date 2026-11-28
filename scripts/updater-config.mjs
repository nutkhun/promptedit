#!/usr/bin/env node
// Sets up a build for automatic updates (CI runs it before `tauri build`; see README › Releasing).
//
// The update key pair isn't in the repository. Its public half comes from the repository variable
// TAURI_UPDATER_PUBKEY and goes into `plugins.updater.pubkey` (the app only checks for updates when
// it has one: src-tauri/src/updates.rs). Signed updater bundles (`bundle.createUpdaterArtifacts`)
// are made only when the private half, the secret TAURI_SIGNING_PRIVATE_KEY, is there too: the Tauri
// CLI fails without it. With neither, the config is left as it is and the build doesn't check.
//
//   TAURI_UPDATER_PUBKEY=… TAURI_SIGNING_PRIVATE_KEY=… node scripts/updater-config.mjs [--config path] [--dry-run]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePublicKey, publicKeyId } from "./minisign.mjs";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "tauri.conf.json");

/**
 * The config with the updater set up for these keys, and what was done (for the log). Throws if the
 * public key isn't one, so a mistyped variable fails the build instead of shipping a build that can
 * never verify an update.
 */
export function configureUpdater(config, { pubkey, hasPrivateKey }) {
  const next = structuredClone(config);
  const key = (pubkey ?? "").trim();
  const notes = [];
  next.plugins ??= {};
  next.plugins.updater ??= {};
  next.bundle ??= {};
  if (key) {
    parsePublicKey(key);
    next.plugins.updater.pubkey = key;
    notes.push(`Checks for updates, trusting key ${publicKeyId(key)}.`);
  } else {
    next.plugins.updater.pubkey = "";
    notes.push("No TAURI_UPDATER_PUBKEY: this build doesn't check for updates.");
  }
  if (!next.plugins.updater.endpoints?.length) throw new Error("plugins.updater.endpoints is empty in tauri.conf.json.");
  next.bundle.createUpdaterArtifacts = Boolean(key && hasPrivateKey);
  if (next.bundle.createUpdaterArtifacts) notes.push("Signing updater bundles.");
  else if (hasPrivateKey) notes.push("warning: TAURI_SIGNING_PRIVATE_KEY is set but TAURI_UPDATER_PUBKEY isn't, so no updater bundles are made.");
  else if (key) notes.push("warning: no TAURI_SIGNING_PRIVATE_KEY, so this build makes no updater bundles (no update can be published from it).");
  return { config: next, notes };
}

export function main(args, env = process.env) {
  const at = args.indexOf("--config");
  const path = at >= 0 ? args[at + 1] : CONFIG;
  const dryRun = args.includes("--dry-run");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const { config: next, notes } = configureUpdater(config, {
    pubkey: env.TAURI_UPDATER_PUBKEY,
    hasPrivateKey: Boolean(env.TAURI_SIGNING_PRIVATE_KEY?.trim()),
  });
  for (const n of notes) {
    // GitHub Actions shows `::warning::` lines on the run's summary.
    console.log(n.startsWith("warning: ") && env.GITHUB_ACTIONS ? `::warning::${n.slice(9)}` : n);
  }
  if (!dryRun) writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`Updater setup: ${e.message}`);
    process.exit(1);
  }
}
