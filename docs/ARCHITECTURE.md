# PromptEdit architecture

PromptEdit is a cross-platform (macOS + Windows) port of
[Editroom](https://github.com/robbietilton/Editroom), a native macOS video editor (MIT).
The goal is feature parity with Editroom from one codebase. The original's behaviour is
documented in `docs/spec/` and tracked item by item in `docs/PARITY.md`.

## Why this stack

Editroom is built on Apple-only frameworks (AppKit/SwiftUI, AVFoundation, Core Image,
Metal, Vision, Speech, FoundationModels, Sparkle), so none of its code runs on Windows.
PromptEdit keeps Editroom's design and its project and MCP surface, and rebuilds the
engine on pieces that exist on both platforms:

| Concern | Editroom (macOS) | PromptEdit (macOS + Windows) |
| --- | --- | --- |
| App shell, windows, menus | AppKit / SwiftUI | Tauri 2 (Rust) + React/TypeScript UI |
| Project model, edits, undo | `EditorModel` (Swift) | `crates/core` (Rust), shared by UI commands, MCP and tests |
| Probe, odd formats (MXF, MKV, WebM…) | AVFoundation + bundled FFmpeg | FFmpeg/ffprobe sidecar (LGPL, separate program, same as Editroom) |
| Video decode | AVFoundation / VideoToolbox | WebCodecs `VideoDecoder` (hardware: VideoToolbox on macOS, Media Foundation/D3D on Windows); FFmpeg makes an edit-friendly copy of codecs WebCodecs can't decode |
| Compositing, grade, LUTs, transitions, text | Core Image + Metal | WebGL2 compositor, one shader path for preview **and** export so they match |
| Audio playback, mixing, scrub | AVFoundation / CoreAudio | Web Audio (AudioWorklet) over PCM extracted once by FFmpeg |
| Waveforms, loudness (LUFS), beats | Accelerate | Rust (`ebur128`, own DSP) on the extracted PCM |
| Export | AVAssetWriter / VideoToolbox | WebGL frames, then WebCodecs `VideoEncoder` (hardware) and a Rust MP4/MOV muxer; FFmpeg as fallback encoder |
| Transcripts | Speech | `whisper.cpp` (via `whisper-rs`), on device |
| Scene search tags | Vision | ONNX Runtime (`ort`) with a CLIP-style model, on device |
| Magic: Claude / ChatGPT | MCP into Claude app / Codex | Same MCP tools, served by Rust; same one-click connect, with Windows paths |
| Magic: Local | Apple FoundationModels | Heuristic planners ported as-is, plus an optional local LLM (Ollama/llama.cpp) |
| Updates | Sparkle | `tauri-plugin-updater` (signed) |

## Layout

```
crates/core/    Rust: project model (reads/writes Editroom's format), edit operations,
                undo, timecode. No UI, no I/O; unit tested on any OS.
src-tauri/      Rust: Tauri app – commands, media store (FFmpeg sidecar, caches),
                MCP server, agent connect, updater.
src/            TypeScript/React: UI (library, viewer, inspector, timeline, export, settings)
  engine/       WebCodecs decode, WebGL2 compositor, Web Audio mixer, export pipeline.
docs/spec/      What Editroom does, subsystem by subsystem (the reference for parity).
docs/PARITY.md  Feature checklist: status of every Editroom feature in PromptEdit.
```

## Data flow

- The Rust core owns the open project. The UI sends edit commands (`split`,
  `ripple_delete`, …) and gets a new project snapshot back; MCP tools call the same
  functions, so Claude/ChatGPT edits and human edits behave identically and share undo.
- While dragging, the UI draws the edit locally and commits one command on release.
- The renderer evaluates the snapshot at time *t* into layers (asset, source time,
  transform, grade, opacity, transition) and draws them with WebGL. Export runs the same
  renderer frame by frame, so what you see is what you export.

## Platform targets

- macOS 14+ on Apple silicon (as Editroom), `.dmg`, signed and notarised.
- Windows 10/11 x64, `.msi` / NSIS `.exe`, signed.
- Linux builds work for development and CI tests; not a release target.

## Known parity risks

- **ProRes and some camera codecs** aren't decodable by WebCodecs on either OS. PromptEdit
  makes an edit-friendly copy in the background (Editroom plays them directly on macOS).
- **HEVC on Windows** needs hardware support (and the HEVC extension on some PCs); when it's
  missing, PromptEdit falls back to an edit-friendly copy.
- **Local Magic** uses Apple's on-device model in Editroom; there is no equivalent built into
  Windows, so PromptEdit's Local option uses a local model the person installs.
- **Upscaler** uses MetalFX in Editroom; PromptEdit uses a shader/FFmpeg scaler.
