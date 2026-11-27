// The WebGL2 compositor: one pass per layer, premultiplied source-over (`ONE, ONE_MINUS_SRC_ALPHA`)
// on a black base, on gamma-encoded values with bilinear sampling and no mipmaps, exactly the
// per-layer order of Editroom's TimelineCompositor (docs/spec/02-engine.md §1.2):
// fit → wipe crop → clip transform → grade cube → opacity → over.
// The viewer and export use this same code, so what you see is what you export.

export type Rotation = 0 | 90 | 180 | 270;

/** A layer ready to draw: its picture and where it sits on the canvas (pre-transform, y down). */
export interface DrawLayer {
  picture:
    | { kind: "texture"; source: TexImageSource; key?: object | string; width: number; height: number; rotation: Rotation; rect: Rect }
    | { kind: "solid"; color: [number, number, number, number] };
  opacity: number;
  wipe?: number;
  transform?: { scale: number; x: number; y: number };
  cube?: Float32Array;
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

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

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

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;
function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
}

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

  constructor(readonly gl: WebGL2RenderingContext) {
    this.floatTarget = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
    this.layerProg = compile(gl, VERT, LAYER_FRAG);
    this.blitProg = compile(gl, VERT, BLIT_FRAG);
    this.lu = uniforms(gl, this.layerProg, ["uCanvas", "uOffset", "uOutH", "uShift", "uScale", "uRect", "uRot", "uWipe", "uKind", "uColor", "uTex", "uLut", "uHasLut", "uOpacity"]);
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
  private upload(slot: number, source: TexImageSource, key?: object | string): WebGLTexture {
    const gl = this.gl;
    if (key !== undefined) {
      const hit = this.cached.get(key);
      if (hit) { hit.used = this.frameNo; return hit.tex; }
    }
    const tex = key !== undefined ? this.texture() : (this.scratch[slot] ??= this.texture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (key !== undefined) this.cached.set(key, { tex, used: this.frameNo });
    return tex;
  }

  /** Draws the layers (bottom first) over black into the internal target at the output size. */
  render(layers: DrawLayer[], f: Frame) {
    const gl = this.gl;
    this.frameNo++;
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
      } else {
        const p = l.picture;
        gl.uniform1i(u.uKind, 0);
        gl.activeTexture(gl.TEXTURE0);
        const tex = this.upload(slot, p.source, p.key);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform4f(u.uRect, p.rect.x, p.rect.y, p.rect.width, p.rect.height);
        gl.uniform1i(u.uRot, p.rotation / 90);
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
  }
}
