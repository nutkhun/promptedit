// The Media panel's search (docs/spec/04-ui.md §1.3; Editroom LibraryView `shown`, `snippet`): words in
// quotes match what's said in a file (its transcript, last word as it's typed); other words match its
// name or what it shows (its scene tags: "beach", "dog", "night"), each word, the last one as it's typed.
// Transcripts are read from the backend's cache when a quoted search starts, scene tags when a plain one does.

import { useEffect } from "react";
import type { MediaAsset } from "../../model";
import { quotedPhrases, says, snippet, withoutQuotes, type Snippet } from "../../captions/said";
import { fetchTranscript, transcriptOf, useTranscripts } from "../../captions/store";
import { matchingTags, refreshTags, shows, tagsOf, useScenes } from "../../scenes";

export interface Search { words: string[]; phrases: string[] }

export function parseSearch(q: string): Search {
  const rest = withoutQuotes(q).toLowerCase();
  return { words: rest ? rest.split(/\s+/) : [], phrases: quotedPhrases(q) };
}

const hasSound = (a: MediaAsset) => a.kind === "audio" || (a.kind === "video" && a.hasAudio);

/** Plain words: all of them in the name (Editroom tries the words as one phrase first), or else each in
 *  the name or what it shows, the last one possibly only begun. */
function wordsMatch(a: MediaAsset, words: string[]): boolean {
  if (words.length === 0) return true;
  const name = a.name.toLowerCase();
  if (name.includes(words.join(" "))) return true;
  const tags = tagsOf(a.id);
  return words.every((w, i) => name.includes(w) || (!!tags && shows(tags, w, i === words.length - 1)));
}

export function matches(a: MediaAsset, { words, phrases }: Search): boolean {
  if (!wordsMatch(a, words)) return false;
  if (phrases.length === 0) return true;
  const t = transcriptOf(a.id);
  return !!t && phrases.every((p) => says(t, p, true));
}

/** Where a file says the first quoted phrase, to show under it. */
export function saidSnippet(a: MediaAsset, { phrases }: Search): Snippet | undefined {
  const t = phrases.length ? transcriptOf(a.id) : undefined;
  return t ? snippet(t, phrases[0], true) : undefined;
}

/** What it shows that the search found, for words not in its name ("beach", "swimming pool"). */
export function showsMatch(a: MediaAsset, { words }: Search): string[] | undefined {
  const tags = tagsOf(a.id);
  if (!tags || words.length === 0) return undefined;
  const name = a.name.toLowerCase();
  if (name.includes(words.join(" "))) return undefined;
  const found: string[] = [];
  words.forEach((w, i) => {
    if (name.includes(w)) return;
    for (const t of matchingTags(tags, w, i === words.length - 1)) if (!found.includes(t.name)) found.push(t.name);
  });
  return found.length ? found.slice(0, 3) : undefined;
}

/** Plain words no video's or photo's name has: a search for what's in the picture (Media search then
 *  offers to look, once, if the picture model isn't here). */
export function looksForPictures(assets: MediaAsset[], { words }: Search): boolean {
  const named = (a: MediaAsset) => { const n = a.name.toLowerCase(); return words.every((w) => n.includes(w)); };
  const pictures = assets.filter((a) => a.kind !== "audio");
  return words.some((w) => w.length >= 2) && pictures.length > 0 && !pictures.some(named);
}

/** While searching what's said: every file's transcript read, and the results redone as they arrive. */
export function useSaidSearch(assets: MediaAsset[], search: Search): number {
  const version = useTranscripts((s) => s.version);
  const quoting = search.phrases.length > 0;
  useEffect(() => {
    if (!quoting) return;
    for (const a of assets) if (hasSound(a)) void fetchTranscript(a.id);
  }, [quoting, assets]);
  return version;
}

/** While searching by plain words: every file's scene tags read, and the results redone as they arrive. */
export function useShowsSearch(assets: MediaAsset[], search: Search): number {
  const version = useScenes((s) => s.version);
  const plain = search.words.length > 0;
  useEffect(() => {
    if (plain) void refreshTags();
  }, [plain, assets]);
  return version;
}
