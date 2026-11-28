// The export upscaler (docs/spec/02-engine.md §12). Editroom enlarges video drawn bigger than its own
// pixels with MetalFX's spatial scaler (perceptual mode, gamma-encoded input). Here: AMD FidelityFX
// Super Resolution 1.0 — EASU, the edge-adaptive Lanczos-like scaler, then RCAS at a low sharpness —
// ported from ffx_fsr1.h (MIT, Copyright (c) 2021 Advanced Micro Devices, Inc.) to WebGL2 with
// texelFetch taps. Both work on gamma-encoded values, as FSR expects.
//
// Not pixel-identical to MetalFX (a proprietary scaler); same intent: rebuilt edges, not a stretch.

import { compile, uniforms, VERT, type Uniforms } from "./program";

/** RCAS sharpness in stops (0 = strongest). FSR's docs suggest 0.2 for games; video wants less. */
export const RCAS_SHARPNESS = 0.5;
/** The largest picture made, as MetalFX allows (and every WebGL2 GPU's texture limit or less). */
const MAX_SIZE = 16384;

const EASU_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform ivec2 uIn;      // input size
uniform vec2 uScale;    // input / output
out vec4 fragColor;

vec3 tap(ivec2 p) { return clamp(texelFetch(uTex, clamp(p, ivec2(0), uIn - 1), 0).rgb, 0.0, 1.0); }
float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

// Accumulates direction and length for one of the four bilinear corners ('+' around c).
void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  float dc = lD - lC, cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1e-8);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC, ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1e-8);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

