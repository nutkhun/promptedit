<p align="center"><img src="src-tauri/icons/128x128@2x.png" width="128" alt="PromptEdit icon"></p>

# PromptEdit

Fast video editing for **Mac and PC**, with AI that cuts for you. A cross-platform port of
[Editroom](https://github.com/robbietilton/Editroom) (MIT): the same editor, the same project files
(`.room`), the same Claude/ChatGPT tools, on macOS and Windows from one codebase.

> **Status: in development.** See [docs/PARITY.md](docs/PARITY.md) for what works today and what's
> still being ported.

## Download

Releases are on [GitHub Releases](https://github.com/nutkhun/promptedit/releases); installers for
every push to `main` are in Actions › Build › artifacts:

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
- Updates: see [Updates](#updates).
- Windows code signing: see the [Tauri guide](https://tauri.app/distribute/sign/windows/).

## Updates

PromptEdit checks for updates once a day (and from **Check for Updates…** in the PromptEdit menu on
macOS, the Help menu on Windows, or Settings › Updates), shows what's new, then downloads, installs
and relaunches. It reads
[`latest.json`](https://github.com/nutkhun/promptedit/releases/latest/download/latest.json) from the
latest published release, and installs only updates signed with the project's update key.

The key pair isn't in the repository. Until it's set up, builds work as before and say "This build
doesn't check for updates." To set it up, once, on your own Mac:

```bash
mkdir -p ~/.tauri && pnpm tauri signer generate -w ~/.tauri/promptedit.key
```

It asks for a password (keep it; an empty one works but isn't recommended) and writes
`~/.tauri/promptedit.key` (private) and `~/.tauri/promptedit.key.pub` (public). Back the private key
up somewhere safe: without it no update can ever be published to installed copies again. Then, in the
repository's **Settings › Secrets and variables › Actions**:

- **Secrets** tab › New repository secret: `TAURI_SIGNING_PRIVATE_KEY` = the contents of
  `~/.tauri/promptedit.key` (`pbcopy < ~/.tauri/promptedit.key`), and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = its password.
- **Variables** tab › New repository variable: `TAURI_UPDATER_PUBKEY` = the contents of
  `~/.tauri/promptedit.key.pub` (`pbcopy < ~/.tauri/promptedit.key.pub`), one line.

CI then puts the public key into the app (`scripts/updater-config.mjs`), signs the updater bundles,
and checks every signature against the public key before it publishes a release. Copies installed
before the key was set up don't check for updates; install one release by hand to get updates from
then on.

## Releasing

1. Set the version everywhere (package.json, src-tauri/tauri.conf.json, Cargo.toml, Cargo.lock):

   ```bash
   node scripts/version.mjs 0.2.0
   ```

   A pre-release needs a number after the dash (`0.2.0-1`, not `0.2.0-beta`): the Windows MSI
   installer allows nothing else.

2. Commit, then tag with what's new as the message, one change per line. The message becomes the
   release notes and the list in the app's update alert:

   ```bash
   git commit -am "PromptEdit 0.2.0"
   git tag -a v0.2.0 -m "Export is up to twice as fast
   Captions can be styled per clip"
   git push origin main v0.2.0
   ```

3. The Build workflow checks the tag matches the version, builds and signs macOS and Windows, and
   uploads them to a draft release. When both are done, its **Publish release** job writes
   `latest.json`, verifies it and publishes the release as the latest one; installed copies see it
   within a day. A pre-release tag (`v0.2.0-1`) is published as a pre-release, which the updater
   doesn't offer. If a build fails, the release stays a draft: fix it and re-run the workflow, or
   delete the draft and the tag and tag again.

## License

MIT, see [LICENSE](LICENSE). PromptEdit is a port of Editroom by Wonder Assembly LLC (MIT).
PromptEdit runs [FFmpeg](https://ffmpeg.org) (LGPL 2.1+) as a separate program to read and convert
media.
