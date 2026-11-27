# Parity with Editroom

Every Editroom feature and where PromptEdit stands. ✅ done and tested · 🟡 works with a known
difference · ⬜ not built yet. "Tested" means automated tests and/or driving the UI in Chromium
(WebView2's engine); items marked † have only been checked in a browser, not yet inside the Tauri
window on macOS/Windows.

## Projects and files

| Feature | Status | Notes |
| --- | --- | --- |
| Open/save Editroom `.room` (and `.cutplay`) projects | ✅ | Same JSON; round-trip tested against an Editroom-style file |
| Relative paths: moved project folders find their media | ✅ | |
| Undo/redo with Editroom's rules (library and Magic history not undone) | ✅ | 200 steps |
| Auto-save, ask before closing with unsaved changes | ✅ † | |
| Untitled recovery copy | ⬜ | |
| Open Recent, reopen last session | ✅ † | |
| Linked folders (Media mirrors a folder on disk) | ⬜ | Model support exists; UI and syncing not built |
| macOS security-scoped bookmarks | 🟡 | Kept in the file for Editroom; PromptEdit uses paths |

## Media

| Feature | Status | Notes |
| --- | --- | --- |
| Import MP4/MOV/M4A/WAV/MP3/images | ✅ | |
| MKV, WebM, MXF, AVI… (rewrapped or converted by FFmpeg) | ✅ | Same strategy as Editroom |
| Codecs the webview can't decode (ProRes, DNxHD, some HEVC) | 🟡 | Converted to an edit-friendly H.264 copy in the background; Editroom plays ProRes directly |
| Rotation metadata | ✅ | |
| HDR / Apple Log to Rec.709 | ⬜ | Drawn as the browser converts them |
| Library: thumbnails/list, search by name, hover-scrub, context menus | ✅ † | |
| Search by what's said (transcripts) and what's in the picture (scene tags) | ⬜ | Needs on-device speech (whisper.cpp) and image tagging (ONNX) |
| Offline media, Locate…, Reload from Disk | 🟡 | Relink exists; offline detection only checks the library, not the disk |

## Editing

| Feature | Status | Notes |
| --- | --- | --- |
| Multi-track timeline, zoom/scroll, row heights | ✅ | Layout and view maths match Editroom's self-tests |
| Move, trim, sticky edges, snapping, ⌥/Alt-drag duplicate | ✅ | |
| Split, cut tool, delete, ripple delete, ripple trim (Q/W) | ✅ | |
| Close gaps, delete gap | ✅ | |
| Detach audio, linked clips | ✅ | |
| Copy/cut/paste/duplicate clips | ✅ | |
| Freeze frame, reverse | ✅ | |
| Text and solids | ✅ | |
| Markers, in/out range | ✅ | |
| Track mute/solo/lock/hide, gain, ducking | ✅ | |
| Editable keyboard shortcuts (⌘ on Mac, Ctrl on Windows) | ✅ | |
| Drag from Media to timeline; drop files from Finder/Explorer | ✅ † | Pointer-driven so it works in WebView2 |
| Captions: transcribe, show, style, fix words | 🟡 | Model, edits, inspector and timeline row done; transcription and on-picture captions not built |

## Picture

| Feature | Status | Notes |
| --- | --- | --- |
| Realtime preview, frame-accurate seeking | ✅ | WebCodecs (hardware decoding) |
| Transforms, zoom moves | ✅ | |
| Dissolve, dip to black, wipe; fades with curves | ✅ | Exact Editroom maths |
| Colour grade: exposure, contrast, saturation, temperature, tint, wheels | ✅ | Same 32³ cube as Editroom, values checked by hand |
| Built-in looks, `.cube` LUTs, intensity | ✅ | |
| Copy/paste grade | ✅ | |
| Graded filmstrips on the timeline | ⬜ | Filmstrips are ungraded |
| Upscaler (MetalFX in Editroom) | ⬜ | Exports scale bilinearly |
| Scrub caches for long-GOP files | ⬜ | Scrubbing decodes on demand |

## Sound

| Feature | Status | Notes |
| --- | --- | --- |
| Clip gain, track gain, fades, mute/solo, ducking | ✅ | |
| Meters, waveforms | ✅ | Editroom's algorithms and `.wave` cache format |
| Speed changes keep pitch | 🟡 | Constant speed: FFmpeg `atempo` (not Apple's algorithm). Ramps change pitch |
| Audio scrubbing | ✅ | |
| Even out levels | 🟡 | Edit exists; menu item not wired |

## Export

| Feature | Status | Notes |
| --- | --- | --- |
| H.264 / HEVC MP4 at Editroom's bit rates | ✅ | Hardware encoding via WebCodecs |
| Loudness targets (−14/−16/−23 LUFS) | ✅ | Verified with FFmpeg's ebur128 |
| Other frame shapes (vertical, square, portrait) with reframing | ✅ | |
| In/out range only | ✅ | |
| WAV | ✅ | |
| ProRes MOV, MP3 | ⬜ | |
| Export queue with progress | ✅ † | |

## AI

| Feature | Status | Notes |
| --- | --- | --- |
| MCP server (43 tools, same names and schemas as Editroom) | ✅ | Port 47921, server name `promptedit`, so it can run beside Editroom; each tool call is one undo step |
| Agent cursors on the timeline | ✅ | |
| One-click connect: Claude desktop (.mcpb), Codex, Claude Code | ✅ / 🟡 | macOS paths as Editroom; Windows paths written but not yet tried on a Windows PC |
| Magic with Claude / ChatGPT (your own plan, headless CLI) | ✅ | Tested end to end with a stand-in CLI |
| Magic Local: beat cuts, titles, zooms, ramps, improve | ✅ | Editroom's planners ported |
| Magic Local: understanding typed requests | 🟡 | Uses a local model through Ollama if it's running, else a keyword reader (Editroom uses Apple's on-device model) |
| Export started by an agent | ✅ | Runs through the export queue and reports progress back |
| `get_frame` / contact sheets for agents | 🟡 | Drawn from source frames by FFmpeg: no grades, titles or transitions |
| Transcripts and scene tags for agents | ⬜ | Same gap as search |
| "Magic at work" animation | ⬜ | Results apply at once |

## App

| Feature | Status | Notes |
| --- | --- | --- |
| Five themes (Dark, Grey, Amber, Light, Auto) | ✅ | |
| Native menu bar on macOS; in-window menus and title bar on Windows | 🟡 † | Written, not yet run inside Tauri |
| Full-screen viewer | ✅ † | |
| Updates | ⬜ | Needs `tauri-plugin-updater` and a signing key |
| Signed and notarised installers | ⬜ | CI signs once certificates are added as secrets (see README) |
