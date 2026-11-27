// Searching what's said in a file (Editroom `Transcript.says`, `snippet`, `tokens`;
// docs/spec/02-engine.md §18, docs/spec/04-ui.md §1.3).

import type { Transcript } from "./layout";

/** Lower-cased words: split on anything but letters, digits and apostrophes (marks stay with their letter). */
export function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{M}\p{N}']+/u).filter((t) => t.length > 0);
}

export const transcriptText = (t: Transcript) => t.words.map((w) => w.text).join(" ");

/** Does `run` match `want`: every word whole, the last one (when typing) possibly only begun. */
function runMatches(run: string[], want: string[], typing: boolean): boolean {
  for (let j = 0; j < want.length - 1; j++) if (run[j] !== want[j]) return false;
  const last = run[run.length - 1], w = want[want.length - 1];
  return typing ? last.startsWith(w) : last === w;
}

/**
 * Whether they say these words, in this order (case and punctuation aside). With `typing`, the last
 * word can be the start of one ("gu" finds "guys"), for searching as it's typed.
 */
export function says(t: Transcript, phrase: string, typing = false): boolean {
  const want = tokens(phrase);
  if (want.length === 0) return false;
  const have = tokens(transcriptText(t));
  for (let i = 0; i + want.length <= have.length; i++) {
    if (runMatches(have.slice(i, i + want.length), want, typing)) return true;
  }
  return false;
}

export interface Snippet { before: string; match: string; after: string }

/** A few words either side of where they say this, for showing why a clip matched. */
export function snippet(t: Transcript, phrase: string, typing = false): Snippet | undefined {
  const want = tokens(phrase);
  const words = t.words;
  if (want.length === 0 || words.length < want.length) return undefined;
  const have = words.map((w) => tokens(w.text)[0] ?? "");
  for (let i = 0; i + want.length <= words.length; i++) {
    if (!runMatches(have.slice(i, i + want.length), want, typing)) continue;
    const from = Math.max(0, i - 3), to = Math.min(words.length, i + want.length + 4);
    const text = (a: number, b: number) => words.slice(a, b).map((w) => w.text).join(" ");
    return {
      before: (from > 0 ? "…" : "") + text(from, i),
      match: text(i, i + want.length),
      after: text(i + want.length, to) + (to < words.length ? "…" : ""),
    };
  }
  return undefined;
}

/** Words in quotes are what's said: `"birthday cake"`, also with curly quotes, the last one optional. */
const QUOTED = /["“”]([^"“”]*)["“”]?/g;
export function quotedPhrases(q: string): string[] {
  return [...q.trim().matchAll(QUOTED)].map((m) => m[1].trim()).filter(Boolean);
}
export const withoutQuotes = (q: string) => q.trim().replace(QUOTED, "").trim();
