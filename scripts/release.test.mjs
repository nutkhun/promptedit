// The release scripts: version bumps, the build-time updater setup, latest.json and its signature
// checks. Signatures are made here with a throwaway Ed25519 key in minisign's format (the format
// `tauri signer` writes), so no real key is needed.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildManifest, downloadUrl, platformsFor } from "./latest-json.mjs";
import { parsePublicKey, publicKeyId, verifySignature } from "./minisign.mjs";
import { configureUpdater } from "./updater-config.mjs";
import { normalizeVersion, readVersions, setVersion } from "./version.mjs";

const b64 = (s) => Buffer.from(s).toString("base64");

/** A throwaway minisign key pair: Tauri's public-key string, and a signer for files. */
function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = randomBytes(8);
  const id = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
  const pubkey = b64(`untrusted comment: minisign public key: ${id}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`);
  const signFile = (data, { prehashed = true, comment = "timestamp:1700000000\tfile:PromptEdit.app.tar.gz" } = {}) => {
    const message = prehashed ? createHash("blake2b512").update(data).digest() : data;
    const sig = sign(null, message, privateKey);
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
    const line = Buffer.concat([Buffer.from(prehashed ? "ED" : "Ed"), keyId, sig]).toString("base64");
    return b64(`untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`);
  };
  return { pubkey, id, signFile };
}

