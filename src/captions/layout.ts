// Caption layout: each captioned clip's words, where they're said on the timeline, in short phrases
// that read at a glance. An exact port of Editroom's `CaptionLayout` and the caption parts of
// `Project` (Model/Captions.swift; docs/spec/02-engine.md §9.3, docs/spec/01-model.md §3.20).
// Pure: the transcripts come in through a lookup, so the timeline, the inspector, the compositor
// and the tests all lay out the same blocks.

import type { CaptionFix, Clip, Id, MediaAsset, Project } from "../model";
import { asset as assetOf, clipEnd, linked, playsSource, sourceLength, timelineSpan } from "../timing";
import type { CaptionBlock as TimelineCaptionBlock } from "../timeline/captions";

// What's said in a file: each word with its time in the file (docs/spec/05-captions-contract.md).
import type { Transcript, TranscriptWord } from "../transcripts";
export type { Transcript, TranscriptWord };

/** One word of a caption. */
export interface CaptionWord {
  /** Timeline times. */
  start: number;
  end: number;
  text: string;
  /** The word's start in its file, for fixes. */
  source: number;
  /** The words in the file it stands for (more than one when a retyped caption has new words). */
  covers: number[];
}

/** One caption: a few words shown together. The timeline's block plus what the editor and renderer need. */
export interface CaptionBlock extends TimelineCaptionBlock {
  assetID: Id;
  words: CaptionWord[];
}

/** Longest phrase, in characters, and longest time on screen. */
export const MAX_CHARS = 26;
export const MAX_SECONDS = 2.6;
/** A pause this long starts a new caption. */
export const PAUSE = 0.5;
/** Fixes match a word whose start in the file is this close. */
const SAME_WORD = 0.0005;

// Swift counts Characters (grapheme clusters): "กิ" is one, as are emoji with modifiers.
// (Intl.Segmenter is in every webview PromptEdit runs in; typed here as the project's lib predates it.)
type Segmenter = { segment(s: string): Iterable<unknown> };
const SegmenterCtor = (Intl as unknown as { Segmenter?: new (locale: undefined, o: { granularity: "grapheme" }) => Segmenter }).Segmenter;
const segmenter = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: "grapheme" }) : undefined;
export function characterCount(s: string): number {
  if (!segmenter) return [...s].length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

/** `split(whereSeparator: \.isWhitespace)`: the words of a text, empty pieces dropped. */
export const splitWords = (s: string): string[] => s.split(/\s+/u).filter((w) => w.length > 0);
/** `trimmingCharacters(in: .whitespaces)` is empty: only spaces and tabs (newlines count as text). */
const blank = (s: string) => /^[\p{Zs}\t]*$/u.test(s);

/** The caption's id: the clip it comes from and its first word's time in the file (ms), steady through trims and moves. */
export const blockId = (clipID: Id, words: CaptionWord[]) => `${clipID}@${Math.trunc((words[0]?.source ?? 0) * 1000)}`;

export const blockText = (words: CaptionWord[]) => words.map((w) => w.text).join(" ");

/** The words in the file the caption stands for, in order. */
export function covered(block: Pick<CaptionBlock, "words">): number[] {
  const out: number[] = [];
  for (const w of block.words) for (const c of w.covers) if (out[out.length - 1] !== c && !out.includes(c)) out.push(c);
  return out;
}

// ---- The project's caption state ----

/** `captionFixes` is stored as Swift encodes a UUID-keyed dictionary: [asset, fixes, asset, fixes, …]. */
export function fixesOf(p: Pick<Project, "captionFixes">, asset: Id): CaptionFix[] {
  const flat = p.captionFixes ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i] === asset) return flat[i + 1] as CaptionFix[];
  return [];
}

/** Clips whose speech is captioned: sound clips (a video's sound is its linked audio clip). */
export function captionedClips(p: Project): Clip[] {
  if (!p.captions) return [];
  return p.clips.filter((c) => c.captioned === true && c.kind === "audio" && playsSource(c) && c.reversed !== true);
}

const isSound = (c: Clip) => c.kind === "audio" && playsSource(c);

