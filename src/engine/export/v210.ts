// Packs the compositor's last render as 10-bit 4:2:2 Y′CbCr in v210 layout, for the ProRes export
// (src-tauri/src/render/prores.rs). Our own conversion, as for H.264/HEVC (spec §16): BT.709 matrix,
// limited range (Y 64…940, C 64…960 of 1023), chroma co-sited with the even pixels (the 4:2:2 siting
// ProRes and SDI use) through a [1 2 1]/4 filter. The compositor's half-float target keeps more
// than 8 bits, so the 10 bits are real precision, not padding.
//
// v210: each row is groups of 6 pixels in four little-endian 32-bit words, three 10-bit samples a
// word (bits 0, 10, 20):  Cb0 Y0 Cr0 | Y1 Cb2 Y2 | Cr2 Y3 Cb4 | Y4 Cr4 Y5,
// rows padded to a multiple of 48 pixels (128 bytes). One RGBA8 texel of the target is one word.

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex;   // the composited frame; row 0 is the bottom
uniform ivec2 uSize;      // frame size in pixels
out vec4 fragColor;

// Pixel (x, row from the top), clamped to the frame (the row's padding repeats its last pixel).
vec3 rgb(int x, int row) {
  ivec2 p = ivec2(clamp(x, 0, uSize.x - 1), uSize.y - 1 - row);
  return clamp(texelFetch(uTex, p, 0).rgb, 0.0, 1.0);
}
float luma(vec3 c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
uint q(float v) { return uint(clamp(floor(v + 0.5), 4.0, 1019.0)); }
uint Y(int x, int row) { return q(64.0 + 876.0 * luma(rgb(x, row))); }
// Cb (cr = false) or Cr of the co-sited even pixel x.
uint C(int x, int row, bool cr) {
  vec3 c = 0.25 * rgb(x - 1, row) + 0.5 * rgb(x, row) + 0.25 * rgb(x + 1, row);
  float y = luma(c);
  return q(cr ? 512.0 + 896.0 * (c.r - y) / 1.5748 : 512.0 + 896.0 * (c.b - y) / 1.8556);
}
void main() {
  // Target row r is read back r-th, so it holds the frame's row r from the top.
  ivec2 o = ivec2(gl_FragCoord.xy);
  int row = o.y, k = o.x % 4, b = (o.x / 4) * 6;
  uint s0, s1, s2;
  if (k == 0)      { s0 = C(b, row, false);     s1 = Y(b, row);             s2 = C(b, row, true); }
  else if (k == 1) { s0 = Y(b + 1, row);        s1 = C(b + 2, row, false);  s2 = Y(b + 2, row); }
  else if (k == 2) { s0 = C(b + 2, row, true);  s1 = Y(b + 3, row);         s2 = C(b + 4, row, false); }
  else             { s0 = Y(b + 4, row);        s1 = C(b + 4, row, true);   s2 = Y(b + 5, row); }
  uint w = s0 | (s1 << 10u) | (s2 << 20u);
  fragColor = vec4(float(w & 255u), float((w >> 8u) & 255u), float((w >> 16u) & 255u), float(w >> 24u)) / 255.0;
}`;

/** Bytes of a v210 frame (as `prores::v210_frame_bytes` in Rust). */
export const v210FrameBytes = (w: number, h: number) => Math.ceil(w / 48) * 128 * h;

export class V210Packer {
  private prog: WebGLProgram;
  private uTex: WebGLUniformLocation | null;
  private uSize: WebGLUniformLocation | null;
  private quad: WebGLVertexArrayObject;
  private buf: WebGLBuffer;
  private target?: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };

  constructor(private gl: WebGL2RenderingContext) {
    const make = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    this.uTex = gl.getUniformLocation(p, "uTex");
    this.uSize = gl.getUniformLocation(p, "uSize");
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private targetFor(w: number, h: number) {
    const gl = this.gl;
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    this.disposeTarget();
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.target = { fb, tex, w, h };
    return this.target;
  }

  /** Packs `source` (width × height, bottom row first) into `out` (v210FrameBytes long). */
  pack(source: WebGLTexture, width: number, height: number, out: Uint8Array) {
    const gl = this.gl;
    const words = Math.ceil(width / 48) * 32;
    if (out.length !== words * 4 * height) throw new Error("Wrong v210 buffer size.");
    const t = this.targetFor(words, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, words, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(this.uTex, 0);
    gl.uniform2i(this.uSize, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, words, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindVertexArray(null);
  }

  private disposeTarget() {
    if (!this.target) return;
    this.gl.deleteFramebuffer(this.target.fb);
    this.gl.deleteTexture(this.target.tex);
    this.target = undefined;
  }

  dispose() {
    this.disposeTarget();
    this.gl.deleteProgram(this.prog);
    this.gl.deleteVertexArray(this.quad);
    this.gl.deleteBuffer(this.buf);
  }
}
