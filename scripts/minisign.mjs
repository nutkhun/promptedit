// Reading and checking the update signing key and signatures, in the format `tauri signer` writes
// and tauri-plugin-updater checks (minisign, Ed25519). Used by updater-config.mjs (is the public key
// one?) and latest-json.mjs (was each update signed by the key the apps trust?).
//
// The public key Tauri takes is the base64 of a minisign public key file:
//   untrusted comment: minisign public key: <key id>
//   <base64: "Ed" + key id (8 bytes) + Ed25519 public key (32 bytes)>
// A `.sig` file is the base64 of a minisign signature file:
//   untrusted comment: …
//   <base64: "ED" (BLAKE2b-512 prehashed) or "Ed" + key id (8) + signature of the file (64)>
//   trusted comment: …
//   <base64: signature of (file signature + trusted comment) (64)>

import { createHash, createPublicKey, verify } from "node:crypto";

const fromBase64 = (text) => {
  const clean = String(text ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new Error("isn't base64");
  return Buffer.from(clean, "base64");
};

/** Lines of a base64-wrapped minisign file. */
function lines(base64) {
  return fromBase64(base64).toString("utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/** Parses the public key Tauri's config takes. Throws with a reason if it isn't one. */
export function parsePublicKey(pubkey) {
  let text;
  try { text = lines(pubkey); } catch (e) { throw new Error(`The public key ${e.message}.`); }
  if (text.length < 2 || !text[0].startsWith("untrusted comment:")) {
    throw new Error("The public key isn't a minisign public key (paste the whole output of the .key.pub file, one line of base64).");
  }
  const raw = fromBase64(text[1]);
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("The public key's key line is the wrong length or kind.");
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

/** Parses a `.sig` file's contents (what latest.json carries as `signature`). */
export function parseSignature(signature) {
  let text;
  try { text = lines(signature); } catch (e) { throw new Error(`The signature ${e.message}.`); }
  if (text.length < 4 || !text[2].startsWith("trusted comment:")) throw new Error("The signature isn't a minisign signature.");
  const raw = fromBase64(text[1]);
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (raw.length !== 74 || (algorithm !== "Ed" && algorithm !== "ED")) throw new Error("The signature line is the wrong length or kind.");
  const global = fromBase64(text[3]);
  if (global.length !== 64) throw new Error("The signature's trusted-comment signature is the wrong length.");
  return {
    prehashed: algorithm === "ED",
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10, 74),
    trustedComment: text[2].slice("trusted comment: ".length),
    globalSignature: global,
  };
}

const keyIdHex = (id) => Buffer.from(id).reverse().toString("hex").toUpperCase();

/** The key's id as minisign prints it ("untrusted comment: minisign public key: …"). */
export const publicKeyId = (pubkey) => keyIdHex(parsePublicKey(pubkey).keyId);

function ed25519(key) {
  // An Ed25519 SubjectPublicKeyInfo is a fixed 12-byte header, then the 32-byte key.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/**
 * Checks `data` against a signature by `pubkey`, as the updater does before installing.
 * Throws with the reason when it doesn't verify; `data` may be omitted to check only the key id.
 */
export function verifySignature(pubkey, signature, data) {
  const pk = parsePublicKey(pubkey);
  const sig = parseSignature(signature);
  if (!pk.keyId.equals(sig.keyId)) {
    throw new Error(`Signed with key ${keyIdHex(sig.keyId)}, but the apps trust key ${keyIdHex(pk.keyId)}: TAURI_SIGNING_PRIVATE_KEY and TAURI_UPDATER_PUBKEY aren't a pair.`);
  }
  if (data === undefined) return;
  const key = ed25519(pk.key);
  const message = sig.prehashed ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, sig.signature)) throw new Error("The signature doesn't match the file.");
  const trusted = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!verify(null, trusted, key, sig.globalSignature)) throw new Error("The signature's trusted comment doesn't verify.");
}
