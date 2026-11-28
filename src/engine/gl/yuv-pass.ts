// Y′CbCr → R′G′B′ for raw decoder planes (HDR / Log sources, docs/spec/02-engine.md §3.7): the
// samples go up as integer textures and one pass writes R′G′B′ (still in the file's own curve and
// primaries; the source cube converts it after the fit) into a half-float texture at the picture's
// size. Our own maths, so the matrix and range are the file's, never the browser's choice.

import type { YuvPlanes } from "../color/planes";
import { compile, uniforms, VERT, type Uniforms } from "./program";

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uY;
uniform usampler2D uU;     // Cb (or CbCr interleaved)
uniform usampler2D uV;     // Cr
uniform bool uInterleaved;
uniform ivec2 uSub;        // chroma subsampling factors
uniform ivec2 uChroma;     // chroma plane size
uniform float uBits;
uniform bool uFull;
uniform vec2 uK;           // Kr, Kb
out vec4 fragColor;

vec2 cbcrAt(ivec2 p) {
  p = clamp(p, ivec2(0), uChroma - 1);
  if (uInterleaved) { uvec4 c = texelFetch(uU, p, 0); return vec2(c.r, c.g); }
  return vec2(float(texelFetch(uU, p, 0).r), float(texelFetch(uV, p, 0).r));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);   // row 0 is the picture's top row, as the planes are
  float y = float(texelFetch(uY, p, 0).r);
  // Chroma sited as H.264/HEVC's default (left): co-sited with even luma columns horizontally,
  // between luma rows vertically for 4:2:0. Bilinear between the four nearest samples.
  vec2 c = vec2(p);
  if (uSub.x == 2) c.x = c.x * 0.5;
  if (uSub.y == 2) c.y = (c.y - 0.5) * 0.5;
  vec2 f = floor(c);
  vec2 w = c - f;
  ivec2 i = ivec2(f);
  vec2 cbcr = mix(mix(cbcrAt(i), cbcrAt(i + ivec2(1, 0)), w.x), mix(cbcrAt(i + ivec2(0, 1)), cbcrAt(i + ivec2(1, 1)), w.x), w.y);
  float yn; vec2 cn;
  if (uFull) {
    float mx = exp2(uBits) - 1.0;
    yn = y / mx;
    cn = (cbcr - exp2(uBits - 1.0)) / mx;
  } else {
    float s = exp2(uBits - 8.0);       // 10-bit codes are 8-bit codes × 4
    yn = (y / s - 16.0) / 219.0;
    cn = (cbcr / s - 128.0) / 224.0;
  }
  float kr = uK.x, kb = uK.y;
  float r = yn + 2.0 * (1.0 - kr) * cn.y;
  float b = yn + 2.0 * (1.0 - kb) * cn.x;
  float g = (yn - kr * r - kb * b) / (1.0 - kr - kb);
  fragColor = vec4(r, g, b, 1.0);
}`;

interface Target { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

export class YuvPass {
  private prog: WebGLProgram;
  private u: Uniforms;
  private planes: WebGLTexture[] = [];
  private targets: Target[] = [];

  constructor(private gl: WebGL2RenderingContext, private quad: WebGLVertexArrayObject, private float: () => boolean) {
    this.prog = compile(gl, VERT, FRAG);
    this.u = uniforms(gl, this.prog, ["uY", "uU", "uV", "uInterleaved", "uSub", "uChroma", "uBits", "uFull", "uK"]);
  }

  private plane(i: number): WebGLTexture {
    const gl = this.gl;
    let t = this.planes[i];
    if (!t) {
      t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      // Integer textures can't be filtered; the shader fetches texels.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.planes[i] = t;
    }
    return t;
  }

  /** A per-slot R′G′B′ target of the picture's size (half float where it renders, else 8-bit). */
  private target(slot: number, w: number, h: number): Target {
    const gl = this.gl;
    const cur = this.targets[slot];
    if (cur && cur.w === w && cur.h === h) return cur;
    if (cur) { gl.deleteFramebuffer(cur.fb); gl.deleteTexture(cur.tex); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.float()) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.targets[slot] = { fb, tex, w, h };
    return this.targets[slot];
  }

  private upload(unit: number, index: number, y: YuvPlanes, plane: number, w: number, h: number, channels: 1 | 2) {
    const gl = this.gl;
    const wide = y.info.bits > 8;
    const bytes = wide ? 2 : 1;
    const { offset, stride } = y.layout[plane];
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.plane(index));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / bytes / channels);
    const count = (stride / bytes) * (h - 1) + w * channels;
    const internal = wide ? (channels === 2 ? gl.RG16UI : gl.R16UI) : (channels === 2 ? gl.RG8UI : gl.R8UI);
    const format = channels === 2 ? gl.RG_INTEGER : gl.RED_INTEGER;
    const src = wide
      ? new Uint16Array(y.data.buffer, y.data.byteOffset + offset, count)
      : y.data.subarray(offset, offset + count);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, wide ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /** The planes as R′G′B′ in a texture of the picture's size (row 0 at the top), for slot `slot`. */
  convert(slot: number, y: YuvPlanes): WebGLTexture {
    const gl = this.gl;
    const { sx, sy, interleaved, bits } = y.info;
    const W = y.width, H = y.height;
    const cw = Math.ceil(W / sx), ch = Math.ceil(H / sy);
    // The target first: making it binds its texture, which must not land on a plane's unit.
    gl.activeTexture(gl.TEXTURE0);
    const t = this.target(slot, W, H);
    this.upload(0, 0, y, 0, W, H, 1);
    if (interleaved) {
      this.upload(1, 1, y, 1, cw, ch, 2);
    } else {
      this.upload(1, 1, y, 1, cw, ch, 1);
      this.upload(2, 2, y, 2, cw, ch, 1);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    const u = this.u;
    gl.uniform1i(u.uY, 0);
    gl.uniform1i(u.uU, 1);
    gl.uniform1i(u.uV, interleaved ? 1 : 2);
    gl.uniform1i(u.uInterleaved, interleaved ? 1 : 0);
    gl.uniform2i(u.uSub, sx, sy);
    gl.uniform2i(u.uChroma, cw, ch);
    gl.uniform1f(u.uBits, bits);
    gl.uniform1i(u.uFull, y.fullRange ? 1 : 0);
    gl.uniform2f(u.uK, y.k[0], y.k[1]);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    // Leave no integer texture bound where float samplers look next.
    for (const unit of [2, 1, 0]) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, null); }
    return t.tex;
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.planes) gl.deleteTexture(t);
    for (const t of this.targets) if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    this.planes = [];
    this.targets = [];
  }
}
