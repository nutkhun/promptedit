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
| Untitled recovery copy | ✅ † | Untitled work, and unsaved changes while Auto-save is off, kept in `<app data>/Recovery/Untitled.room` (compact JSON) ~2 s after an edit and on quit; reopened unsaved at launch (`lastSession` "untitled" / `recoveryFor`); removed on save, discard or New |
| Open Recent, reopen last session | ✅ † | |
| Linked folders (Media mirrors a folder on disk) | 🟡 † | Import Folder… / dropping a folder links it; folder tiles open (back, title, search across the open folder with place lines), files added or deleted on disk follow while the app runs (watched with `notify`, also on focus and open), removed items stay out via `hiddenMedia`, Undo brings them back, missing folder banner + Locate…, Reload Folder from Disk, a moved project folder finds its folders by relative path. Differences: renames/moves are followed by file identity while the app runs (Editroom uses macOS bookmarks, which also work across launches and for a linked folder moved elsewhere on the drive); the system picker can't take files and folders at once, so folders come in with Import Folder… (Media panel menu) or a drop |
| macOS security-scoped bookmarks | 🟡 | Kept in the file for Editroom; PromptEdit uses paths |

## Media

| Feature | Status | Notes |
| --- | --- | --- |
| Import MP4/MOV/M4A/WAV/MP3/images | ✅ | |
| MKV, WebM, MXF, AVI… (rewrapped or converted by FFmpeg) | ✅ | Same strategy as Editroom |
| Codecs the webview can't decode (ProRes, DNxHD, some HEVC) | 🟡 | Converted to an edit-friendly H.264 copy in the background; Editroom plays ProRes directly |
| Rotation metadata | ✅ | |
| HDR / Apple Log to Rec.709 | 🟡† | HLG/PQ from ffprobe's transfer; Apple Log / Log 2 found in the file's `stsd` sample description (Rust). Editroom's §3.7 maths baked to a 64³ cube, applied after the fit in viewer, thumbnails and export. Frames go as raw 10-bit planes (`VideoFrame.copyTo`) through our own Y′CbCr shader: six-patch golden clips (HLG, PQ, Apple Log, 10-bit SDR) land within 1/255 of the curve in the viewer, 2/255 after H.264 export. Differences: HLG/PQ use Editroom's fitted model of macOS's tone mapping (~2 %, no Dolby Vision metadata), not AVFoundation itself. Raw planes verified only for Chromium software decode (H.264 High 10, VP9 p2, AV1); hardware frames that report no pixel format (likely WebView2 HEVC Main 10, WebKit 10-bit) fall back to the browser's own Y′CbCr conversion at half float (up to ~9/255 off in saturated colours). HEVC where the webview can't decode it becomes an 8-bit H.264 copy (tags and Apple Log kept) |
| Library: thumbnails/list, search by name, hover-scrub, context menus | ✅ † | |
| Search by what's said (quoted words, with snippets) | ✅ | On-device transcripts (whisper.cpp) |
| Search by what's in the picture (scene tags) | 🟡 † | CLIP ViT-B/32 (int8 ONNX, MIT, 156 MB, downloaded once on consent: the first search for something no clip is named, or Settings › General › Picture search) on ONNX Runtime linked statically (`ort`), on this computer. Editroom's sampling (8–20 frames, a photo once), 0.2/0.35 thresholds, cache `Scenes/<cacheName>-3.json` in its JSON shape, background queue 3 s after import/open only when the model is here. Plain words match names or tags (aliases, singulars, stems, prefix while typing, as `SceneTags.shows`); results say what matched ("shows beach"). Differences: the label list is a ~900-label reconstruction of Vision's taxonomy (no Mac to export `supportedIdentifiers`; all of Editroom's alias keys are in it) plus calibrated broad categories (people, animal, sky, night…); confidences are CLIP similarities calibrated on CC0 photos to Vision's scale (`src-tauri/src/scenes/calibrate.py`), so exact tags differ from Vision's; no Apple Intelligence keywords; "laughter"/"smile" are weak. Tested on Linux (unit tests, end to end with real photos, Chromium UI); the static ONNX Runtime link on macOS arm64 / Windows x64 is configured for CI but not yet built there |
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
| Captions: transcribe, show, style, fix words, burn into export | ✅ | whisper.cpp on the computer (Metal on Macs), model downloaded once (Fast/Balanced/Best), auto or chosen language. Word timing differs a little from Apple's recogniser, so phrasing can differ |

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
| Upscaler (MetalFX in Editroom) | 🟡† | Export only, as Editroom: video drawn > 1.01× its pixels is enlarged with FSR 1 EASU + RCAS (0.5 stops) in WebGL2 at half float, then centred; bilinear where half float doesn't render. Export sheet badge "Upscaled from Np". 640×360 → 1080p: +59 % gradient energy and +1.1 dB PSNR vs bilinear. Not pixel-identical to MetalFX |
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
| ProRes MOV (422 Proxy, LT, 422, HQ) | ✅ † | Not in Editroom (PromptEdit's own). The same compositor's frames, packed on the GPU as 10-bit 4:2:2 (v210, BT.709 limited range, co-sited chroma) and sent raw (no base64) to FFmpeg as they render: `prores_videotoolbox` on Macs where it works, else `prores_ks`; sound as 24-bit PCM; loudness target applied. Verified in Chromium through the dev server (ffprobe, ebur128); raw-body IPC speed inside the Tauri window (WebView2, WKWebView) not yet measured |
| MP3 (320 or 192 kb/s CBR) | ✅ | Not in Editroom (PromptEdit's own). LAME through FFmpeg: built into the macOS sidecar from source, included in BtbN's Windows LGPL build; loudness target applied |
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
| Export started by an agent | ✅ | Runs through the export queue and reports progress back. The `export` tool also takes `format` `prores` and `mp3` and a `prores_profile` (additions to Editroom's schema) |
| `get_frame` / contact sheets for agents | 🟡 | Drawn from source frames by FFmpeg: no grades, titles or transitions |
| Transcripts for agents (`get_transcript`, `set_captions`) | ✅ | |
| Scene tags for agents | 🟡 | `SceneTagProvider` registered: `list_media` "shows" (top 8 of 20, minus common tags) and `search_media` shows/times use the same tags and Editroom's word matching (tested through the MCP tools); Magic's local "showing" too. Same label differences as picture search |
| "Magic at work" animation | ⬜ | Results apply at once |

## App

| Feature | Status | Notes |
| --- | --- | --- |
| Five themes (Dark, Grey, Amber, Light, Auto) | ✅ | |
| Native menu bar on macOS; in-window menus and title bar on Windows | 🟡 † | Written, not yet run inside Tauri |
| Full-screen viewer | ✅ † | |
| Updates | 🟡 | `tauri-plugin-updater` from GitHub Releases (`latest.json`): daily automatic checks, Check for Updates…, update alert with what's new, Skip / Remind Me Later / auto-download, download progress, install and relaunch; Settings › Updates. Off until the signing key is set up (README › Updates); not yet tried with a real release. A background-downloaded update is offered ready to install, not installed silently at quit |
| Signed and notarised installers | ⬜ | CI signs once certificates are added as secrets (see README) |
