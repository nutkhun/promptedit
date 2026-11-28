// The WebGL2 compositor: one pass per layer, premultiplied source-over (`ONE, ONE_MINUS_SRC_ALPHA`)
// on a black base, on gamma-encoded values with bilinear sampling and no mipmaps, exactly the
// per-layer order of Editroom's TimelineCompositor (docs/spec/02-engine.md §1.2):
// fit (export: upscaler) → source colour (HDR/Log → 709) → wipe crop → clip transform → grade cube →
// opacity → over. The viewer and export use this same code, so what you see is what you export.

import type { YuvPlanes } from "../color/planes";
import { SOURCE_CUBE_SIZE } from "../color/source-color";
import { compile, uniforms, VERT, type Uniforms } from "./program";
import { Upscaler } from "./upscale";
import { YuvPass } from "./yuv-pass";

export type Rotation = 0 | 90 | 180 | 270;

/** A layer ready to draw: its picture and where it sits on the canvas (pre-transform, y down). */
export interface DrawLayer {
  picture:
    | {
      kind: "texture"; source: TexImageSource; key?: object | string; width: number; height: number; rotation: Rotation; rect: Rect;
      /** A video frame (the export upscaler only enlarges video, §12). */
      video?: boolean;
      /** Upload at half float: HDR/Log frames whose raw planes the browser won't hand over. */
      float?: boolean;
    }
    /** Raw decoder planes (HDR/Log sources): our own Y′CbCr → R′G′B′ (color/planes.ts). Always video. */
    | { kind: "planes"; planes: YuvPlanes; width: number; height: number; rotation: Rotation; rect: Rect }
    | { kind: "solid"; color: [number, number, number, number] };
  opacity: number;
  wipe?: number;
  transform?: { scale: number; x: number; y: number };
  cube?: Float32Array;
  /** The source's 64³ conversion to Rec.709 (§3.7), sampled after the fit and before `cube`. */
  sourceCube?: Float32Array;
}

