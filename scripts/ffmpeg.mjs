#!/usr/bin/env node
// Puts LGPL FFmpeg + ffprobe where Tauri expects its sidecars:
//   src-tauri/binaries/ffmpeg-<target>[.exe], src-tauri/binaries/ffprobe-<target>[.exe]
//
// - macOS: builds FFmpeg from source (LGPL only, VideoToolbox on), like Editroom's
//   scripts/build-ffmpeg.sh but with ffprobe, the decoders PromptEdit needs, and LAME (LGPL, built
//   from source first) for MP3 export. ProRes export uses VideoToolbox's encoder or FFmpeg's own.
// - Windows: downloads BtbN's LGPL static build (it includes LAME and FFmpeg's ProRes encoder).
// - Linux (development only): links the system ffmpeg/ffprobe. PROMPTEDIT_FFMPEG_FROM_SOURCE=1
//   builds from source the macOS way instead (to try the build on Linux; with --out somewhere else).
//
// Usage: node scripts/ffmpeg.mjs [--target <rust target triple>] [--out <dir>]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, symlinkSync, rmSync, readdirSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, cpus } from 'node:os';

const FFMPEG_VERSION = '9.1';
// LAME 3.100 is the current release (2017). Checked against this hash, as Homebrew does.
const LAME_VERSION = '3.100';
const LAME_URL = `https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz`;
const LAME_SHA256 = 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e';
const WINDOWS_BUILD =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = option('--out') ? resolve(option('--out')) : join(root, 'src-tauri', 'binaries');
const target = option('--target') ?? execFileSync('rustc', ['--print', 'host-tuple']).toString().trim();
const exe = target.includes('windows') ? '.exe' : '';
const dest = (name) => join(out, `${name}-${target}${exe}`);
const mac = target.includes('apple-darwin');
const fromSource = mac || (target.includes('linux') && process.env.PROMPTEDIT_FFMPEG_FROM_SOURCE === '1');
const jobs = String(Math.max(2, cpus().length));

mkdirSync(out, { recursive: true });
if (existsSync(dest('ffmpeg')) && existsSync(dest('ffprobe'))) {
  console.log(`FFmpeg sidecars for ${target} already present.`);
  process.exit(0);
}

const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'inherit', ...opts });

/** Downloads `url` to `file`, failing unless its SHA-256 is `sha256` (when given). */
function download(url, file, sha256) {
  run('curl', ['-fsSL', '--retry', '3', '-o', file, url]);
  if (sha256) {
    const got = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (got !== sha256) throw new Error(`${url}: SHA-256 is ${got}, expected ${sha256}`);
  }
}

/**
 * Builds LAME as a static library for `arch` and returns its install prefix. Kept between runs
 * (the prefix is named after the version and target, and only reused when complete), so a rebuild
 * of FFmpeg doesn't rebuild LAME.
 */