/** The sound clips that captioning these clips means: each one's own sound, or its linked sound. */
export function captionTargets(p: Project, ids: Iterable<Id>): Set<Id> {
  const group = linked(p, ids);
  return new Set(p.clips.filter((c) => group.has(c.id) && isSound(c)).map((c) => c.id));
}

/**
 * With nothing picked: the sound of clips from video files (people on camera), and of any track
 * something ducks under (a voiceover). Music on its own track is left alone.
 */
export function defaultCaptionTargets(p: Project): Set<Id> {
  const voices = new Set(p.audioTracks.map((t) => t.duckUnder).filter((x): x is Id => !!x));
  return new Set(p.clips.filter((c) => {
    if (!isSound(c)) return false;
    const a = assetOf(p, c.assetID);
    return !!a && (a.kind === "video" || voices.has(c.trackID));
  }).map((c) => c.id));
}

/** Whether any of these clips (or what's linked to them) have captions. */
export function hasCaptions(p: Project, ids: Iterable<Id>): boolean {
  const t = captionTargets(p, ids);
  return p.clips.some((c) => t.has(c.id) && c.captioned === true);
}

/** The files whose transcripts the captions need. */
export function captionedAssets(p: Project): Id[] {
  return [...new Set(captionedClips(p).map((c) => c.assetID).filter((x): x is Id => !!x))];
}

/**
 * What a caption says from now on, as the fixes to store for its file (§3.20 `setCaptionText`): as many
 * words as were said replace them one for one; otherwise the first word takes the whole text and the
 * rest join it, so the caption keeps its time and the new words share it out. Empty text leaves them
 * all out. Returns only the fixes this sets; each replaces any fix for the same word.
 */
export function captionTextFixes(block: Pick<CaptionBlock, "words">, text: string): CaptionFix[] {
  const typed = splitWords(text);
  const said = covered(block);
  if (typed.length === 0) return said.map((start) => ({ start, text: "" }));
  // Every word set, so words an earlier edit left out or joined come back.
  if (typed.length === said.length) return said.map((start, i) => ({ start, text: typed[i] }));
  return said.map((start, i) => (i === 0 ? { start, text: typed.join(" ") } : { start, text: "", merged: true }));
}

/** Applies fixes to a file's list as the `setCaptionFixes` edit does: replaced by word, sorted by start. */
export function mergeFixes(existing: CaptionFix[], fixes: CaptionFix[]): CaptionFix[] {
  let out = existing.slice();
  for (const f of fixes) {
    out = out.filter((x) => Math.abs(x.start - f.start) >= SAME_WORD);
    out.push(f);
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- Layout ----

/** Every caption in the project, sorted by start; overlapping speech gives way to the next caption. */
export function captionBlocks(p: Project, transcript: (asset: MediaAsset) => Transcript | undefined): CaptionBlock[] {
  let out: CaptionBlock[] = [];
  for (const clip of captionedClips(p)) {
    const a = assetOf(p, clip.assetID);
    if (!a) continue;
    const script = transcript(a);
    if (!script || script.words.length === 0) continue;
    out = out.concat(clipBlocks(clip, a.id, script.words, fixesOf(p, a.id)));
  }
  out.sort((x, y) => x.start - y.start);
  // Overlapping speech (two people at once): each caption gives way to the next.
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.05, out[i + 1].start);
  }
  return out;
}

/**
 * A run of talking cut into even phrases: as many as keep each within MAX_CHARS and MAX_SECONDS, each
 * cut at the word nearest an even share (a little nearer after a comma).
 */
