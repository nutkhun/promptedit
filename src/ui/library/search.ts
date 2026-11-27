// The Media panel's search (docs/spec/04-ui.md §1.3; Editroom LibraryView `shown`, `snippet`): words in
// quotes match what's said in a file (its transcript, last word as it's typed), other words its name.
// Transcripts are read from the backend's cache when a quoted search starts.

import { useEffect } from "react";
import type { MediaAsset } from "../../model";
import { quotedPhrases, says, snippet, withoutQuotes, type Snippet } from "../../captions/said";
import { fetchTranscript, transcriptOf, useTranscripts } from "../../captions/store";

export interface Search { words: string[]; phrases: string[] }

export function parseSearch(q: string): Search {
  const rest = withoutQuotes(q).toLowerCase();
  return { words: rest ? rest.split(/\s+/) : [], phrases: quotedPhrases(q) };
}

const hasSound = (a: MediaAsset) => a.kind === "audio" || (a.kind === "video" && a.hasAudio);

export function matches(a: MediaAsset, { words, phrases }: Search): boolean {
  const name = a.name.toLowerCase();
  if (!words.every((w) => name.includes(w))) return false;
  if (phrases.length === 0) return true;
  const t = transcriptOf(a.id);
  return !!t && phrases.every((p) => says(t, p, true));
}

/** Where a file says the first quoted phrase, to show under it. */
export function saidSnippet(a: MediaAsset, { phrases }: Search): Snippet | undefined {
  const t = phrases.length ? transcriptOf(a.id) : undefined;
  return t ? snippet(t, phrases[0], true) : undefined;
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
