#!/usr/bin/env node
// Puts LGPL FFmpeg + ffprobe where Tauri expects its sidecars:
//   src-tauri/binaries/ffmpeg-<target>[.exe], src-tauri/binaries/ffprobe-<target>[.exe]
//
// - macOS: builds FFmpeg from source (LGPL only, VideoToolbox on), like Editroom's
//   scripts/build-ffmpeg.sh but with ffprobe and the decoders PromptEdit needs.
// - Windows: downloads BtbN's LGPL static build.
// - Linux (development only): links the system ffmpeg/ffprobe.
//
// Usage: node scripts/ffmpeg.mjs [--target <rust target triple>]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, symlinkSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const FFMPEG_VERSION = '9.1';
const WINDOWS_BUILD =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src-tauri', 'binaries');
const args = process.argv.slice(2);
const target =
  args[args.indexOf('--target') + 1] && args.includes('--target')
    ? args[args.indexOf('--target') + 1]
    : execFileSync('rustc', ['--print', 'host-tuple']).toString().trim();
const exe = target.includes('windows') ? '.exe' : '';
const dest = (name) => join(out, `${name}-${target}${exe}`);

mkdirSync(out, { recursive: true });
if (existsSync(dest('ffmpeg')) && existsSync(dest('ffprobe'))) {
  console.log(`FFmpeg sidecars for ${target} already present.`);
  process.exit(0);
}

const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'inherit', ...opts });

if (target.includes('apple-darwin')) {
  const work = join(tmpdir(), `ffmpeg-build-${FFMPEG_VERSION}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const tarball = join(work, 'src.tar.xz');
  run('curl', ['-fsSL', '-o', tarball, `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`]);
  run('tar', ['-xf', tarball, '-C', work]);
  const src = join(work, `ffmpeg-${FFMPEG_VERSION}`);
  const arch = target.startsWith('aarch64') ? 'arm64' : 'x86_64';
  run(
    './configure',
    [
      `--arch=${arch}`,
      `--extra-cflags=-arch ${arch} -mmacosx-version-min=14.0`,
      `--extra-ldflags=-arch ${arch} -mmacosx-version-min=14.0`,
      '--disable-autodetect',
      '--disable-doc',
      '--disable-debug',
      '--disable-network',
      '--disable-ffplay',
      '--disable-shared',
      '--enable-static',
      '--enable-videotoolbox',
      '--enable-audiotoolbox',
      '--enable-zlib',
      // LGPL only: no --enable-gpl, no --enable-nonfree.
    ],
    { cwd: src },
  );
  run('make', ['-j8', 'ffmpeg', 'ffprobe'], { cwd: src });
  for (const name of ['ffmpeg', 'ffprobe']) {
    copyFileSync(join(src, name), dest(name));
    chmodSync(dest(name), 0o755);
  }
} else if (target.includes('windows')) {
  const work = join(tmpdir(), 'ffmpeg-win');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const zip = join(work, 'ffmpeg.zip');
  run('curl', ['-fsSL', '-o', zip, WINDOWS_BUILD]);
  run('tar', ['-xf', zip, '-C', work]); // bsdtar on Windows runners reads zip
  const dir = readdirSync(work).find((d) => d.startsWith('ffmpeg-'));
  for (const name of ['ffmpeg', 'ffprobe']) copyFileSync(join(work, dir, 'bin', `${name}.exe`), dest(name));
} else {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const sys = execFileSync('which', [name]).toString().trim();
    rmSync(dest(name), { force: true });
    symlinkSync(sys, dest(name));
  }
}
console.log(`FFmpeg sidecars ready in ${out}`);