function buildLame(arch, archFlags) {
  const prefix = join(tmpdir(), `lame-${LAME_VERSION}-${target}`);
  const lib = join(prefix, 'lib', 'libmp3lame.a');
  if (existsSync(lib) && existsSync(join(prefix, 'include', 'lame', 'lame.h'))) {
    console.log(`LAME ${LAME_VERSION} already built in ${prefix}`);
    return prefix;
  }
  const work = join(tmpdir(), `lame-build-${LAME_VERSION}-${target}`);
  rmSync(work, { recursive: true, force: true });
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const tarball = join(work, 'lame.tar.gz');
  download(LAME_URL, tarball, LAME_SHA256);
  run('tar', ['-xzf', tarball, '-C', work]);
  const src = join(work, `lame-${LAME_VERSION}`);
  // lame_init_old is listed for export but not defined; macOS's linker rejects that when a shared
  // library is made (Homebrew removes it the same way). We build static only, but keep it safe.
  const sym = join(src, 'include', 'libmp3lame.sym');
  writeFileSync(sym, readFileSync(sym, 'utf8').replace(/^lame_init_old\n/m, ''));
  // LAME's config.guess (2017) predates Apple silicon; name the machine instead of guessing.
  const host = mac ? [`--host=${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, `--build=${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`] : [];
  run(
    './configure',
    [
      `--prefix=${prefix}`,
      ...host,
      '--disable-shared',
      '--enable-static',
      '--disable-frontend', // the lame command; only the library is needed
      '--disable-decoder', // mpglib (MP3 decoding); FFmpeg decodes MP3 itself
      '--disable-dependency-tracking',
      '--disable-debug',
    ],
    // Recent clang makes calls to undeclared functions an error; LAME's sources predate that rule
    // (Homebrew builds LAME with the same flag).
    { cwd: src, env: { ...process.env, CFLAGS: `${archFlags} -O2 -DNDEBUG -Wno-implicit-function-declaration`.trim(), LDFLAGS: archFlags } },
  );
  run('make', [`-j${jobs}`], { cwd: src });
  run('make', ['install'], { cwd: src });
  rmSync(work, { recursive: true, force: true });
  if (!existsSync(lib)) throw new Error(`LAME didn't build: no ${lib}`);
  return prefix;
}

if (fromSource) {
  const arch = target.startsWith('aarch64') ? 'arm64' : 'x86_64';
  const archFlags = mac ? `-arch ${arch} -mmacosx-version-min=14.0` : '';
  const lame = buildLame(arch, archFlags);
  const work = join(tmpdir(), `ffmpeg-build-${FFMPEG_VERSION}-${target}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const tarball = join(work, 'src.tar.xz');
  download(`https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`, tarball);
  run('tar', ['-xf', tarball, '-C', work]);
  const src = join(work, `ffmpeg-${FFMPEG_VERSION}`);
  run(
    './configure',
    [
      ...(mac ? [`--arch=${arch}`] : []),
      `--extra-cflags=${[archFlags, `-I${join(lame, 'include')}`].filter(Boolean).join(' ')}`,
      `--extra-ldflags=${[archFlags, `-L${join(lame, 'lib')}`].filter(Boolean).join(' ')}`,
      '--disable-autodetect',
      '--disable-doc',
      '--disable-debug',
      '--disable-network',
      '--disable-ffplay',
      '--disable-shared',
      '--enable-static',
      ...(mac ? ['--enable-videotoolbox', '--enable-audiotoolbox'] : []),
      '--enable-zlib',
      // MP3 export (LAME is LGPL; FFmpeg stays LGPL with it).
      '--enable-libmp3lame',
      // LGPL only: no --enable-gpl, no --enable-nonfree.
    ],
    { cwd: src },
  );
  run('make', [`-j${jobs}`, 'ffmpeg', 'ffprobe'], { cwd: src });
  // The encoders the export relies on must be there (configure drops a library it can't find
  // only when it was autodetected, but check the result rather than trust that).
  const encoders = execFileSync(join(src, 'ffmpeg'), ['-hide_banner', '-encoders']).toString();
  const has = (e) => new RegExp(`\\s${e}\\s`).test(encoders);
  for (const e of ['libmp3lame', 'prores_ks']) {
    if (!has(e)) throw new Error(`The FFmpeg build has no ${e} encoder.`);
  }
  // Apple's ProRes encoder is preferred on Macs, but the app falls back to prores_ks without it.
  if (mac && !has('prores_videotoolbox')) console.warn('Warning: the FFmpeg build has no prores_videotoolbox encoder.');
  for (const name of ['ffmpeg', 'ffprobe']) {
    copyFileSync(join(src, name), dest(name));
    chmodSync(dest(name), 0o755);
  }
  rmSync(work, { recursive: true, force: true });
} else if (target.includes('windows')) {
  const work = join(tmpdir(), 'ffmpeg-win');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const zip = join(work, 'ffmpeg.zip');
  download(WINDOWS_BUILD, zip);
  // Windows' own bsdtar reads zip files (a Git-for-Windows GNU tar earlier on PATH would not, and
  // PowerShell's Expand-Archive breaks when the runner mixes PowerShell 5 and 7 modules).
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  run(tar, ['-xf', zip, '-C', work]);
  const dir = readdirSync(work).find((d) => d.startsWith('ffmpeg-') && !d.endsWith('.zip'));
  if (!dir) throw new Error(`FFmpeg archive didn't unpack as expected: ${readdirSync(work).join(', ')}`);
  for (const name of ['ffmpeg', 'ffprobe']) copyFileSync(join(work, dir, 'bin', `${name}.exe`), dest(name));
  // BtbN's LGPL builds include LAME; say so loudly if that ever changes.
  const encoders = execFileSync(dest('ffmpeg'), ['-hide_banner', '-encoders']).toString();
  for (const e of ['libmp3lame', 'prores_ks']) {
    if (!new RegExp(`\\s${e}\\s`).test(encoders)) throw new Error(`The Windows FFmpeg build has no ${e} encoder.`);
  }
} else {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const sys = execFileSync('which', [name]).toString().trim();
    rmSync(dest(name), { force: true });
    symlinkSync(sys, dest(name));
  }
}
console.log(`FFmpeg sidecars ready in ${out}`);