export function phrases(run: CaptionWord[]): CaptionWord[][] {
  if (run.length === 0) return [];
  const first = run[0], last = run[run.length - 1];
  // Characters up to the end of each word.
  const ends: number[] = [];
  let total = 0;
  run.forEach((w, i) => {
    total += characterCount(w.text) + (i > 0 ? 1 : 0);
    ends.push(total);
  });
  const byChars = Math.ceil(total / MAX_CHARS);
  const byTime = Math.ceil((last.end - first.start) / MAX_SECONDS);
  const n = Math.min(run.length, Math.max(1, byChars, byTime));
  if (n <= 1) return [run];
  const cuts: number[] = [];
  let from = 0;
  for (let k = 1; k < n; k++) {
    const target = (total * k) / n;
    // Cut after word i (leaving a word for each phrase to come). Never inside a retyped word's new
    // words: they're one edit.
    let best: number | undefined;
    let bestScore = Infinity;
    for (let i = from; i <= run.length - (n - k) - 1; i++) {
      if (run[i].source === run[i + 1].source) continue;
      let score = Math.abs(ends[i] - target);
      if (run[i].text.endsWith(",")) score -= 6;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best === undefined) break;
    cuts.push(best);
    from = best + 1;
    if (from > run.length - 1) break;
  }
  const out: CaptionWord[][] = [];
  let start = 0;
  for (const c of [...cuts, run.length - 1]) {
    out.push(run.slice(start, c + 1));
    start = c + 1;
  }
  return out;
}

const endsSentence = (t: string) => t.endsWith(".") || t.endsWith("?") || t.endsWith("!");

/** One clip's captions. */
export function clipBlocks(clip: Clip, assetID: Id, words: TranscriptWord[], fixes: CaptionFix[]): CaptionBlock[] {
  const s0 = clip.sourceStart, s1 = s0 + sourceLength(clip);
  const cEnd = clipEnd(clip);
  const at = (s: number) => Math.min(cEnd, Math.max(clip.start, clip.start + timelineSpan(clip, s0, s)));
  // The words heard in the clip (most of the word inside it), on the timeline, with any fixes. A word
  // joined to the one before lends it its time.
  const entries: CaptionWord[] = [];
  let previous: number | undefined;
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    if (!(mid >= s0 && mid < s1)) continue;
    const prev = previous;
    previous = w.start;
    const fix = fixes.find((f) => Math.abs(f.start - w.start) < SAME_WORD);
    const a = at(Math.max(w.start, s0)), b = at(Math.min(w.end, s1));
    if (fix?.merged === true) {
      const lastEntry = entries[entries.length - 1];
      if (prev !== undefined && lastEntry && lastEntry.covers[lastEntry.covers.length - 1] === prev) {
        lastEntry.end = Math.max(lastEntry.end, b);
        lastEntry.covers.push(w.start);
      }
      continue;
    }
    const text = fix?.text ?? w.text;
    if (blank(text) || !(b > a)) continue;
    entries.push({ start: a, end: b, text, source: w.start, covers: [w.start] });
  }
  // A retyped word with several words in it: they share its time, by length.
  const heard: CaptionWord[] = [];
  for (const e of entries) {
    const parts = splitWords(e.text);
    if (parts.length <= 1) { heard.push(e); continue; }
    const weights = parts.map((x) => characterCount(x) + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let t = e.start;
    parts.forEach((part, i) => {
      const d = ((e.end - e.start) * weights[i]) / total;
      heard.push({ start: t, end: t + d, text: part, source: e.source, covers: e.covers.slice() });
      t += d;
    });
  }

  // Runs of talking: broken by a pause or the end of a sentence. Each run is then cut into as few even
  // phrases as keep each one short, so no word is left on its own.
  const runs: CaptionWord[][] = [];
  for (const w of heard) {
    const run = runs[runs.length - 1];
    const lastWord = run?.[run.length - 1];
    if (lastWord && w.start - lastWord.end < PAUSE && !endsSentence(lastWord.text)) run.push(w);
    else runs.push([w]);
  }
  const groups = runs.flatMap(phrases);

  const out: CaptionBlock[] = [];
  groups.forEach((g, i) => {
    if (g.length === 0) return;
    const first = g[0], lastWord = g[g.length - 1];
    // Held a moment after the last word, never into the next caption or past the clip.
    const next = i + 1 < groups.length ? groups[i + 1][0].start : cEnd;
    const end = Math.min(next, cEnd, Math.max(lastWord.end + 0.25, first.start + 0.6));
    out.push({
      id: blockId(clip.id, g), clipID: clip.id, assetID, start: first.start, end: Math.max(end, lastWord.end),
      text: blockText(g), words: g,
    });
  });
  return out;
}
