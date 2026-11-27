<p align="center"><img src="src-tauri/icons/128x128@2x.png" width="128" alt="PromptEdit icon"></p>

# PromptEdit

Fast video editing for **Mac and PC**, with AI that cuts for you. A cross-platform port of
[Editroom](https://github.com/robbietilton/Editroom) (MIT): the same editor, the same project files
(`.room`), the same Claude/ChatGPT tools, on macOS and Windows from one codebase.

> **Status: in development.** See [docs/PARITY.md](docs/PARITY.md) for what works today and what's
> still being ported.

## Download

Installers are built by GitHub Actions for every push to `main`
(Actions › Build › artifacts) and attached to a draft release for `v*` tags:

- **macOS** (Apple silicon, macOS 14+): `PromptEdit_<version>_aarch64.dmg`
- **Windows** (10/11, x64): `PromptEdit_<version>_x64-setup.exe` or `.msi`

Builds without a Developer ID show a warning on first open:

- **macOS:** drag PromptEdit to Applications, open it once, then System Settings › Privacy & Security
  › **Open Anyway**. If macOS says the app "is damaged" (older builds), run
  `xattr -cr /Applications/PromptEdit.app` in Terminal and open it again.
- **Windows:** "Windows protected your PC" › **More info** › **Run anyway**.

See [Signing](#signing) to sign them properly.

## Features

Everything Editroom does, on both platforms:

- **Editing**: multi-track timeline, split, ripple delete, ripple trim, close gaps, detach audio,
  duplicate, freeze frame, reverse, markers, in/out, text and solids, snapping, sticky edges, editable
  keyboard shortcuts.
- **Colour**: exposure, contrast, white balance, saturation, three-way wheels, built-in looks and
  `.cube` LUTs, copy/paste grade.
- **Speed and transitions**: speed changes, speed ramps, dissolve, dip to black, wipe, fades with
  curves, zooms.
- **Audio**: per-track level, mute, solo, ducking, meters, waveforms, loudness targets on export.
- **Export**: H.264/HEVC MP4, any frame shape (vertical, square, portrait), in/out range, audio-only.
- **Magic**: say what you want; Claude or ChatGPT (on your own plan) or a local model edits the timeline.
- **AI agents over MCP**: Claude Desktop, Claude Code and Codex can edit an open project directly.

## Build from source

Requirements: [Rust](https://rustup.rs) (stable), Node 22 + [pnpm](https://pnpm.io), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
```

```bash
node scripts/ffmpeg.mjs
```

```bash
pnpm tauri dev
```

`scripts/ffmpeg.mjs` puts LGPL FFmpeg and ffprobe where the app expects them: built from source on
macOS (VideoToolbox enabled), downloaded on Windows, linked from the system on Linux.

To build installers locally: `pnpm tauri build`.

### Tests

```bash
cargo test --workspace
```

```bash
pnpm test
```

### Developing in a browser

The UI also runs in a normal browser against a small development server that exposes the same
backend commands over HTTP (handy for quick iteration and for automated UI tests in Chromium):

```bash
cargo run -p promptedit --bin devserver
```

```bash
pnpm dev
```

Then open http://localhost:1420.

## How it works

Rust (Tauri 2) owns the project, edits and undo, media probing and conversion (FFmpeg as a separate
program), the MCP server and AI connections. The interface is React/TypeScript; video is decoded with
WebCodecs (hardware decoding on both OSes) and drawn with WebGL2, using the same renderer for preview
and export. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The behaviour being ported is
documented subsystem by subsystem in [docs/spec](docs/spec).

## Signing

The workflow signs automatically when these repository secrets are set:

- macOS: `APPLE_CERTIFICATE` (base64 .p12 Developer ID Application), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.
- Updates: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  (`pnpm tauri signer generate`).
- Windows code signing: see the [Tauri guide](https://tauri.app/distribute/sign/windows/).

## License

MIT, see [LICENSE](LICENSE). PromptEdit is a port of Editroom by Wonder Assembly LLC (MIT).
PromptEdit runs [FFmpeg](https://ffmpeg.org) (LGPL 2.1+) as a separate program to read and convert
media.
