#!/usr/bin/env node
// Writes the updater's manifest, latest.json, for a GitHub release (CI's "Publish release" job, after
// both platforms' builds have uploaded their assets). The apps read it from
// https://github.com/<repo>/releases/latest/download/latest.json, so it describes every platform at
// once; it's made here, in one go, rather than by each build job, which would race to edit it.
//
// Each platform's entry points at its signed updater bundle (macOS: the .app.tar.gz; Windows: the
// NSIS installer, or the MSI for MSI installs) and carries the bundle's `.sig`. Every signature is
// checked against TAURI_UPDATER_PUBKEY, the key the apps trust, before anything is published: an
// update the apps would refuse is caught here, not on people's computers.
//
//   GH_TOKEN=… TAURI_UPDATER_PUBKEY=… node scripts/latest-json.mjs --repo owner/name --tag v0.2.0 \
//     [--out latest.json] [--require darwin-aarch64,windows-x86_64] [--no-download-check]

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifySignature } from "./minisign.mjs";

const ARCH = { x64: "x86_64", amd64: "x86_64", x86_64: "x86_64", x86: "i686", i386: "i686", i686: "i686", arm64: "aarch64", aarch64: "aarch64" };

/**
 * Which updater platforms a signature asset serves, from its name (as tauri-action uploads them:
 * `PromptEdit_aarch64.app.tar.gz.sig`, `PromptEdit_0.2.0_x64-setup.exe.sig`,
 * `PromptEdit_0.2.0_x64_en-US.msi.sig`). The updater looks for `<os>-<arch>-<installer>` first,
 * then `<os>-<arch>`; `primary` says whether this bundle may be the plain `<os>-<arch>` one.
 */
export function platformsFor(sigName) {
  const name = sigName.replace(/\.sig$/, "");
  const arch = (re) => {
    const m = re.exec(name);
    return m ? (m[1] === "universal" ? ["aarch64", "x86_64"] : [ARCH[m[1].toLowerCase()]].filter(Boolean)) : [];
  };
  if (name.endsWith(".app.tar.gz")) {
    return arch(/_(aarch64|x64|x86_64|universal)\.app\.tar\.gz$/).map((a) => ({ keys: [`darwin-${a}-app`, `darwin-${a}`], rank: 1 }));
  }
  if (name.endsWith(".exe")) {
    // NSIS is preferred for the plain key: it installs per user, so updates need no admin rights.
    return arch(/_(x64|x86|arm64)-setup\.exe$/i).map((a) => ({ keys: [`windows-${a}-nsis`, `windows-${a}`], rank: 2 }));
  }
  if (name.endsWith(".msi")) {
    // English first if there are several languages, as tauri-action does.
    return arch(/_(x64|x86|arm64)_[^_]+\.msi$/i).map((a) => ({ keys: [`windows-${a}-msi`, `windows-${a}`], rank: /_en-US\.msi$/i.test(name) ? 1 : 0 }));
  }
  if (name.endsWith(".AppImage")) {
    return arch(/_(amd64|x86_64|aarch64|arm64|i386)\.AppImage$/i).map((a) => ({ keys: [`linux-${a}-appimage`, `linux-${a}`], rank: 1 }));
  }
  return [];
}

export const downloadUrl = (repo, tag, name) =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

/**
 * The manifest for these assets. `assets` are the release's files: `{ name, signature? }`, with the
 * signature text for `.sig` files. Each key goes to its best bundle (by rank, then name).
 */
export function buildManifest({ repo, tag, notes, pubDate, assets }) {
  const names = new Set(assets.map((a) => a.name));
  const chosen = new Map(); // platform key → { rank, name, signature }
  for (const sig of assets.filter((a) => a.name.endsWith(".sig"))) {
    const bundle = sig.name.replace(/\.sig$/, "");
    if (!names.has(bundle)) throw new Error(`${sig.name} has no ${bundle} next to it in the release.`);
    for (const { keys, rank } of platformsFor(sig.name)) {
      keys.forEach((key, i) => {
        // The installer-specific key always gets its own bundle; the plain key the best-ranked one.
        const score = i === 0 ? 100 + rank : rank;
        const had = chosen.get(key);
        if (!had || score > had.score || (score === had.score && bundle < had.name)) {
          chosen.set(key, { score, name: bundle, signature: sig.signature.trim() });
        }
      });
    }
  }
  const platforms = Object.fromEntries([...chosen.keys()].sort().map((key) => {
    const { name, signature } = chosen.get(key);
    return [key, { signature, url: downloadUrl(repo, tag, name) }];
  }));
  return { version: tag.replace(/^v/, ""), notes: notes ?? "", pub_date: pubDate, platforms };
}

// ---- GitHub ----

function github(token) {
  const api = async (path, accept = "application/vnd.github+json") => {
    const r = await fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
      headers: { accept, authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "promptedit-release" },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`GitHub: ${r.status} ${r.statusText} for ${path}`);
    return r;
  };
  return {
    /** The release for a tag, drafts included (the tag endpoint doesn't see drafts). */
    async release(repo, tag) {
      for (let page = 1; page <= 10; page++) {
        const list = await (await api(`/repos/${repo}/releases?per_page=100&page=${page}`)).json();
        const found = list.find((r) => r.tag_name === tag);
        if (found) return found;
        if (list.length < 100) break;
      }
      throw new Error(`No release for ${tag} in ${repo}.`);
    },
    async asset(asset) {
      return Buffer.from(await (await api(asset.url, "application/octet-stream")).arrayBuffer());
    },
  };
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function main(args, env = process.env) {
  const repo = option(args, "--repo"), tag = option(args, "--tag");
  const out = option(args, "--out") ?? "latest.json";
  const required = (option(args, "--require") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const checkDownloads = !args.includes("--no-download-check");
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const pubkey = env.TAURI_UPDATER_PUBKEY?.trim();
  if (!repo || !tag) throw new Error("Usage: latest-json.mjs --repo owner/name --tag v1.2.3");
  if (!token) throw new Error("GH_TOKEN isn't set.");
  if (!pubkey) throw new Error("TAURI_UPDATER_PUBKEY isn't set, so the updates can't be checked.");

  const gh = github(token);
  const release = await gh.release(repo, tag);
  const assets = [];
  for (const a of release.assets) {
    if (a.name === "latest.json") continue;
    assets.push({ name: a.name, signature: a.name.endsWith(".sig") ? (await gh.asset(a)).toString("utf8") : undefined, asset: a });
  }
  const manifest = buildManifest({ repo, tag, notes: release.body ?? "", pubDate: new Date().toISOString(), assets });
  const keys = Object.keys(manifest.platforms);
  if (!keys.length) throw new Error(`The ${tag} release has no signed updater bundles (is TAURI_SIGNING_PRIVATE_KEY set?).`);
  const missing = required.filter((k) => !manifest.platforms[k]);
  if (missing.length) throw new Error(`No update for ${missing.join(", ")} in the ${tag} release.`);

  // Every bundle once, checked as the updater will check it.
  const checked = new Set();
  for (const key of keys) {
    const { url, signature } = manifest.platforms[key];
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    if (checked.has(name)) continue;
    checked.add(name);
    const data = checkDownloads ? await gh.asset(assets.find((a) => a.name === name).asset) : undefined;
    try {
      verifySignature(pubkey, signature, data);
    } catch (e) {
      throw new Error(`${name}: ${e.message}`);
    }
    console.log(`${name}: signature ${checkDownloads ? "verified" : "key matches"}.`);
  }
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${out} for ${manifest.version}: ${keys.join(", ")}.`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