// One filter tap: rotate the offset by the edge direction, stretch, windowed Lanczos-2 approximation.
void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x);
  v *= len2;
  float d2 = min(v.x * v.x + v.y * v.y, clp);
  float wB = 2.0 / 5.0 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 25.0 / 16.0 * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main() {
  // Output pixel centre in input texel space (texel k's centre at k). Row 0 stays the top row.
  vec2 pp = (floor(gl_FragCoord.xy) + 0.5) * uScale - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 f0 = ivec2(fp);
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 b = tap(f0 + ivec2(0, -1)), c = tap(f0 + ivec2(1, -1));
  vec3 e = tap(f0 + ivec2(-1, 0)), f = tap(f0), g = tap(f0 + ivec2(1, 0)), h = tap(f0 + ivec2(2, 0));
  vec3 i = tap(f0 + ivec2(-1, 1)), j = tap(f0 + ivec2(0, 1)), k = tap(f0 + ivec2(1, 1)), l = tap(f0 + ivec2(2, 1));
  vec3 n = tap(f0 + ivec2(0, 2)), o = tap(f0 + ivec2(1, 2));
  float bL = luma(b), cL = luma(c), eL = luma(e), fL = luma(f), gL = luma(g), hL = luma(h);
  float iL = luma(i), jL = luma(j), kL = luma(k), lL = luma(l), nL = luma(n), oL = luma(o);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < 1.0 / 32768.0;
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  len = len * 0.5;
  len *= len;
  float stretch = (dir.x * dir.x + dir.y * dir.y) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 min4 = min(min(f, g), min(j, k));
  vec3 max4 = max(max(f, g), max(j, k));
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  easuTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  easuTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  easuTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  easuTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, f);
  easuTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  easuTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  easuTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  easuTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  easuTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  easuTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, o);
  easuTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  // Normalise and de-ring against the four nearest.
  fragColor = vec4(min(max4, max(min4, aC / aW)), 1.0);
}`;

const RCAS_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;
uniform ivec2 uSize;
uniform float uSharp;   // exp2(-sharpness)
out vec4 fragColor;
vec3 at(ivec2 p) { return texelFetch(uTex, clamp(p, ivec2(0), uSize - 1), 0).rgb; }
void main() {
  //    b
  //  d e f
  //    h
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 b = at(p + ivec2(0, -1)), d = at(p + ivec2(-1, 0)), e = at(p), f = at(p + ivec2(1, 0)), h = at(p + ivec2(0, 1));
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  // Limiters: the most negative lobe that keeps the result inside the ring's range.
  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1e-5));
  vec3 hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3(-1e-5));
  vec3 lobeRGB = max(-hitMin, hitMax);
  const float LIMIT = 0.25 - 1.0 / 16.0;
  float lobe = max(-LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uSharp;
  vec3 c = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

interface Target { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

export class Upscaler {
  private easu: WebGLProgram;
  private rcas: WebGLProgram;
  private eu: Uniforms;
  private ru: Uniforms;
  /** Per layer slot: the EASU result and the sharpened one. */
  private targets = new Map<string, Target>();

  constructor(private gl: WebGL2RenderingContext, private quad: WebGLVertexArrayObject, private float: () => boolean) {
    this.easu = compile(gl, VERT, EASU_FRAG);
    this.rcas = compile(gl, VERT, RCAS_FRAG);
    this.eu = uniforms(gl, this.easu, ["uTex", "uIn", "uScale"]);
    this.ru = uniforms(gl, this.rcas, ["uTex", "uSize", "uSharp"]);
  }

  /** Whether it can enlarge `w×h` to `ow×oh` (Editroom: bigger on both axes, at most 16384). */
  can(w: number, h: number, ow: number, oh: number): boolean {
    const max = Math.min(MAX_SIZE, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number);
    return w > 1 && h > 1 && ow > w && oh > h && ow <= max && oh <= max;
  }

  private target(key: string, w: number, h: number): Target {
    const gl = this.gl;
    const cur = this.targets.get(key);
    if (cur && cur.w === w && cur.h === h) return cur;
    if (cur) { gl.deleteFramebuffer(cur.fb); gl.deleteTexture(cur.tex); }
    // Editroom keeps up to 24 layer textures; more slots than that, start again.
    if (this.targets.size >= 24) this.dispose();
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // rgba16Float as MetalFX's; 8-bit only where half float doesn't render.
    if (this.float()) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { fb, tex, w, h };
    this.targets.set(key, t);
    return t;
  }

  /**
   * `src` (w×h, row 0 at the top, gamma-encoded) enlarged to ow×oh, same orientation. `slot` keeps
   * the layers of one frame apart. `sharpness` in stops, or undefined for EASU alone.
   */
  run(src: WebGLTexture, w: number, h: number, ow: number, oh: number, slot: number, sharpness: number | undefined = RCAS_SHARPNESS): WebGLTexture {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);

    const up = this.target(`${slot}-easu`, ow, oh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, up.fb);
    gl.viewport(0, 0, ow, oh);
    gl.useProgram(this.easu);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(this.eu.uTex, 0);
    gl.uniform2i(this.eu.uIn, w, h);
    gl.uniform2f(this.eu.uScale, w / ow, h / oh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (sharpness === undefined) { gl.bindVertexArray(null); return up.tex; }

    const sharp = this.target(`${slot}-rcas`, ow, oh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sharp.fb);
    gl.useProgram(this.rcas);
    gl.bindTexture(gl.TEXTURE_2D, up.tex);
    gl.uniform1i(this.ru.uTex, 0);
    gl.uniform2i(this.ru.uSize, ow, oh);
    gl.uniform1f(this.ru.uSharp, Math.pow(2, -sharpness));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    return sharp.tex;
  }

  /** Lets go of the textures (after an export, as Editroom's `purge`). */
  dispose() {
    const gl = this.gl;
    for (const t of this.targets.values()) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    this.targets.clear();
  }
}

let available: boolean | undefined;

/**
 * Whether exports here can upscale (Editroom: `Upscaler.shared.available`, i.e. MetalFX on this Mac):
 * WebGL2 that renders to half float, which the scaler's textures need. Checked once.
 */
export function upscalerAvailable(): boolean {
  if (available !== undefined) return available;
  try {
    const gl = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1).getContext("webgl2") : null;
    available = !!gl && (!!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float"));
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    available = false;
  }
  return available;
}