describe("minisign", () => {
  const key = throwawayKey();
  const data = Buffer.from("the update bundle");

  it("reads Tauri's public key", () => {
    expect(parsePublicKey(key.pubkey).key).toHaveLength(32);
    expect(publicKeyId(key.pubkey)).toBe(key.id);
  });
  it("rejects what isn't a public key", () => {
    expect(() => parsePublicKey("not a key")).toThrow(/base64/);
    expect(() => parsePublicKey(b64("hello\nworld"))).toThrow(/minisign public key/);
    expect(() => parsePublicKey(b64(`untrusted comment: x\n${b64("short")}`))).toThrow(/wrong length/);
  });
  it("verifies signatures as the updater does, prehashed or not", () => {
    expect(() => verifySignature(key.pubkey, key.signFile(data), data)).not.toThrow();
    expect(() => verifySignature(key.pubkey, key.signFile(data, { prehashed: false }), data)).not.toThrow();
  });
  it("catches a changed file and a key that isn't the pair", () => {
    expect(() => verifySignature(key.pubkey, key.signFile(data), Buffer.from("tampered"))).toThrow(/doesn't match/);
    const other = throwawayKey();
    expect(() => verifySignature(other.pubkey, key.signFile(data))).toThrow(/aren't a pair/);
  });
});

describe("updater-config", () => {
  const base = {
    version: "0.1.0",
    bundle: { active: true, createUpdaterArtifacts: false },
    plugins: { updater: { pubkey: "", endpoints: ["https://github.com/nutkhun/promptedit/releases/latest/download/latest.json"] } },
  };
  const { pubkey } = throwawayKey();

  it("leaves a build without keys not checking", () => {
    const { config } = configureUpdater(base, { pubkey: "", hasPrivateKey: false });
    expect(config.plugins.updater.pubkey).toBe("");
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
  });
  it("puts the public key in and signs bundles when the private key is there", () => {
    const { config, notes } = configureUpdater(base, { pubkey: `  ${pubkey}\n`, hasPrivateKey: true });
    expect(config.plugins.updater.pubkey).toBe(pubkey);
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.plugins.updater.endpoints).toEqual(base.plugins.updater.endpoints);
    expect(notes.join("\n")).toMatch(/Signing updater bundles/);
    expect(base.plugins.updater.pubkey).toBe(""); // the input isn't changed
  });
  it("checks but makes no updater bundles without the private key", () => {
    const { config, notes } = configureUpdater(base, { pubkey, hasPrivateKey: false });
    expect(config.plugins.updater.pubkey).toBe(pubkey);
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(notes.join("\n")).toMatch(/warning: no TAURI_SIGNING_PRIVATE_KEY/);
  });
  it("makes no updater bundles from a private key alone (the CLI would fail)", () => {
    const { config } = configureUpdater(base, { pubkey: "", hasPrivateKey: true });
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
  });
  it("fails on a public key that isn't one", () => {
    expect(() => configureUpdater(base, { pubkey: "dW50cnVzdGVkIGNvbW1lbnQ6", hasPrivateKey: true })).toThrow(/public key/);
  });
});

describe("latest.json", () => {
  const repo = "nutkhun/promptedit", tag = "v0.2.0";
  const assets = [
    { name: "PromptEdit_0.2.0_aarch64.dmg" },
    { name: "PromptEdit_aarch64.app.tar.gz" },
    { name: "PromptEdit_aarch64.app.tar.gz.sig", signature: "MAC_SIG\n" },
    { name: "PromptEdit_0.2.0_x64-setup.exe" },
    { name: "PromptEdit_0.2.0_x64-setup.exe.sig", signature: "NSIS_SIG" },
    { name: "PromptEdit_0.2.0_x64_en-US.msi" },
    { name: "PromptEdit_0.2.0_x64_en-US.msi.sig", signature: "MSI_SIG" },
  ];

  it("names the platforms each bundle serves", () => {
    expect(platformsFor("PromptEdit_aarch64.app.tar.gz.sig")[0].keys).toEqual(["darwin-aarch64-app", "darwin-aarch64"]);
    expect(platformsFor("PromptEdit_universal.app.tar.gz.sig").map((p) => p.keys[1])).toEqual(["darwin-aarch64", "darwin-x86_64"]);
    expect(platformsFor("PromptEdit_0.2.0_x64-setup.exe.sig")[0].keys).toEqual(["windows-x86_64-nsis", "windows-x86_64"]);
    expect(platformsFor("PromptEdit_0.2.0_arm64_en-US.msi.sig")[0].keys).toEqual(["windows-aarch64-msi", "windows-aarch64"]);
    expect(platformsFor("PromptEdit_0.2.0_aarch64.dmg")).toEqual([]);
  });

  it("covers macOS and Windows, preferring NSIS for plain Windows", () => {
    const m = buildManifest({ repo, tag, notes: "• Faster export", pubDate: "2026-11-28T12:00:00.000Z", assets });
    expect(m.version).toBe("0.2.0");
    expect(m.notes).toBe("• Faster export");
    expect(m.pub_date).toBe("2026-11-28T12:00:00.000Z");
    expect(Object.keys(m.platforms)).toEqual([
      "darwin-aarch64", "darwin-aarch64-app", "windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis",
    ]);
    expect(m.platforms["darwin-aarch64"]).toEqual({
      signature: "MAC_SIG", url: "https://github.com/nutkhun/promptedit/releases/download/v0.2.0/PromptEdit_aarch64.app.tar.gz",
    });
    expect(m.platforms["windows-x86_64"].url).toBe(downloadUrl(repo, tag, "PromptEdit_0.2.0_x64-setup.exe"));
    expect(m.platforms["windows-x86_64-msi"].signature).toBe("MSI_SIG");
  });

  it("prefers the English MSI when there are several", () => {
    const m = buildManifest({ repo, tag, notes: "", pubDate: "x", assets: [
      { name: "A_0.2.0_x64_de-DE.msi" }, { name: "A_0.2.0_x64_de-DE.msi.sig", signature: "DE" },
      { name: "A_0.2.0_x64_en-US.msi" }, { name: "A_0.2.0_x64_en-US.msi.sig", signature: "EN" },
    ] });
    expect(m.platforms["windows-x86_64-msi"].signature).toBe("EN");
    expect(m.platforms["windows-x86_64"].signature).toBe("EN");
  });

  it("refuses a signature without its bundle", () => {
    expect(() => buildManifest({ repo, tag, notes: "", pubDate: "x", assets: [{ name: "PromptEdit_aarch64.app.tar.gz.sig", signature: "S" }] }))
      .toThrow(/no PromptEdit_aarch64.app.tar.gz/);
  });
});

describe("version", () => {
  const files = {
    "package.json": JSON.stringify({ name: "promptedit", version: "0.1.0" }, null, 2) + "\n",
    "src-tauri/tauri.conf.json": JSON.stringify({ productName: "PromptEdit", version: "0.1.0" }, null, 2) + "\n",
    "Cargo.toml": '[workspace]\nmembers = ["crates/core"]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n\n[workspace.dependencies]\nserde = { version = "1" }\n',
    "Cargo.lock": '[[package]]\nname = "promptedit"\nversion = "0.1.0"\n\n[[package]]\nname = "promptedit-core"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
  };

  it("takes a tag or a version", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(() => normalizeVersion("1.2")).toThrow();
    expect(() => normalizeVersion("main")).toThrow();
  });
  it("sets every file and nothing else", () => {
    const next = setVersion(files, "0.2.0");
    expect(Object.values(readVersions(next))).toEqual(["0.2.0", "0.2.0", "0.2.0", "0.2.0", "0.2.0"]);
    expect(next["Cargo.toml"]).toContain('serde = { version = "1" }');
    expect(next["Cargo.lock"]).toContain('name = "serde"\nversion = "1.0.0"');
  });
});