export interface RenderOptions {
  /** Export: video drawn bigger than its own pixels is enlarged by the upscaler, not stretched (§12). */
  upscale?: boolean;
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Where the output sits on the layout canvas (§2.2): equal sizes and no offset unless reframing. */
export interface Frame {
  canvasWidth: number;
  canvasHeight: number;
  outWidth: number;
  outHeight: number;
  offsetX: number;
  offsetY: number;
}

const LAYER_FRAG = `#version 300 es
precision highp float;
precision mediump sampler3D;
uniform vec2 uCanvas;
uniform vec2 uOffset;
uniform float uOutH;
uniform vec2 uShift;      // x*W, y*H
uniform float uScale;
uniform vec4 uRect;
uniform int uRot;
uniform float uWipe;      // < 0: no wipe
uniform int uKind;        // 0 texture, 1 solid
uniform vec4 uColor;      // premultiplied
uniform sampler2D uTex;
uniform sampler3D uLut;
uniform bool uHasLut;
uniform highp sampler3D uSrcLut;
uniform bool uHasSrcLut;
uniform float uSrcN;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  // Canvas position of this output pixel, y down.
  vec2 c = vec2(uOffset.x + gl_FragCoord.x, uOffset.y + (uOutH - gl_FragCoord.y));
  // Undo the clip transform (scale about the canvas centre, then shift right/down).
  vec2 centre = uCanvas * 0.5;
  vec2 q = (c - centre - uShift) / uScale + centre;
  if (uWipe >= 0.0 && (q.x < 0.0 || q.x >= uCanvas.x * uWipe || q.y < 0.0 || q.y >= uCanvas.y)) discard;
  vec4 col;
  if (uKind == 1) {
    if (q.x < 0.0 || q.y < 0.0 || q.x >= uCanvas.x || q.y >= uCanvas.y) discard;
    col = uColor;
  } else {
    vec2 uv = (q - uRect.xy) / uRect.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    vec2 st = uv;
    if (uRot == 1) st = vec2(uv.y, 1.0 - uv.x);
    else if (uRot == 2) st = vec2(1.0 - uv.x, 1.0 - uv.y);
    else if (uRot == 3) st = vec2(1.0 - uv.y, uv.x);
    col = texture(uTex, st);
    if (uHasSrcLut) {
      // Source colour to Rec.709, on the fitted picture (video is opaque, so no un-premultiply).
      col.rgb = texture(uSrcLut, clamp(col.rgb, 0.0, 1.0) * ((uSrcN - 1.0) / uSrcN) + 0.5 / uSrcN).rgb * col.a;
    }
  }
  if (uHasLut) {
    // The cube works on un-premultiplied colour so transparent pixels stay transparent.
    vec3 rgb = col.a > 0.0 ? col.rgb / col.a : vec3(0.0);
    rgb = texture(uLut, clamp(rgb, 0.0, 1.0) * (31.0 / 32.0) + 0.5 / 32.0).rgb;
    col = vec4(rgb * col.a, col.a);
  }
  fragColor = col * uOpacity;
}`;

const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 fragColor;
// The target's bottom row is the canvas's bottom row, so no flip.
void main() { vec4 c = texture(uTex, vUV); fragColor = vec4(c.rgb, 1.0); }`;

// RGB → Y′CbCr, BT.709 matrix, limited range (16–235 / 16–240). Each output texel packs four
// consecutive samples of one plane into RGBA, so the planes read back as plain bytes.
const YUV_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;   // the composited frame, y down (row 0 = top)
uniform vec2 uSize;       // frame size in pixels
uniform int uPlane;       // 0 Y, 1 Cb, 2 Cr
out vec4 fragColor;
// p in pixels, y down; the frame's texture has the canvas's bottom row first.
vec3 rgbAt(vec2 p) { return texture(uTex, vec2(p.x / uSize.x, 1.0 - p.y / uSize.y)).rgb; }
float plane(vec3 c) {
  float y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (uPlane == 0) return (16.0 + 219.0 * y) / 255.0;
  if (uPlane == 1) return (128.0 + 224.0 * (c.b - y) / 1.8556) / 255.0;
  return (128.0 + 224.0 * (c.r - y) / 1.5748) / 255.0;
}
void main() {
  // Target row o.y is read back first for o.y = 0, so it holds the plane's row o.y from the top.
  ivec2 o = ivec2(gl_FragCoord.xy);
  vec4 v;
  for (int k = 0; k < 4; k++) {
    float x = float(o.x * 4 + k);
    vec2 p;
    if (uPlane == 0) p = vec2(x + 0.5, float(o.y) + 0.5);
    // 4:2:0, chroma centred in each 2×2 block: one bilinear tap at the block centre averages it.
    else p = vec2(x * 2.0 + 1.0, float(o.y) * 2.0 + 1.0);
    v[k] = plane(clamp(rgbAt(p), 0.0, 1.0));
  }
  fragColor = v;
}`;

export class Compositor {
  private layerProg: WebGLProgram;
  private blitProg: WebGLProgram;
  private yuvProg?: WebGLProgram;
  private lu: Uniforms;
  private bu: Uniforms;
  private yu?: Uniforms;
  private quad: WebGLVertexArrayObject;
  private fbo?: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };
  private yuvTargets: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }[] = [];
  private scratch: WebGLTexture[] = [];
  private cached = new Map<object | string, { tex: WebGLTexture; used: number }>();
  private luts = new WeakMap<Float32Array, WebGLTexture>();
  private frameNo = 0;
  private floatTarget: boolean;
  private yuv?: YuvPass;
  private upscaler?: Upscaler;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.floatTarget = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
    this.layerProg = compile(gl, VERT, LAYER_FRAG);
    this.blitProg = compile(gl, VERT, BLIT_FRAG);
    this.lu = uniforms(gl, this.layerProg, ["uCanvas", "uOffset", "uOutH", "uShift", "uScale", "uRect", "uRot", "uWipe", "uKind", "uColor", "uTex", "uLut", "uHasLut", "uSrcLut", "uHasSrcLut", "uSrcN", "uOpacity"]);
    this.bu = uniforms(gl, this.blitProg, ["uTex"]);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // No colour management, no flipping; stills and text arrive premultiplied.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(w: number, h: number): { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } {
    const gl = this.gl;
    if (this.fbo && this.fbo.w === w && this.fbo.h === h) return this.fbo;
    if (this.fbo) { gl.deleteFramebuffer(this.fbo.fb); gl.deleteTexture(this.fbo.tex); }
    const tex = this.texture();
    // Half-float intermediates band less on gradients than 8-bit (spec §1.2 parity note).
    if (this.floatTarget) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && this.floatTarget) {
      // Some drivers can't render to half float after all: fall back to 8-bit.
      this.floatTarget = false;
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(tex);
      return this.target(w, h);
    }
    this.fbo = { fb, tex, w, h };
    return this.fbo;
  }

  private lut(cube: Float32Array): WebGLTexture {
    let t = this.luts.get(cube);
    if (t) return t;
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    const n = Math.round(Math.cbrt(cube.length / 4));
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.FLOAT, cube);
    this.luts.set(cube, t);
    return t;
  }

  /** Uploads a picture: cached by `key` (stills, text), or into a per-slot scratch texture (video). */
  private upload(slot: number, source: TexImageSource, key?: object | string, float = false): WebGLTexture {
    const gl = this.gl;
    if (key !== undefined) {
      const hit = this.cached.get(key);
      if (hit) { hit.used = this.frameNo; return hit.tex; }
    }
    const tex = key !== undefined ? this.texture() : (this.scratch[slot] ??= this.texture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    // With colour conversion off, Chromium converts Y′CbCr with the frame's matrix and leaves the
    // curve alone; half float keeps 10-bit steps that 8-bit would merge.
    if (float && this.floatTarget) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (key !== undefined) this.cached.set(key, { tex, used: this.frameNo });
    return tex;
  }

  /** Whether export can upscale here (a half-float target; Editroom: MetalFX available). */
  get canUpscale(): boolean {
    return this.floatTarget;
  }

  /**
   * A layer's picture as a texture and where it sits: uploaded (or converted from raw planes), and
   * on export enlarged by the upscaler when it's drawn bigger than its own pixels (§1.2 step 3).
   * These passes use their own framebuffers, so they all run before the layers are drawn.
   */
  private prepare(l: DrawLayer, slot: number, f: Frame, o: RenderOptions): { tex: WebGLTexture; rect: Rect } | undefined {
    const p = l.picture;
    if (p.kind === "solid") return undefined;
    let tex: WebGLTexture;
    let srcW: number, srcH: number;
    if (p.kind === "planes") {
      this.yuv ??= new YuvPass(this.gl, this.quad, () => this.floatTarget);
      tex = this.yuv.convert(slot, p.planes);
      srcW = p.planes.width; srcH = p.planes.height;
    } else {
      this.gl.activeTexture(this.gl.TEXTURE0);
      tex = this.upload(slot, p.source, p.key, p.float);
      // The texture's own size, unrotated.
      [srcW, srcH] = p.rotation % 180 === 0 ? [p.width, p.height] : [p.height, p.width];
    }
    const video = p.kind === "planes" || p.video;
    const s = p.rect.width / Math.max(1, p.width);
    if (o.upscale && video && s > 1.01 && this.floatTarget) {
      const [tw, th] = p.rotation % 180 === 0 ? [p.width, p.height] : [p.height, p.width];
      const ow = Math.round(tw * s), oh = Math.round(th * s);
      this.upscaler ??= new Upscaler(this.gl, this.quad, () => this.floatTarget);
      if (this.upscaler.can(srcW, srcH, ow, oh)) {
        tex = this.upscaler.run(tex, srcW, srcH, ow, oh, slot);
        // Enlarged with detail rebuilt, then centred as the plain fit would be.
        const [rw, rh] = p.rotation % 180 === 0 ? [ow, oh] : [oh, ow];
        return { tex, rect: { x: (f.canvasWidth - rw) / 2, y: (f.canvasHeight - rh) / 2, width: rw, height: rh } };
      }
    }
    return { tex, rect: p.rect };
  }

  /** Draws the layers (bottom first) over black into the internal target at the output size. */
  render(layers: DrawLayer[], f: Frame, options: RenderOptions = {}) {
    const gl = this.gl;
    this.frameNo++;
    const prepared = layers.map((l, slot) => (l.opacity > 0.001 ? this.prepare(l, slot, f, options) : undefined));
    const t = this.target(f.outWidth, f.outHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, f.outWidth, f.outHeight);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.layerProg);
    gl.bindVertexArray(this.quad);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = this.lu;
    gl.uniform2f(u.uCanvas, f.canvasWidth, f.canvasHeight);
    gl.uniform2f(u.uOffset, f.offsetX, f.offsetY);
    gl.uniform1f(u.uOutH, f.outHeight);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uLut, 1);
    gl.uniform1i(u.uSrcLut, 2);
    gl.uniform1f(u.uSrcN, SOURCE_CUBE_SIZE);
    layers.forEach((l, slot) => {
      if (l.opacity <= 0.001) return;
      const tf = l.transform ?? { scale: 1, x: 0, y: 0 };
      if (!(tf.scale > 0)) return;
      gl.uniform1f(u.uScale, tf.scale);
      gl.uniform2f(u.uShift, tf.x * f.canvasWidth, tf.y * f.canvasHeight);
      gl.uniform1f(u.uWipe, l.wipe ?? -1);
      gl.uniform1f(u.uOpacity, l.opacity < 0.999 ? l.opacity : 1);
      if (l.picture.kind === "solid") {
        const [r, g, b, a] = l.picture.color;
        gl.uniform1i(u.uKind, 1);
        gl.uniform4f(u.uColor, r * a, g * a, b * a, a);
        // Not sampled, but whatever is bound must match the sampler's type.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
      } else {
        const p = l.picture;
        const ready = prepared[slot];
        if (!ready) return;
        gl.uniform1i(u.uKind, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ready.tex);
        gl.uniform4f(u.uRect, ready.rect.x, ready.rect.y, ready.rect.width, ready.rect.height);
        gl.uniform1i(u.uRot, p.rotation / 90);
      }
      gl.uniform1i(u.uHasSrcLut, l.sourceCube && l.picture.kind !== "solid" ? 1 : 0);
      if (l.sourceCube && l.picture.kind !== "solid") {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_3D, this.lut(l.sourceCube));
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.uniform1i(u.uHasLut, l.cube ? 1 : 0);
      if (l.cube) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, this.lut(l.cube));
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    // Stills and text not drawn for a while give their textures back.
    for (const [k, v] of this.cached) {
      if (this.frameNo - v.used > 240) { gl.deleteTexture(v.tex); this.cached.delete(k); }
    }
  }

  /** Draws the last render into the default framebuffer at `rect` (device pixels, y down), black around. */
  present(canvasWidth: number, canvasHeight: number, rect: Rect) {
    const gl = this.gl;
    if (!this.fbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const x = Math.round(rect.x), y = Math.round(rect.y);
    const w = Math.round(rect.width), h = Math.round(rect.height);
    gl.viewport(x, canvasHeight - y - h, w, h);
    gl.useProgram(this.blitProg);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fbo.tex);
    gl.uniform1i(this.bu.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /**
   * The last render's texture (bottom row first; half float where supported), for readbacks made
   * elsewhere: the ProRes export packs it as 10-bit v210 (export/v210.ts).
   */
  get output(): { tex: WebGLTexture; w: number; h: number } | undefined {
    return this.fbo;
  }

  /** Clears the default framebuffer to black (nothing to show). */
  clearScreen(canvasWidth: number, canvasHeight: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Reads the last render back as 8-bit RGBA, top row first (for tests and stills). */
  readRGBA(): Uint8Array {
    const gl = this.gl;
    const t = this.fbo!;
    const out = new Uint8Array(t.w * t.h * 4);
    const rgba8 = this.yuvTarget(0, t.w, t.h);
    // Copy through an 8-bit target (half-float targets can't be read as bytes everywhere).
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, rgba8.fb);
    gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, t.w, t.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rgba8.fb);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    // GL rows run bottom-up; flip to top-down.
    const row = t.w * 4, tmp = new Uint8Array(row);
    for (let y = 0; y < t.h >> 1; y++) {
      const a = y * row, b = (t.h - 1 - y) * row;
      tmp.set(out.subarray(a, a + row));
      out.copyWithin(a, b, b + row);
      out.set(tmp, b);
    }
    return out;
  }

  private yuvTarget(i: number, w: number, h: number) {
    const gl = this.gl;
    const cur = this.yuvTargets[i];
    if (cur && cur.w === w && cur.h === h) return cur;
    if (cur) { gl.deleteFramebuffer(cur.fb); gl.deleteTexture(cur.tex); }
    const tex = this.texture();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.yuvTargets[i] = { fb, tex, w, h };
    return this.yuvTargets[i];
  }

  /**
   * The last render as I420 (BT.709, limited range, 4:2:0 centre-sited), with row strides padded to
   * multiples of 4. Our own conversion, so the matrix doesn't depend on the browser (spec §16).
   */
  readI420(): { data: Uint8Array; layout: PlaneLayout[]; width: number; height: number } {
    const gl = this.gl;
    const t = this.fbo!;
    const W = t.w, H = t.h, cw = Math.ceil(W / 2), ch = Math.ceil(H / 2);
    if (!this.yuvProg) {
      this.yuvProg = compile(gl, VERT, YUV_FRAG);
      this.yu = uniforms(gl, this.yuvProg, ["uTex", "uSize", "uPlane"]);
    }
    const yStride = Math.ceil(W / 4) * 4, cStride = Math.ceil(cw / 4) * 4;
    const ySize = yStride * H, cSize = cStride * ch;
    const data = new Uint8Array(ySize + 2 * cSize);
    const planes = [
      { w: yStride / 4, h: H, offset: 0 },
      { w: cStride / 4, h: ch, offset: ySize },
      { w: cStride / 4, h: ch, offset: ySize + cSize },
    ];
    // Make the targets first: creating one rebinds TEXTURE_2D, which must end up as the source.
    const targets = planes.map((pl, i) => this.yuvTarget(i + 1, pl.w, pl.h));
    gl.useProgram(this.yuvProg);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(this.yu!.uTex, 0);
    gl.uniform2f(this.yu!.uSize, W, H);
    planes.forEach((pl, i) => {
      const target = targets[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, pl.w, pl.h);
      gl.uniform1i(this.yu!.uPlane, i);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, pl.w, pl.h, gl.RGBA, gl.UNSIGNED_BYTE, data.subarray(pl.offset, pl.offset + pl.w * 4 * pl.h));
    });
    gl.bindVertexArray(null);
    return {
      data, width: W, height: H,
      layout: [{ offset: 0, stride: yStride }, { offset: ySize, stride: cStride }, { offset: ySize + cSize, stride: cStride }],
    };
  }

  dispose() {
    const gl = this.gl;
    for (const v of this.cached.values()) gl.deleteTexture(v.tex);
    this.cached.clear();
    for (const t of this.scratch) gl.deleteTexture(t);
    this.scratch = [];
    this.yuv?.dispose();
    this.yuv = undefined;
    this.upscaler?.dispose();
    this.upscaler = undefined;
  }
}
