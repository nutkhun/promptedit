# Captions and transcripts: contract between backend and UI

PromptEdit transcribes speech on the person's computer (whisper.cpp), like Editroom does with
Apple's on-device speech recognition. Behaviour to match: docs/spec/02-engine.md §9.3 (caption
layout and drawing) and §18 (transcripts), docs/spec/01-model.md §3.20 (caption edits),
docs/spec/04-ui.md §1.5 Caption/Style, §3.14 caption row, §1.3 search, and
docs/spec/03-mcp-magic.md `get_transcript` / `set_captions`.

## Transcript format (same as Editroom's cache)

```json
{ "words": [ { "start": 1.25, "end": 1.6, "text": "Hello," } ], "language": "en" }
```

Times are seconds in the **file** (source time). Punctuation stays attached to the word before it
(`"guys,"`), because caption layout breaks after `, . ? !`. Words are sorted by start.

## Speech models

Downloaded once on first use into the app's data folder (`<app_data>/Models/`), from
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`:

| Setting value | Label in Settings | File | Size |
| --- | --- | --- | --- |
| `fast` | Fast | `ggml-base.bin` | ~148 MB |
| `balanced` (default) | Balanced | `ggml-small.bin` | ~488 MB |
| `best` | Best (slow on older PCs) | `ggml-large-v3-turbo-q5_0.bin` | ~574 MB |

All multilingual. Language: `auto` (detect) by default, or an ISO code the person picks.

## Backend commands (Tauri commands and dev-server `dispatch()`)

| Command | Args | Returns |
| --- | --- | --- |
| `transcript_get` | `{ asset }` | `Transcript \| null` (cached only, never starts work) |
| `transcribe` | `{ asset }` | `TranscriptState` (queues it; one file at a time; no-op if ready/working) |
| `transcript_state` | `{ asset }` | `TranscriptState` |
| `transcription_settings_get` | `{}` | `{ model, language, models: [{ id, label, sizeMB, downloaded }] }` |
| `transcription_settings_set` | `{ model?, language? }` | same as get |
| `transcription_model_download` | `{ model? }` | `ModelState` (starts the download; progress via state/events) |
| `transcription_model_state` | `{}` | `ModelState` |

```ts
type TranscriptState =
  | { state: "none" } | { state: "queued" } | { state: "needsModel" }
  | { state: "working"; progress: number }      // 0…1
  | { state: "ready"; words: number }
  | { state: "failed"; message: string };
type ModelState =
  | { state: "missing" } | { state: "downloading"; progress: number } | { state: "ready" }
  | { state: "failed"; message: string };
```

Events (Tauri only; the browser dev build polls the state commands every second instead):
`transcript-state` `{ asset, ...TranscriptState }`, `transcription-model` `ModelState`.

Transcripts are cached per file in `<app_cache>/Transcripts/<name>.json` (name = the same FNV-1a
stamp of path + size + mtime used for converted copies), so a file is transcribed once.

The backend also registers itself as the MCP server's `TranscriptProvider`
(`mcp::providers::set_transcripts`), so `get_transcript`, `set_captions`, transcript search and
Magic's speech features work for AI agents.

## When transcription starts

- When a clip is captioned (`addCaptions`) and its file has no transcript: the UI calls `transcribe`.
- After import, video/audio files are transcribed in the background **only if the speech model is
  already downloaded** (so search by what's said works). Never download a model without the person
  asking: the first Add Captions shows a prompt with the model size and a Download button.

## UI pieces

- Caption layout (TS port of `CaptionLayout`): words → timeline blocks per captioned clip, with
  `captionFixes` applied. Feeds the timeline (`setCaptionProvider` in src/timeline/captions.ts), the
  inspector (`setCaptionTextEditor` in src/ui/inspector/captionText.ts, saving with the
  `setCaptionFixes` edit) and the compositor.
- The compositor draws captions on the picture (preview and export) per §9.3, with word highlight
  and outline.
- Menus: Clip › Add Captions / Remove Captions (and the timeline context menu).
- Library search: words in quotes match transcripts (`"birthday cake"`), with snippets.
