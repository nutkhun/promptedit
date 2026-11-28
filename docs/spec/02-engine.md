# 02 — Engine spec (Editroom → PromptEdit port)

Source of truth: `Editroom/Engine/*.swift`, `Editroom/Model/{ColorGrade,SpeedRamp,ZoomMove,Captions}.swift`,
`Vendor/ffmpeg/README.md`, `scripts/build-ffmpeg.sh` (plus the few model types they depend on in
`Model/Project.swift`, and the beat tracker in `Magic/MediaAnalyzer.swift`, quoted where needed).
Paths below are relative to `/home/user/robbietilton/editroom`.

Conventions in this document

- "Timeline time" `t` = seconds on the sequence. "Source time" `s` = seconds into the media file.
- `W`, `H` = the size the picture is being laid out at (the *canvas*, see §2). Core Image has y pointing
  **up**; the model's `y` values point **down**. Formulas below are written in Core Image coordinates
  where they come from Core Image, and that is called out.
- `clamp01(x) = min(1, max(0, x))`, `smoothstep(u) = u*u*(3-2u)` (no clamping unless stated).
- "Rec.709 luma" = `0.2126 R + 0.7152 G + 0.0722 B`, always on **gamma-encoded** values.
- **UNSURE** marks anything not provable from the source alone. Verify it on a Mac with the original app
  (the original has a test harness: `Editroom --format-check <outDir> <files…>` in `App/FormatCheck.swift`
  compares 6 colour patches against sRGB targets `(118,118,118) (235,235,235) (200,40,40) (40,170,60)
  (40,60,200) (224,172,105)` for `sdr_`, `hlg_`, `pq_`, `applelog_` test clips — reuse those clips as port
  golden tests).

---

## 0. Global facts that every subsystem depends on

| Fact | Value | Where |
|---|---|---|
| Composition timescale | 60000 per second; `time(s) = round(s*60000)/60000` | `CompositionBuilder.timescale` |
| Frame duration | integer fps → `1/fps`; otherwise NTSC: `1001 / (round(fps*1.001)*1000)` (23.976→1001/24000, 29.97→1001/30000, 59.94→1001/60000, 119.88→1001/120000) | `CompositionBuilder.frameDuration` |
| Sequence frame rates offered | 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120 (import snaps to nearest) | `EditorModel.frameRates` |
| Default sequence | 1920×1080, 30 fps, 2 video + 2 audio tracks | `Project` |
| Sampling epsilon | the compositor evaluates at `t = frameTime + 1e-4` and media clocks at `t - 1e-4` | `TimelineCompositor` |
| Colour pipeline | **No colour management anywhere.** Core Image context has `workingColorSpace = outputColorSpace = NSNull`; all maths (fit, blend, grade, opacity) runs on **gamma-encoded Rec.709 values in 0…1**. Output buffers are tagged BT.709 primaries / BT.709 transfer / BT.709 matrix. | `TimelineCompositor.context` |
| Preview render size | sequence size scaled so the long side ≤ 1920, rounded to even: `s=min(1,1920/max(w,h)); W=max(2,round(w*s/2)*2)` | `CompositionBuilder.previewSize` |
| Image sampling | `CIImage.transformed(by:)` default = bilinear, no mipmaps / no high-quality downsample | Core Image default |
| dB → linear | `dbToLinear(db) = db <= -59.5 ? 0 : 10^(db/20)` (anything at or below −59.5 dB is *silence*) | `Project.swift` |

Port rule of thumb: the WebGL2 compositor must work on **non-linear** values, use `LINEAR` filtering
without mipmaps for scaling, premultiplied source-over blending, and RGBA8 (or RGBA16F) render targets
that are finally read as 8-bit BGRA/RGBA. Do not let the browser colour-manage anything (see §15.3).

---

## 1. Compositing, track layering and blend order

### 1.1 Layer list (`CompositionBuilder.build`, `TimelineCompositor.compose`)

- Base: an opaque black frame `CIImage(color: .black)` cropped to the canvas. (The original also inserts a
  tiny black `Base.mp4` video track under everything only so AVFoundation has a video track to drive
  rendering — not needed in the port.)
- Video tracks are walked in `project.videoTracks` order; **index 0 is V1, the bottom-most**. Within a
  track, clips are sorted by `start` ascending and appended in that order, so a **later clip on the same
  track is drawn above an earlier one** (this is what makes dissolves/wipes draw incoming over outgoing).
- Hidden tracks (`track.hidden`) add no layers (in the player they stay in the composition, but their
  layers are removed).
- Audio clips on video tracks are ignored (`case .audio: continue`).
- A layer is drawn at time `t` iff `layer.start <= t < layer.end`, where
  `layer.start = clip.start - plan.leadIn`, `layer.end = clip.end + plan.tailOut` (transition extensions, §4).
- A layer is skipped when `opacity(t) <= 0.001`.

### 1.2 Per-layer pipeline (exact order)

For video layers (`.track`, `.reversed`, `.decoded`):

1. Get the source frame (as decoded: Y′CbCr → R′G′B′ converted by Core Image using the buffer's YCbCr
   matrix attachment, *no transfer conversion*).
2. Orient: apply `CGImagePropertyOrientation` from the track's preferred transform (§15.2).
3. **Aspect-fit** into the canvas: `s = min(W/w, H/h)`; translate so it is centred:
   `tx = (W - w*s)/2 - minX*s`, `ty = (H - h*s)/2 - minY*s`. Areas outside the fitted picture are
   **transparent** (lower tracks show through letterbox/pillarbox bars; only the bottom shows black).
   - Export only (`upscale: true`): if `s > 1.01` and the upscaler is available, the frame is enlarged to
     `(w*s, h*s)` by the upscaler (§12) and then centred the same way.
4. Source colour conversion to Rec.709 (`SourceColor.toRec709`, only Apple Log / Log 2 have a cube; §3.6).
   Done *after* scaling, at output resolution.
5. Wipe crop (if this layer is being revealed by a wipe; §4.3) — in canvas coordinates, **before** the
   clip transform, so the wipe edge moves/scales with the transform.
6. Clip transform (scale about canvas centre, then offset; §2.1).
7. Grade cube (`CIColorCube`, 32³; §3).
8. Opacity: if `opacity < 0.999`, multiply alpha by `opacity` (`CIColorMatrix` with `AVector = (0,0,0,opacity)`).
9. `out = image.composited(over: out)` — premultiplied source-over: `out = src + dst*(1-src.a)`.

For `.image` (stills), `.color` (solids) and text layers, steps 1–4 are replaced by the pre-placed image
(§9), then 5–9 are identical (grade cubes *are* applied to solids and text if the clip has a grade).

After all layers:

10. If exporting to a different shape: `out` is translated by `-offset` and cropped to the output size
    (§2.2).
11. Captions are composited over, in output coordinates (§9.3).
12. Rendered to a 32-bit BGRA buffer (8 bits per channel), tagged BT.709/709/709.

Port: one WebGL2 pass per layer into a ping-pong RGBA framebuffer (or RGBA16F to reduce rounding), with
`gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` on premultiplied colour. The same code path serves preview and
export (as in the original, where the scrub/preview path calls the same `compose` function).

Parity risks
- Core Image may tile/convert internally at float precision; 8-bit intermediate targets in WebGL will
  band more on gradients. Prefer RGBA16F intermediates and a single 8-bit readback.
- **UNSURE**: whether Core Image's `CIColorCube` and `CIColorMatrix` operate on un-premultiplied colour
  (Core Image's default for colour kernels is to un-premultiply, process, re-premultiply). Implement both
  as: `rgb = a>0 ? rgbPremul/a : 0; rgb = f(rgb); out = vec4(rgb*a', a')` so transparent pixels stay
  transparent (otherwise a lifted-black look would tint the letterbox bars).

---

## 2. Clip transforms, zoom moves, export reframing

### 2.1 Clip transform (`ClipTransform`, `ZoomMove`, compositor)

Model: `scale` (1 = fitted; UI range 0.05…10), `x`, `y` = offset of the clip's centre from the frame centre
as a fraction of frame width/height, **positive y = down**; optional `zoom: ZoomMove`.
Only video, image and solid clips are transformable; text has its own placement.

Effective transform at clip-local time `u = t - clip.start` (may be negative during a transition lead-in):

```swift
// ClipTransform.at(u)
guard let zoom else { var t = self; (t.x, t.y) = zoomedOffset; return t.isIdentity ? nil : t }
let k = zoom.amount(at: u)
t.scale = 1 + (scale - 1) * k
t.x = zoomedOffset.x * k;  t.y = zoomedOffset.y * k
// zoomedOffset: if scale > 1.001, clamp x,y to ±(scale-1)/2, else unchanged
```

Matrix (Core Image, y up), applied to the fitted layer image:

```
M = translate(-W/2, -H/2) · scale(tf.scale) · translate(W/2 + tf.x*W, H/2 - tf.y*H)
```

i.e. scale about canvas centre, then move right by `x*W` and **down** by `y*H`. Pixels outside the
transformed picture are transparent. With `scale < 1` offsets are not clamped.

Zoom move (`ZoomMove`): modes `in` / `inOut` / `out`, points `p1…p4` in seconds from clip start, `smooth`
default true.

```
ramp(u,a,b) = (b-a <= 1e-6) ? (u >= a ? 1 : 0) : (k = clamp01((u-a)/(b-a)); smooth ? smoothstep(k) : k)
amount: in    → ramp(u,p1,p2)
        out   → 1 - ramp(u,p3,p4)
        inOut → u < p3 ? ramp(u,p1,p2) : 1 - ramp(u,p3,p4)
starter(mode, L): m = min(max(L*0.25, 0.5), 2, L/2)
   in: (0, m, L, L)   out: (0, 0, L-m, L)   inOut: (0, m, L-m, L)
fit(L): p1=c(p1); p2=max(p1,c(p2)); p3=max(p2,c(p3)); p4=max(p3,c(p4)), c = clamp to [0,L]
trim head by d: all points -= d, then fit.
```

### 2.2 Export reframing to vertical / square / portrait (`ExportSettings`, `CompositionBuilder.build`)

Shapes and `tallness` (height/width): original = nil, vertical 9:16 = 16/9, square = 1, portrait 4:5 = 5/4.

Render size (`even(v) = max(2, round(v/2)*2)`):

```
if shape != original:  short = height ?? min(seqW, seqH);  size = (even(short), even(short*tallness))
else:                  h = height ?? seqH;  size = (even(h*seqW/seqH), even(h))
crops = |size.w/size.h - seqAspect| > 0.01
```

Resolution menu (`ExportSheet`): Source, 4K=2160, 1440p, 1080p, 720p. For a crop the number names the
**short side**; for an original-shape vertical sequence the label value is converted:
`h = round(item * seqH/seqW)`.

When `crops`, the sequence is laid out on a *canvas* that **covers** the output and the output is a window
into it, centred on `reframe` (0…1 across, 0…1 down; default 0.5, 0.5):

```swift
let pa = seqAspect, oa = out.w / out.h
canvas = pa > oa ? (round(out.h * pa), out.h) : (out.w, round(out.w / pa))
ox  = clamp(center.x * canvas.w - out.w/2, 0, canvas.w - out.w)
top = clamp(center.y * canvas.h - out.h/2, 0, canvas.h - out.h)
offset = (ox, canvas.h - out.h - top)      // Core Image y-up
```

All layers (fit, transforms, text, solids) are laid out at `canvas` size; the final image is translated
by `-offset` and cropped. Text is therefore cropped with the picture; **captions are not** — they are
drawn afterwards in the output frame (§9.3). The reframe point is static for the whole export (no
per-shot reframing).

Port: identical maths in TS; in WebGL render the layer stack at canvas size into an FBO and blit the
window, or fold `-offset` into the projection matrix (cheaper; identical result as long as the canvas is
not clipped first).

---

## 3. Colour grading

### 3.1 Data model (`ColorGrade`)

| Field | Range | Default |
|---|---|---|
| `look` | built-in name, or absolute path of a `.cube` file, or nil | nil |
| `lookIntensity` | 0…1 (clamped at bake) | 1 |
| `exposure` | −2…2 stops | 0 |
| `contrast` | −50…50 | 0 |
| `saturation` | −100…100 | 0 |
| `temperature` | −50…50 (negative cooler) | 0 |
| `tint` | −50…50 (positive magenta) | 0 |
| `shadows`/`midtones`/`highlights` | wheel points `(x, y)` in the unit disc, x right, **y down** | (0,0) |

`isNeutral`: equal to the default after resetting `lookIntensity` when `look == nil`. Neutral → no cube at all.

### 3.2 Wheel offset

```swift
let m = min(1, sqrt(x*x + y*y)) * 0.22
let a = atan2(y, x)                       // y is the UI's y (down) — used as-is
offset = (cos(a)*m, cos(a - 2π/3)*m, cos(a + 2π/3)*m)   // red at 0°, green at 120°, blue at 240°
```

### 3.3 `GradeRecipe.apply` — the user grade and the simple looks (exact order)

```swift
if let custom { return custom(rgb) }
var (r,g,b) = rgb
let gain = pow(2, exposure);           r*=gain; g*=gain; b*=gain
let t = temperature/50*0.12, ti = tint/50*0.1
r += t; b -= t; g -= ti
let l = clamp01(0.2126*r + 0.7152*g + 0.0722*b)
let sh = 1 - l, mid = 4*l*(1 - l)          // highlights weight = l
r += shadows.0*sh + midtones.0*mid + highlights.0*l + lift.0   // same for g (.1) and b (.2)
let k = 1 + contrast/50*0.6;           r = (r-0.5)*k + 0.5   (g, b likewise)
if fade != 0 { r = r*(1-fade) + fade }  (g, b likewise)
let l2 = 0.2126*r + 0.7152*g + 0.0722*b      // NOT clamped
let s = 1 + saturation/100
return (l2 + (r-l2)*s, l2 + (g-l2)*s, l2 + (b-l2)*s)
```

No clamping between steps (only `l` for weights); the final bake clamps to 0…1.

### 3.4 Built-in looks (menu order) — exact parameters

| Name | Recipe |
|---|---|
| Warm film | `contrast 8, saturation −8, temperature 18, lift (0.02, 0, −0.02), fade 0.03` |
| Golden hour | custom `LookMath.goldenHour` |
| Film print | custom `LookMath.filmPrint` |
| Teal and orange | `contrast 12, saturation 10, shadows (−0.05, 0.01, 0.05), highlights (0.06, 0.01, −0.05)` |
| Pastel | custom `LookMath.pastel` |
| Bleach bypass | custom `LookMath.bleachBypass` |
| Mono | `contrast 14, saturation −100` |
| Cool night | `exposure −0.25, contrast 6, saturation −15, temperature −22` |
| *Faded* (retired, still read) | `contrast −18, saturation −20, fade 0.07` |

Note: in recipes the `shadows/midtones/highlights` are already RGB offsets (not wheel points).

`LookMath` helpers (all on encoded 0…1 values; `luma` = Rec.709):

```swift
contrast(c,k): each x: x=clamp01(x); s=smoothstep(x); clamp01(x + k*(s - x)*2)
fade(c,f):     each x: f + (1-f)*x                       // no clamp
saturate(c,s): l=luma(c); each x: clamp01(l + s*(x - l))
add(c,t,w=1):  each: clamp01(c_i + t_i*w)
split(c, sh, hi): l=clamp01(luma(c)); add(add(c, sh, (1-l)^2), hi, l^2)
toHSV / fromHSV: standard; h in degrees; uses truncatingRemainder (= C fmod, sign of dividend,
   same as JS %); red-max branch h = 60*fmod((g-b)/d, 6); h<0 → +360; s = mx>0 ? d/mx : 0; v = mx;
   d <= 1e-6 → h = 0
hueBand(c, center, width, shift, sat, value=1):
   (h,s,v)=toHSV(c); d=|h-center|; if d>180 d=360-d; if d >= width return c (unchanged)
   w = (0.5 + 0.5*cos(d/width*π)) * min(1, s*2.5)
   h = fmod(h + shift*w + 360, 360); s = clamp01(s*(1+(sat-1)*w)); v = clamp01(v*(1+(value-1)*w))
   return fromHSV(h,s,v)
```

```swift
goldenHour(c):   c = split(c, sh:(-0.012,0,0.03), hi:(0.085,0.04,-0.06)); c = contrast(c,0.08); saturate(c,1.08)
bleachBypass(c): c = saturate(each(c,clamp01),0.42); c = contrast(c,0.42); add(c,(-0.01,0,0.008))
pastel(c):       c = each(c){pow(clamp01(x),0.8)}; c = contrast(c,-0.36); c = fade(c,0.14)
                 c = split(c, sh:(0.03,0,0.05), hi:(0.01,0,0.012)); saturate(c,0.8)
filmPrint(c):    p = [0.1260, 0.0872, 0.1130, 0.9273, 4.3723, 1.1754, -6.7912, 0.8993, -3.0058, 1.0943,
                      -0.2338, -0.1982, -0.2908, -0.1016, -0.0275, -0.0710, 0.1846, 0.8248, 1.0324, 1.0304]
   c = add(each(c,clamp01), (p0,p1,p2))
   c = each(c){ pow(clamp01(x), p3) }
   c = hueBand(c, center:28,  width:22, shift:p4, sat:p5)     // skin
   c = hueBand(c, center:110, width:60, shift:p6, sat:p7)     // greens
   c = hueBand(c, center:210, width:45, shift:p8, sat:p9)     // blues
   c = split(c, sh:(p10,p11,p12), hi:(p13,p14,p15))
   c = contrast(c, p16); c = saturate(c, p17)
   c = hueBand(c, center:356, width:20, shift:0, sat:p18, value:p19)   // reds
   return fade(c, 0.035)
```

(`design/fit-look.swift` / `design/looks-mock.swift` are the tuning scripts, not runtime.)

### 3.5 Baking and applying (`GradeBaker`, `GradeCube`)

The whole grade becomes **one 32³ RGBA float cube**, used identically by viewer and export:

```swift
for b in 0..<32 { for g in 0..<32 { for r in 0..<32 {         // red fastest
  var c = (r/31, g/31, b/31)
  if mix > 0 && (lookRecipe != nil || lookFile != nil) {        // mix = clamp01(lookIntensity)
     let looked = lookRecipe?.apply(c) ?? lookFile!.sample(c)
     c = c + (looked - c) * mix                                 // linear blend toward the look
  }
  c = user.apply(c)                                              // user grade on top of the look
  store clamp01(c), alpha = 1
}}}
```

Built-in names take priority over file paths. Cache: by `ColorGrade` value, cleared when >200 entries.
Applied with `CIColorCube(inputCubeDimension: 32)` — trilinear interpolation, inputs clamped to 0…1.

Port: bake the same 32³ table (TS or Rust, f32) and upload as a WebGL2 `TEXTURE_3D` `RGBA16F`
(filterable without extensions; `RGBA32F` needs `OES_texture_float_linear`), `LINEAR`, `CLAMP_TO_EDGE`,
sampled at `coord = c*(31/32) + 0.5/32` so that 0 and 1 hit the first/last lattice centres (this matches
Core Image's cube addressing — **UNSURE** at the sub-texel level; verify with a ramp test).

### 3.6 LUT files (`CubeLUT`)

- Format: Adobe/Resolve `.cube`, **3D only**. Parsing: split into lines; trim spaces; skip empty and `#`
  lines; split each line on single **space** characters (tabs are *not* separators — a tab-separated
  file fails); `LUT_3D_SIZE n` sets size; any line with exactly three parseable floats is a data triple;
  everything else (TITLE, DOMAIN_MIN/MAX, LUT_1D_SIZE) is ignored. Valid iff `2 <= n <= 256` and
  `values == n³*3`. Red varies fastest. **Domain is assumed 0…1** (DOMAIN_* ignored). 1D LUTs fail.
- Sampling: trilinear, input clamped 0…1, `p = v*(n-1)`, `i = min(n-2, floor(p))`, `f = p - i`, index
  `((b*n + g)*n + r)*3 + c`.
- The LUT is sampled at the 32³ bake lattice, then the bake is trilinearly sampled again at render — a
  double interpolation. **Port must do the same** (do not upload the user's LUT directly) or large LUTs
  with sharp features will differ.
- Files are cached by path for the session; the look's label is the file's base name.

### 3.7 Source colour: HDR and Log to Rec.709 (`SourceColor`)

Detection from the video track's format description extensions:

| Kind | Rule |
|---|---|
| Apple Log | extension `"LogTransferFunction"` lowercased contains `apple-log` (value `com.apple.rec2020.apple-log`) |
| Apple Log 2 | …and contains `wide-gamut` or `apple-log2` (value `com.apple.apple-wide-gamut.apple-log`) |
| HLG | `TransferFunction == ITU_R_2100_HLG` |
| PQ | `TransferFunction == SMPTE_ST_2084_PQ` |
| standard | everything else |

**HLG / PQ (`convertedOnRead`)**: frames are read by `AVAssetReader` asking for 32BGRA output with BT.709
colour properties, so **AVFoundation's own HDR→SDR tone mapping** produces the pixels (including iPhone
Dolby Vision 8.4 metadata). No cube is applied afterwards. These clips are not inserted into the
composition; they're read by `ReverseFrames` (§7) as `.decoded` layers.

The source also contains (in `convert()`) a **fitted model of that macOS conversion** — currently unused at
runtime for HLG/PQ (the cube is nil for them) but documented as matching macOS within ~2%. The port should
use it, baked to a 64³ cube, as its HDR→SDR conversion:

```swift
// per lattice point (r,g,b) in 0…1, n = 64
lin = decode(r,g,b)                                   // see decode() below
c   = max(0, M · lin)                                 // M = Rec.2020→709 (or AWG→709 for Log 2)
if hdr {                                              // HLG or PQ
  Y = 0.2126 c.r + 0.7152 c.g + 0.0722 c.b
  if Y > 1e-6 {
    target = 0.317 * pow(Y, 0.88) + 0.0143 * min(1, Y/0.02)
    scale = target / Y;  c *= scale
    g = Y*scale;  c = g + (c - g)*0.88                // desaturate 12% toward grey
  }
}
k = hdr ? 0.85 : 0.9
peak = max(c)
if peak > k { eased = k + (1-k)*(1 - exp(-(peak-k)/(1-k))); c *= eased/peak }   // hue-preserving roll-off
out = rec709OETF(c)    // v=clamp01(x); v < 0.018 ? 4.5v : 1.099*v^0.45 - 0.099
```

`decode` (to linear, reference white = 1):

```swift
HLG:  a=0.17883277 b=0.28466892 c=0.55991073
      e = v <= 0.5 ? v*v/3 : (exp((v-c)/a) + b)/12;   return e / 0.2647     // no HLG OOTF applied
PQ:   m1=0.1593017578125 m2=78.84375 c1=0.8359375 c2=18.8515625 c3=18.6875
      p = max(0,v)^(1/m2); y = (max(0,p-c1)/(c2-c3*p))^(1/m1); return y*10000/203
Apple Log (and Log 2):  R0=-0.05641088 Rt=0.01 c=47.28711236 b=0.00964052 g=0.08550479 be=0.69336945
      Pt = c*(Rt-R0)^2  (≈0.208555)
      v >= Pt ? 2^((v-be)/g) - b  :  v > 0 ? sqrt(v/c) + R0  :  R0
```

Primary matrices (D65 → D65, no adaptation; computed from xy primaries; values to 6 dp):

```
Rec.2020→709:            [ 1.660491 -0.587641 -0.072850 ]
                         [-0.124550  1.132900 -0.008349 ]
                         [-0.018151 -0.100579  1.118730 ]
Apple Wide Gamut→709:    [ 1.707280 -0.519020 -0.188260 ]
(AWG xy: R .725,.301  G .221,.814  B .068,-.076)
                         [-0.125011  1.314662 -0.189652 ]
                         [-0.043624 -0.191214  1.234839 ]
```

**Apple Log / Log 2** (runtime): frames read at 10-bit 4:2:0 video range, converted Y′CbCr→R′G′B′ by Core
Image using the file's matrix (BT.2020 non-constant luminance for iPhone Log), then a 64³ cube built with
`convert()` (non-HDR branch: knee 0.9) is applied via `CIColorCube` **after** the aspect-fit (step 4 in §1.2).

Port:
- Probe: ffprobe `color_transfer` → `arib-std-b67` = HLG, `smpte2084` = PQ. **UNSURE**: how Apple Log is
  exposed by ffprobe. The `LogTransferFunction` is a QuickTime sample-description extension; ffprobe may
  report `color_transfer=unknown`. Plan: parse the `stsd` entry in Rust (`mp4`/`mp4-atom` crate) and look
  for the string `apple-log` in the video sample entry's extension atoms; confirm on real iPhone 15/16/17
  Pro files.
- Decode HDR/Log frames to **raw 10-bit planes** (WebCodecs `VideoFrame.copyTo` into P010/I420P10, or an
  ffmpeg pipe), do Y′CbCr→R′G′B′ (BT.2020 NCL, limited range) in our own shader, then sample the 64³ cube.
  Never let the browser draw an HDR `VideoFrame` to a canvas/texture directly: each engine tone-maps
  differently.
- Parity risk (high for HLG/PQ): Apple's real conversion is DV-metadata aware; the fitted curve is a ~2%
  approximation and ignores DV RPU. Low risk for Apple Log (exact maths in the source).

---

## 4. Transitions (`Project.transitionSpan/transitionPlan`, `RenderLayer`)

Kinds: `dissolve` (default), `dipToBlack`, `wipe`; `Transition.duration` default 0.5 s. A transition lives
on the incoming clip `b` (`b.transitionIn`) and applies to the clip `a` that ends where `b` starts on the
same track (`|a.end - b.start| <= 0.5/fps`), neither being audio.

### 4.1 Where it sits

```
frame = 1/fps
dipToBlack: d = min(dur, 2*a.duration, 2*b.duration); if d >= frame → [cut - d/2, cut + d/2]
dissolve/wipe: want = min(dur, a.duration, b.duration)
   head = headRoom(b)  // b.playsSource ? b.timelineSpan(0 → b.sourceStart) : ∞   (media before b's in point)
   tail = tailRoom(a)  // a.playsSource ? max(0, a.timelineSpan(a.sourceStart+a.sourceLength → sourceLimit)) : ∞
   head >= want → [cut - want, cut], fromHead            (b is extended earlier: leadIn = want)
   tail >= want → [cut, cut + want]                       (a is extended later:  tailOut = want)
   else d = max(head, tail); need d >= frame; head >= tail ? [cut-d, cut] fromHead : [cut, cut+d]
```

Plan per clip `c`:
- incoming side (`previous(touching: c)` exists): dip → `reveal = [c.start, span.end]`; otherwise
  `reveal = [span.start, span.end]` and `leadIn = c.start - span.start` if fromHead.
- outgoing side (`next(touching: c)` = b with a transition): dip → `conceal = [span.start, c.end]`;
  otherwise if not fromHead → `tailOut = span.end - c.end`. **Dissolve/wipe never conceal the outgoing clip.**

`progress(t) = clamp01((t - start)/max(1e-6, end - start))` — linear.

### 4.2 Opacity (`RenderLayer.opacity`)

```swift
var o = 1.0
let ft = min(max(t, fadeStart), fadeEnd)            // clip's own fades hold their end value in the extension
if fadeIn  > 0 { o = min(o, inCurve.apply((ft - fadeStart)/fadeIn)) }
if fadeOut > 0 { o = min(o, outCurve.apply((fadeEnd - ft)/fadeOut)) }
if let r = reveal, r.kind != .wipe { o *= r.progress(t) }
if let c = conceal { o *= 1 - c.progress(t) }
return clamp01(o)
```

- **Dissolve**: incoming (drawn above) ramps 0→1 linearly over the span; outgoing stays at 100%
  underneath. It is *not* a symmetric cross-fade — semi-transparent or letterboxed layers show both.
- **Dip to black**: outgoing 1→0 linearly over `[cut-d/2, cut]`, incoming 0→1 over `[cut, cut+d/2]`.
  "Black" is whatever is underneath (lower tracks, else the black base).
- Edge case to preserve: an incoming clip with its own fade-in shown in a lead-in evaluates its fade at
  `fadeStart` → 0, so it stays invisible during the lead-in.

### 4.3 Wipe (`RenderLayer.wipe`)

Only for `reveal.kind == .wipe` and `t < reveal.end`:

```
p = progress(t); w = smoothstep(p)          // eased
image = image.cropped(to: x ∈ [0, W*w], full height)    // canvas coords, before the clip transform
```

Left-to-right hard-edged reveal of the incoming clip over the outgoing one at full opacity (no feather, no
opacity change). Port: discard fragments with `gl_FragCoord.x` (in canvas space, pre-transform → compute
in the layer's pre-transform UV) `>= W*w`.

---

## 5. Fades and fade curves

`FadeCurve.apply(x)`, `x` = clamp01(progress), 0 = silent/transparent:

| Case | UI label | f(x) |
|---|---|---|
| `linear` (default) | Linear | `x` |
| `easeIn` | Exponential | `x³` |
| `easeOut` | Logarithmic | `1 - (1-x)³` |
| `smooth` | S-Curve | `x²(3-2x)` |

Clip fades `fadeIn`/`fadeOut` (seconds), `clampFades`: `fadeIn = clamp(fadeIn, 0, duration)`,
`fadeOut = clamp(fadeOut, 0, duration - fadeIn)`. Level at timeline `t` (audio and meters):
`fadeGain(t) = clamp01(min(inCurve((t-start)/fadeIn), outCurve((end-t)/fadeOut)))` (each term only if >0).
Video uses the same curves via opacity (§4.2), evaluated exactly per frame.

Audio (§10): AVFoundation volume ramps are linear, so curves are approximated with **16 linear segments**
(1 segment for linear); fade-in from `start` over `min(fadeIn, len)`, fade-out ending at `end` over
`min(fadeOut, len - fi)`. Port: evaluate `fadeGain` per sample (exact) — difference vs 16 segments is
<0.5 dB anywhere; or replicate 16 segments for bit-parity of exports.

---

## 6. Speed, speed ramps (time remap), freeze frame

### 6.1 Constant speed (`SourceClock`, `Clip.sourceTime`)

`s(t) = sourceStart + (t - start) * speed`; `sourceLength = duration * speed`; `timelineSpan(s0,s1) = (s1-s0)/speed`.
Video: the frame shown is the one *presented at* `s(t)` (AVFoundation `scaleTimeRange`; no frame blending,
no optical flow). Port: pick the last decoded frame with `pts <= s(t - 1e-4) + ε`.

### 6.2 Ramps (`SpeedRamp`) — exact

Fields (all in **source seconds**): `inFrom, inTo, outFrom, outTo, startSpeed, endSpeed`; `mid` = clip.speed.

```swift
speed(s): s < inTo  → s <= inFrom ? startSpeed : blend(startSpeed, mid, (s-inFrom)/(inTo-inFrom))
          s > outFrom → s >= outTo ? endSpeed  : blend(mid, endSpeed, (s-outFrom)/(outTo-outFrom))
          else mid
blend(a,b,u) = exp(log a + (log b - log a) * smoothstep(u))        // eased in log-speed
```

Timeline time to play `s0→s1` (`span`): split at the marks `[inFrom, inTo, outFrom, outTo]`; each piece is
`(b-a)/v` if speed is constant (|va-vb|,|va-vm| < 1e-12) else **Simpson's rule with n = 24** on `1/speed`.
Negative if `s1 < s0`.

Inverse (`source(from:s0, after:dt)`): walk the marks in the playing direction subtracting each piece's
span; inside the piece that contains the remainder, **bisection, 40 iterations** on the fraction `m`
(`span(a, a+(b-a)m) < time → lo = m`); past all marks, constant speed `a ± left*v` with `v = speed(a ± 1e-9)`.
`SourceClock.source(t) = ramp.source(from: sourceStart, after: t - start, mid: speed)`.

Builder from the inspector graph (`SpeedRamp.drawn`): `L = s1-s0`; `hasIn = p2-p1 > 0.001`,
`hasOut = p4-p3 > 0.001`; nil if neither; `at(f) = s0 + L*clamp01(f)`;
`inFrom/inTo = hasIn ? at(p1)/at(p2) : s0`; `outFrom/outTo = hasOut ? max(inTo, at(p3))/max(inTo, at(p4)) : s1`;
`startSpeed = hasIn ? start : mid`, `endSpeed = hasOut ? end : mid`.
`shifted(d)`: marks +d. `mirrored(L)`: `(L-outTo, L-outFrom, L-inTo, L-inFrom)`, start/end speeds swapped.
`retime`: keeps source span, `duration = max(snap(timelineSpan(s0, s0+length)), minimum)`, then `clampFades`.

How the original *renders* ramps (`insertRamped`): footage cut at the marks plus, for each ramp section,
`steps = clamp(ceil(timelineSpan(a,b)*30), 4, 90)` equal source slices; each slice inserted and scaled to
its exact timeline length. So video/audio speed is **piecewise constant at ~30 pieces per timeline second**
inside ramps.
Port: video — evaluate `SourceClock.source(t)` exactly per output frame (difference ≤ a fraction of a
frame). Audio — replicate the same piecewise slicing and time-stretch each slice (§10.4).

### 6.3 Freeze frame

`Freeze Frame` command: splits the selected video clip (and linked clips) at the playhead (frame-snapped),
inserts a **2 s** video-only clip with `freeze = true`, `sourceStart = sourceTime(at: t)` (reversed clips:
`max(0, length - source - 0.001)`), same grade and transform; everything after it on those tracks moves
2 s later (linked audio gets a 2 s silence). Rendering: one 1/60 s source slice at `sourceStart`,
clamped to `[range.start, range.end - 1/60]`, stretched over the whole clip → the frame presented at
`sourceStart`. HDR/Log: `SourceClock.speed = 0` → `frame(at: sourceStart)`. Freeze clips have
`playsSource = false` → infinite head/tail room for transitions.

---

## 7. Reverse (`Reverser`, `ReverseFrames`, `ReverseAudio`)

Model: `clip.reversed = true`. Source time `s` means file time `length - s`, `length = asset.duration`
(probed). Trims/splits/speed/ramps work as on any clip (ramps use `mirrored`).

Picture (`.reversed` layer): at timeline `t`, file time `ft = length - clock.source(t - 1e-4)`, frame =
**last frame with `pts < ft - 1e-6`** (the frame that *ends* at `ft`); falls back to the previous chunk's
last frame, or the first frame at k=0. Decoding: chunks of
`len = limit > 2000 ? clamp(8/fps, 0.1, 0.25) : clamp(16/fps, 0.15, 0.5)` seconds (fps = track nominal
rate, 30 if unknown), chunk `k = floor((ft - 1e-6)/len)`; keeps the **3** most-recently-used chunks;
prefetches chunk `k-1` (backwards) or `k+1` (forwards, for HDR/Log `.decoded`); waits up to 3 s for a
chunk; frames scaled down (`VTPixelTransferSession`) so the long side ≤ `limit = max(canvasW, canvasH)`
when the source is > 1.02×limit, dimensions rounded to even. 8-bit 4:2:0 for SDR, 10-bit for HDR/Log.
Idle instances (>2 s untouched) drop their frames when another starts decoding.

Sound: the file's whole first audio track reversed once into a cached WAV:
16-bit stereo PCM, at the file's sample rate (if ≥ 8000, else 48000), header 44-byte canonical
(`fmt ` PCM, 2 ch, block align 4), decoded to a scratch file then written back-to-front in 256 K-frame
blocks. Cache: `AppSupport/Editroom/Reversed/<cacheName>.wav` (§15.4). In the composition the reversed
track replaces the source and `sourceStart` (and ramp) are shifted by `reversedDuration - length` to align
with the mirrored timebase. Export waits for all needed reversed audio first.

Port: Rust: `ffmpeg -i in -map 0:a:0 -ac 2 -ar <native> -f s16le pipe:` → scratch file → reverse frames
→ WAV (streaming; avoid `-af areverse`, which buffers the whole stream in RAM). Picture: decode GOP-sized
windows with WebCodecs (or ffmpeg) into a small ring of frames, same chunk sizes/eviction.
Parity: exact for audio; picture identical if frame selection rule is kept.

---

## 8. Video sources, playback and scrubbing frames

### 8.1 What feeds a video layer

- SDR files: composition tracks (AVFoundation decode, frame "presented at" mapped time).
- HDR/Log files: `ReverseFrames.frame(at:)` = last frame with `pts <= ft + 1e-6`.
- Reversed files: §7.
- Stills: §9.1. Solids/text: §9.

### 8.2 Playback engine (`PlaybackEngine`, `AudioStream`) — behaviour to replicate

- **Audio is the master clock**; the picture player is slaved to it (`sourceClock = synchronizer clock`).
- Start: picture and sound start together at `host = now + 0.06 s + outputLatency`.
- Output latency = (device latency + safety offset + buffer frame size + stream latency) / nominal rate,
  capped at 1 s; re-read when the default output device changes.
- Audio queued `0.2 s` ahead (+ latency), pumped every 10 ms; a new reader starts `0.25 s` early and
  discards that settling audio; reader starts are aligned to 0.1 s boundaries.
- Drift check every 0.5 s: if |heard − seen| > 0.04 s the picture is re-timed to the sound.
- Mute/solo while playing = per-track renderer volume 0/1, effective immediately (no rebuild).
- Seeks coalesce (latest wins); scrubbing uses tolerance 0.75 s (nearest decodable frame), then an exact
  seek when the scrub rests. Clamp: `max(0, min(t, duration - 0.5/fps))`.
- Looping (in/out) is gapless (pre-rolled spare player; audio offset grows by loop length each lap).
- Structural edits while playing hand off to a pre-rolled player at a point just ahead
  (`lead = max(0.035, prevPrep*1.5 + 0.02)` s, doubled up to 3 tries).
Port: Web Audio `AudioContext` as master (`currentTime` + `outputLatency`), video frame = `f(audioTime)`
each `requestAnimationFrame`; per-track `GainNode` for mute/solo; AudioWorklet ring buffers fed from Rust.

### 8.3 Scrub frames (`ScrubCache`) and hover strips (`ScrubStrips`)

`ScrubCache` (SDR files only): **12 frames/s**, long side ≤ **1920**, raw file orientation and raw 709
values (unmanaged), HEIC quality **0.86**; file `AppSupport/Editroom/Scrub/<cacheName>.scrub709`:
`u64 count, u64 end[count]` (cumulative byte ends relative to the frame area), then frames. Count =
`ceil(duration*12) + 1`; a decoded frame at pts `t` fills every slot `i` with `i/12 <= t + 0.5/12`; the
last frame pads to the end. Read with `i = round(time*12)` clamped. Folder kept < 6 GB (LRU by access
date). While scrubbing the viewer is composited from these frames via the same `compose()`; for reversed
layers time = `length - s`.
`ScrubStrips` (library hover): `n = min(120, max(24, Int(duration*4)))` frames at
`t_i = min(max(0, duration - 0.05), i/(n-1)*duration)`, ≤480×480, grab tolerance 1/15 s, JPEG q 0.78,
failed frame repeats previous; stored as a binary plist array of JPEG `Data` in `Scrub/<cacheName>.strip`;
frame for hover fraction `f`: `round(f*(n-1))`.

Port: Rust + ffmpeg (`-vf fps=12,scale=...` → JPEG/WebP; HEIC is not available in an LGPL-clean,
browser-decodable form). Keep the same container layout (count + ends + blobs). Low parity risk (transient).

### 8.4 Thumbnails & posters (`MediaStore`)

| Use | Max size | Time tolerance | Cache |
|---|---|---|---|
| Timeline filmstrip | 320×120 | ±0.25 s | memory, key `(asset, round(t*1000) ms)`, cleared at >1500 |
| Library poster | 480×480 | exact | at `t = min(1, duration*0.1)`; retries 5× after `0.5*2^attempt` s |
| Library hover scrub | 400×240 | ±0.1 s | memory, cleared at >600 |
| Viewer (library item) | 1920×1920 | ±1/30 s | none |
| Stills | ImageIO thumbnail, max 3840 px, EXIF orientation applied | — | memory |

HDR/Log thumbnails go through the same conversion as playback (`ColorFrameGrabber`: reads 1/2 s from
`min(t, end - 1/60)`, first sample, scale ≤ max size, cube, RGBA8 tagged Rec.709).

---

## 9. Stills, solids, text and captions

### 9.1 Stills and solids

- Still: aspect-fit into the canvas and centred (`s = min(W/w, H/h)`), no upscaler; pixels taken raw
  (no colour management — a Display-P3 photo's values are used as if Rec.709; **UNSURE**: verify Core
  Image does not convert CGImage colour space with a null working space). Port: decode with
  `createImageBitmap(blob, {colorSpaceConversion: 'none', imageOrientation: 'from-image'})`; HEIC/HEIF
  stills need decoding in Rust (ffmpeg ≥7 HEIF demux + hevc, or libheif LGPL).
- Solid: `CIImage(color: rgba)` filling the canvas (default colour `RGBA(0.16, 0.16, 0.2, 1)`), then
  transform/grade/opacity as any layer.

### 9.2 Text clips (`TextRenderer`)

`TextStyle`: `string` (default "Text"), `fontName` ("" = system font), `bold` (default **true**),
`size` (default **110**, points relative to a 1080-px-tall frame), `color` (default white), `x` 0.5, `y` 0.5
(centre, as fractions across/down).

```
pt   = size * canvasH / 1080
font = fontName.isEmpty ? system(pt, bold ? .bold : .regular)
                        : NSFontManager family(fontName, traits: bold ? bold : [], weight: 5) ?? NSFont(name:) ?? system
paragraph: centred alignment, default word wrapping, wrap width = 0.94 * canvasW
bounds = boundingRect(usesLineFragmentOrigin, usesFontLeading); tw = ceil(w), th = ceil(h)
pad  = ceil(pt * 0.25); bitmap = (tw + 2pad) × (th + 2pad), sRGB 8-bit premultiplied, drawn at (pad,pad)
placement (Core Image): x0 = round(x*W - bw/2), y0 = round((1-y)*H - bh/2)      // centre at (x, y-down)
```

No outline, shadow or background on text clips. Colour used as raw sRGB-encoded values. Cached by
(style, W, H), cleared at >64.

### 9.3 Captions (`CaptionStyle`, `CaptionLayout`, `CaptionRenderer`)

Style (one per sequence): `size` **64** (pt relative to a 1080-px **shorter side**; range 28…140),
`y` **0.78** (caption middle, fraction down the frame), `highlight` true, `textColor` white,
`highlightColor` `RGBA(1, 0.84, 0.25, 1)`, `outline` true, `outlineColor` black. No x (always centred).

Layout of words into captions (`CaptionLayout`):
- Captioned clips: audio clips with `captioned == true`, `playsSource`, not reversed. Default targets:
  sound of clips from video files, plus clips on any track something ducks under.
- Words: a transcript word belongs to the clip if its midpoint is in `[s0, s1)`; its times map to the
  timeline via `at(s) = clamp(clip.start + timelineSpan(s0 → s), clip.start, clip.end)`. Fixes
  (`captionFixes[asset]`, matched by `|fix.start - word.start| < 0.0005`): new text, `""` = removed,
  `merged` = extends the previous entry. A fix with several words splits the time by `(len+1)` weights.
- Runs break when `w.start - last.end >= 0.5` or the previous word ends in `.`, `?`, `!`.
- Each run is cut into `n = min(words, max(1, ceil(chars/26), ceil(seconds/2.6)))` phrases (chars include
  single spaces). For cut k the target is `total*k/n`; choose the cut after word i (leaving ≥1 word per
  remaining phrase, never inside a retyped word's parts) minimising `|ends[i] - target|`, minus **6** if
  the word ends with `,`.
- Caption end = `max(lastWord.end, min(nextCaption.start, clip.end, max(last.end + 0.25, first.start + 0.6)))`.
- Across clips: sorted by start; an overlapping caption is cut to `max(start + 0.05, next.start)`.

Rendering (`CaptionRenderer`):
- With `highlight` and >1 word, a caption becomes one layer per word: word i lit from
  `i == 0 ? block.start : word.start` to `next word's start` (last: `block.end`); otherwise one layer
  (`lit = 0` if highlight else none).
- Drawn in the **output** frame (after reframe crop):

```
pt   = size * min(outW, outH) / 1080
font = system font, weight .heavy                      // SF Pro Heavy (CSS 800)
words joined by " " spaces carrying kern = pt * 0.06 (extra tracking on the space glyph)
paragraph: centred, byWordWrapping, wrap width = 0.86 * outW
outline pass (if outline): same string, fill = stroke = outlineColor, strokeWidth = +22
   (AppKit: percent of font size, positive = stroke only → line width 0.22*pt centred on the glyph
   outline, i.e. 0.11*pt outside), line join ROUND
fill pass on top: textColor, lit word in highlightColor
pad = ceil(pt*0.3); bitmap (ceil(w)+2pad) × (ceil(h)+2pad), sRGB 8-bit premultiplied
placement: x0 = round((outW - bw)/2); y0 = round(clamp((1-y)*outH - bh/2, 0, outH - bh))  (CI, y up)
```

No drop shadow. Cache by (words, lit, style-without-y, outW, outH), cleared at >400.

Port: render to an `OffscreenCanvas` 2D context in the webview (preview and export share it): measure
and wrap with the same rules, `ctx.lineJoin='round'; ctx.lineWidth=0.22*pt; strokeText` then `fillText`,
`letterSpacing` only on spaces (draw word by word with manual advance `spaceAdvance + 0.06*pt`). Line
height must equal AppKit's "font leading" line height (ascender + descender + lineGap of the font).
Parity risks: **SF Pro is not redistributable**; on Windows/Linux substitute a bundled font (Inter
Bold/ExtraBold are the closest metric/visual match, OFL) — wraps and widths will differ slightly from the
Mac. For user `fontName`s, map families via the system font list (`font-kit` crate) and fall back to the
bundled font. Canvas stroke is centred like CoreText's, so the outline weight matches.

---

## 10. Audio mixing

### 10.1 Model

Track: `gainDB` (UI −60…+12, default 0), `muted`, `solo`, `duckUnder: trackID?`, `duckDB` (−6/−12/−18/−24,
default −12). Clip: `gainDB` (UI −60…+12; Magic clamps −24…+12), fades + curves, speed, ramp, reversed.
**There is no pan control anywhere in the engine** — everything is stereo pass-through.
`isAudible(track) = !muted && (noTrackSoloed || track.solo)`.

### 10.2 Gain structure (per clip, per track — `CompositionBuilder.build`)

```
trackGain = audible ? dbToLinear(track.gainDB) : 0       // export: inaudible tracks are left out entirely
gain      = trackGain * dbToLinear(clip.gainDB)
level(t)  = gain * fadeGain(t) * duckGain(t)             // ducking only if duckUnder set and voice audible
```

Volume ramps: without ducking, `setVolume(gain)` at clip start + fade ramps (16 linear pieces for curved
fades, §5). With ducking: the whole clip is written as **linear pieces every 50 ms** of `level(t)`.
Tracks are summed by `AVAssetReaderAudioMixOutput` (float, no limiter, no master bus gain). Clips whose
speed range is outside `[1/32, 32]` are skipped (silent). Only the **first decodable audio track** of each
file is used. Mono files are upmixed to both channels; multichannel is downmixed by AVFoundation
(**UNSURE** coefficients; ffmpeg's default `-ac 2` downmix differs — test 5.1 files).

**UNSURE (important)**: whether `AVMutableAudioMixInputParameters` honours volumes > 1.0 (positive dB). If
AVFoundation clamps at 1.0, every positive track/clip gain and positive loudness-normalisation gain in
the original is silently capped at 0 dB. Verify on a Mac (export a −20 dBFS tone with +12 dB track gain)
and replicate whichever is true.

### 10.3 Ducking (`AudioLevels.activity`, `duckGain`)

Activity of the voice track from its clips' waveform peaks (§11), stepping `t` by 50 ms:
`peak = max(peaks[floor(src(t)*pps) … floor(src(t+0.05)*pps)])`;
`active = peak * dbToLinear(clip.gainDB) * fadeGain(t) > 0.03`. Spans are merged when the gap < 0.35 s.

```
duckGain(t): attack = 0.15, release = 0.5; g = 1
  for each span: if t < start-attack or t > end+release: skip
     f = t < start ? (start-t)/attack : t > end ? (t-end)/release : 0
     g = min(g, low + (1-low)*f)            // low = dbToLinear(duckDB); linear in amplitude
```

### 10.4 Speed and pitch

Speed changes keep pitch: `audioTimePitchAlgorithm = .spectral` (Apple's phase-vocoder; highest quality).
Port: time-stretch per clip (and per ramp slice, §6.2) in Rust before mixing. Candidates, all
MIT/BSD/LGPL-compatible: `signalsmith-stretch` (MIT, closest in quality), SoundTouch (LGPL, WSOLA),
ffmpeg `atempo` (chain for >2×/<0.5×). **Do not use Rubber Band** (GPL) in an MIT app. Parity risk:
medium — artefacts differ audibly at extreme speeds; identical at 1×.

### 10.5 Resampling

Playback lanes read each track at the rate most of its clips use (by length, 8 k…192 k, else 48 k) and let
the output resample; export, loudness and meters-from-mix use 48 kHz. Port: resample in Rust with
`rubato` (MIT) to 48 kHz; parity negligible.

### 10.6 Audio scrubbing (`AudioScrubber`)

The whole mix (same composition + mix as playback, i.e. gains/fades/mute/solo/ducking) is rendered in the
background to memory at **32 kHz, stereo, Int16** (only if the edit is < 45 min; re-rendered when an audio
fingerprint changes). Each `play(at: t)` jumps to `frame = Int(t*32000)` and plays a **0.08 s** snippet
(2560 frames); gain ramps in over the first **96** samples after each jump and out over the last **160**
samples. Port: AudioWorklet reading a `SharedArrayBuffer` (or transferred `Float32Array`) of the rendered
mix; identical constants.

---

## 11. Waveforms and meters

### 11.1 Waveform extraction (`WaveformReader.read`)

Decode the file's first audio track at its **native rate and channel count** to float32, then per bucket
of `framesPerBucket = sampleRate / 200` frames (**200 peaks/s**; fractional bucket sizes carried across
buffers: a bucket closes when `fill >= fpb - 1e-6`, then `fill -= fpb`; each step takes
`max(1, ceil(fpb - fill))` frames):

```
mag[i]  = max over channels |x[i][ch]|            (the frame's loudest channel)
peaks   = max(mag)                                 // drawn
rms     = sqrt(sum(mag²) / fill)                   // RMS of the loudest-channel magnitude, drawn
left    = max |x[i][0]|,  right = max |x[i][min(1, ch-1)]|   // for L/R meters; mono → same
```

Incomplete reads are discarded. Cache file `AppSupport/Editroom/Waveforms/<cacheName>.wave`,
little-endian: `u32 magic 0x46575245 ("ERWF" bytes E R W F), u32 version 1, f64 peaksPerSecond,
u32 count`, then `peaks, left, right, rms` as `count` f32 each (file size must be `20 + 16*count`).
Reversed clips use the four arrays reversed.
Port: Rust, `ffmpeg -map 0:a:0 -f f32le pipe:` (native rate/channels) → identical bucket loop. Exact parity.

### 11.2 Meters (`MeterState.update`) — from waveform data, not from the audio graph

Called once per display frame. For each audio track (only while playing and audible):

```
for each clip on the track under t:
   src = sourceTime(t); hi = min(count-1, floor(src*pps)); lo = max(0, floor((src - 0.03*speed(src))*pps))
   peak/pl/pr = max of peaks/left/right over lo…hi
   g = dbToLinear(clip.gainDB) * fadeGain(t)
   level = max(level, peak*g)   (and levelL, levelR)
level *= dbToLinear(track.gainDB)                      // ducking is NOT reflected
trackReading = level > 0 ? max(-60, 20log10(level)) : -60
master (and L, R) = 10*log10(Σ_tracks level²)   (power sum; -60 if 0)
ballistics per display frame: level' = max(reading, max(-60, old - 4))        // 4 dB per frame release
   peak: if reading >= old.peak → peak = reading, hold 0.5 s; after hold: peak = max(-60, peak - 2) per frame
   clipped = reading >= -0.1 dBFS (only while at full scale); stopped → everything resets to floor
publish only if level/peak changed by > 0.2 dB or clip state changed
```

Port: replicate exactly in TS from the same waveform arrays (no AnalyserNode). The ballistics are per
display frame in the original (assumes 60 Hz); scale `4` and `2` by `dt*60` if the port's frame rate
varies — note this is a deliberate deviation on 120 Hz displays, where the original falls twice as fast.

### 11.3 Clip level helpers (used by Magic)

`envelopeDB(clip)`: over the clip's source range of `peaks`, ignoring values ≤ 0.003:
`10*log10(mean(peak²))`. `peakDB(clip) = 20*log10(max peak)`.

---

## 12. Upscaler (`Upscaler`)

Export only. For a video layer whose fit scale `s > 1.01` (e.g. 1080p footage in a 4K export), the frame is
enlarged with **MetalFX `MTLFXSpatialScaler`** (input/output `rgba16Float`, `colorProcessingMode =
.perceptual` because values are gamma-encoded) to `round(w*s) × round(h*s)` (must be > input, ≤ 16384),
then centred. Unavailable (no Metal/unsupported GPU/odd size) → the normal bilinear fit. Scalers cached by
size (≤16), textures per layer slot (≤24), purged after each export. The export sheet shows
"Upscaled from Np" when the output's long side exceeds the sequence's.

Port: AMD **FSR 1.0 EASU** (+ optional RCAS at low sharpness) as a WebGL2 shader (MIT), operating on
gamma-encoded values, then centre. MetalFX Spatial is a proprietary Lanczos-like edge-adaptive scaler; the
look will be close but not pixel-identical (parity risk: medium, export-only). Fallback: bilinear (what the
original does when MetalFX is missing).

---

## 13. Loudness measurement and normalisation (`LoudnessMeter`, `Exporter.start`)

Targets offered (`ExportSheet.loudnessTargets`): **As mixed** (nil), **−14 LUFS** (web, YouTube),
**−16 LUFS** (podcasts), **−23 LUFS** (broadcast). Only when the export includes audio.

Algorithm (ITU-R BS.1770 integrated loudness, implemented by hand):

1. Build the audio-only composition (inaudible tracks excluded, all gains/fades/ducking/speeds applied).
2. Read it as **48 kHz stereo float32** interleaved.
3. K-weighting per channel, two biquads in series (direct form II transposed:
   `y = b0x + z1; z1 = b1x - a1y + z2; z2 = b2x - a2y`), 48 kHz coefficients:
   - shelf: `b = (1.53512485958697, −2.69169618940638, 1.19839281085285)`, `a1 = −1.69065929318241`, `a2 = 0.73248077421585`
   - high-pass: `b = (1, −2, 1)`, `a1 = −1.99004745483398`, `a2 = 0.99007225036621`
4. Every 4800 frames (100 ms): `step = Σ(xL² + xR²) / 4800` (channel weights 1.0; partial last step dropped).
5. Blocks: 400 ms, 75 % overlap: `block_k = mean(step_k … step_k+3)`; need ≥ 4 steps.
6. `LUFS(p) = −0.691 + 10*log10(max(p, 1e-12))`. Absolute gate: keep blocks with `LUFS > −70`.
   Relative gate: `LUFS(mean(kept)) − 10`; keep blocks with `LUFS > gate`; integrated = `LUFS(mean(gated))`.
7. Peak = **sample peak** (max |x| of the un-weighted signal), in dBFS; −120 if silent. **No true-peak.**

Normalisation:

```swift
gain = min(target - lufs, -1 - peakDB)       // reach the target, but never push the sample peak above -1 dBFS
for every audio track: track.gainDB += gain  // then the export is built from the adjusted project
```

No limiter; if the mix measures nothing (all gated) levels are left as they are.
Port: implement this verbatim in Rust (≈60 lines) for exact parity; `ebur128` crate (MIT,
`Mode::I | Mode::SAMPLE_PEAK`) is an acceptable cross-check (differs only in gate comparison edge cases and
partial-block handling, < 0.05 LU). Do not substitute true-peak (would change the −1 dB ceiling result).
Interactions: the +gain path depends on the **UNSURE** volume>1 behaviour (§10.2); a resulting track gain
≤ −59.5 dB becomes silence via `dbToLinear`.

---

## 14. Beat detection for "cut to the beat" (`MediaAnalyzer.beats`, used by Magic)

Run in the background for **audio-only files ≥ 8 s** ("songs") after import; cached
`AppSupport/Editroom/Analysis/<name>-<hash>-beat-v2.json` (`MusicAnalysis {duration, bpm, beats[], barPhase,
energy[]}`; hash = FNV-1a of `path|size|mtime`, no file number). Snapping cuts to beats is Magic's job
(other spec); the detector is:

1. Decode the first audio track to **mono float32 at 22050 Hz** (AVFoundation resample + downmix;
   **UNSURE** whether stereo→mono is a sum or an average — ffmpeg `-ac 1` averages).
   Require `count > 8192` and `> 6 s`.
2. STFT: `n = 1024`, hop **512**, frames = `(count - n)/hop`; window = vDSP Hann **NORM**
   (per Apple's docs `w[i] = 0.8164966 * (1 - cos(2πi/1024))`, periodic; **UNSURE**: verify the constant on a
   Mac), FFT via `vDSP_fft_zrip` (its forward output is **2×** the textbook DFT), magnitude `mag[k] = |X'[k]|`
   for k = 1…511 (k = 0 skipped). Per frame also `rms[f] = sqrt(mean(windowed²))`.
3. Spectral flux: `v = log1p(100*mag[k])`; `d = v - prev[k]`; positive `d` summed into `flux[f]`, and into
   `low[f]` when `k < lowBins = max(2, Int(150/(22050/1024)))` (= 6, i.e. < ~129 Hz). `prev[k] = v`.
4. Detrend (both envelopes): subtract a centred moving average of radius `r = max(1, Int(fps*0.25))`
   (`fps = 22050/512 ≈ 43.07` → r = 10), clamp at 0 → `env`, `bassEnv`.
5. Tempo: for BPM = 70.0…180.0 step **0.2**: `lag = 60/bpm*fps`; linearly interpolated autocorrelation
   `s = Σ env[i] * lerp(env[i+l0], env[i+l0+1], frac)` over `i < count - l0 - 1`, normalised by count,
   weighted by `exp(-0.5*(log2(bpm/120))² / 0.9²)`. Best = argmax.
6. Phase: `pulse = env/max(env) + bassEnv/max(bassEnv)` (max floors 1e-6); for `p = 0, 0.5, … < period`,
   sum `pulse[Int(p + j*period)]`; best phase.
7. Tracking: from the phase, each next predicted beat `t + period` searches `±8 %` of the period for the
   max pulse; moves **halfway** toward it (if max > 0).
8. If > 8 beats: least-squares line through (index, frame); RMS residual / fps `< 0.03 s` → use the fitted
   straight grid (drop negatives); else 3-point moving average of the tracked beats.
9. `bpm = 60 / ((last - first)/(count-1)/fps)`.
10. Bar phase m ∈ 0…3 maximising `Σ_{i%4==m} bassEnv[round(b)] + 0.25*env[round(b)]`.
11. Energy per beat = mean `rms` from this beat's frame to the next (or +period), normalised to max 1.
12. Beat times (s) = `frame/fps + 512/22050` (centre of the 1024 window: `n/2 / rate`).

Port: Rust with `rustfft` (MIT) — apply the ×2 scale and the NORM window constant explicitly so
`log1p(100*mag)` sees identical magnitudes; resample with ffmpeg `-ac 1 -ar 22050`. Parity: beat times
within a frame (~23 ms) expected; tempo identical except near octave ties.

---

## 15. Media store: probe, ffmpeg conversion, caches, offline media

### 15.1 Import & probe (`MediaStore.importFile`, `probe`)

- Images: by UTType conforming to image (extension-based). Size from ImageIO properties, swapped when EXIF
  orientation ≥ 5. Kind `.image`, duration 0.
- Audio/video: `AVURLAsset(PreferPreciseDurationAndTiming)`; must be `isPlayable`. First video track that
  is decodable with `naturalSize.width > 0` and duration > 0; first decodable audio track with duration > 0.
  A file that has a video track but none decodable returns nil (→ ffmpeg). An undecodable *audio* track in an
  otherwise readable file is simply ignored (imports silent — no ffmpeg).
- `width/height` = naturalSize transformed by `preferredTransform` (rotation applied), `fps =
  nominalFrameRate`, `duration = video ? videoRange.end : max(videoEnd, audioEnd)`, `audioRate =
  naturalTimeScale`, `sourceColor` (§3.7).
- Importable extensions: anything AVFoundation reads (`.movie/.video/.audio/.image/.audiovisualContent`
  UTTypes) plus `mkv webm avi flv wmv mts m2ts ts mxf ogv ogg opus flac 3gp mpg mpeg vob f4v`.
- First video brought into an unlocked project offers to match sequence size and (snapped) fps.
- After import (+3 s delay for background work): scene tags, Magic analysis, hover strip, scrub cache (SDR),
  waveform, transcript (any file with audio), beat analysis (audio-only ≥ 8 s).

### 15.2 Orientation

```
|t.a| < 0.5 → t.b > 0 ? .right : .left       // 90° rotations
else        → t.a < 0 ? .down : .up          // 180° / none
```

Port: ffprobe `side_data_list[].rotation` (Display Matrix). **UNSURE** sign convention mapping: an iPhone
portrait clip (`a=0,b=1,c=-1,d=0` → `.right`, displayed rotated 90° clockwise) reports `rotation = -90` in
ffprobe; map `-90 → right`, `90 → left`, `±180 → down`. Confirm with test clips. WebCodecs decodes unrotated;
rotate in the compositor (as the original does with `oriented()`), including scrub frames (which are stored
unrotated).

### 15.3 Which formats go through ffmpeg, and the exact arguments (`FFmpeg.makePlayable`)

Trigger: `probe(url)` fails (not playable, or video undecodable). On project open (`restore`), an existing
converted copy is redone if it is missing or its sound doesn't decode (`soundPlays`: read 1 s of PCM).
Binary: bundled `Contents/MacOS/ffmpeg`, else `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
Every run is prefixed with `-hide_banner -loglevel error -nostdin`; success = exit status 0 **and** the
output probes as playable.

Output: `AppSupport/Editroom/Converted/<stem>-<fnv1a64(path|size|mtime|fileNumber) base36>.mov`.

```
for tag in [["-tag:v","hvc1"], []]:                    # hvc1 first (HEVC must be tagged hvc1 for AVFoundation;
                                                       #  for non-HEVC the mov muxer rejects it → falls to [])
  A: -y -i IN -map 0:v:0? -map 0:a:0? -c copy <tag> OUT
     if A fails or OUT doesn't probe → next tag
     if soundPlays(OUT) → done
  B: -y -i IN -map 0:v:0? -map 0:a:0? -c:v copy <tag> -c:a aac -b:a 256k OUT
     if B ok, probes, soundPlays → done
  C: repeat A (picture only usable; unplayable sound kept) → if probes → done
  break
D: -y -i IN -map 0:v:0? -map 0:a:0? -c:v h264_videotoolbox -q:v 70 -pix_fmt yuv420p -c:a aac -b:a 256k OUT
   if probes → done; else delete OUT, import fails
```

Vendored ffmpeg (9.1, LGPL-2.1+, arm64, `--enable-small`, static, no network/ffprobe/ffplay):
demuxers `mpegts mpegps mxf matroska ogg avi flv asf mov wav flac mp3 aac ac3 eac3 dv mpegvideo h264 hevc m4v`;
muxer `mov` only; parsers `h264 hevc aac ac3 dca mlp mpegaudio mpegvideo vp8 vp9 av1 opus vorbis flac dnxhd dvbsub`;
bsfs `aac_adtstoasc extract_extradata vp9_superframe`; decoders `mpeg1video mpeg2video dnxhd vp8 vp9 theora h264
hevc dvvideo vorbis opus mp2 mp3 ac3 eac3 dca truehd flac aac pcm_s16le pcm_s24le pcm_s32le pcm_s16be pcm_s24be
pcm_bluray pcm_dvd`; encoders `h264_videotoolbox hevc_videotoolbox aac pcm_s16le`; filters `scale format aresample
aformat null anull setpts asetpts`; protocols `file pipe`; zlib + VideoToolbox. Build script: `scripts/build-ffmpeg.sh`
(checks no local paths leak into the binary).

Port (cross-platform; the "playable" set is now "what the webview can demux+decode", not AVFoundation's):
- Ship **ffmpeg + ffprobe** sidecars per target, LGPL-only (no `--enable-gpl`, no libx264/x265). Add:
  `mp4` muxer (with `+faststart`), ProRes decoder (`prores`), `aac`/`pcm_s24le` encoders, `areverse` not
  needed, the `scale/format/fps` filters, plus per-OS hardware H.264 encoders for step D:
  `h264_videotoolbox` (mac), `h264_mf` / `h264_nvenc` / `h264_qsv` / `h264_amf` (Windows), `h264_vaapi`
  (Linux), or `libopenh264` (BSD) as universal fallback. Map `-q:v 70` (VideoToolbox quality) to an
  explicit bitrate (e.g. the §16 High formula) because other encoders interpret `-q:v` differently.
- Demux for WebCodecs: rewrap to (fragmented) MP4 and demux with mp4box.js (BSD) — or demux in Rust and send
  encoded chunks over IPC.
- Formats WebCodecs cannot decode must be transcoded (step D) even though AVFoundation could play them:
  **ProRes, DNxHD/HR, MPEG-2, DV, Theora, PCM-in-MOV video tracks**. This widens the conversion set vs the
  original (parity risk: Apple Log footage is usually ProRes → transcoding to 8-bit H.264 would destroy
  the Log precision; transcode HDR/Log sources to **10-bit HEVC** or decode ProRes frames in the sidecar
  and stream 10-bit planes instead).
- `soundPlays` equivalent: ffprobe the audio codec against the decoder list we support (AAC, MP3, Opus,
  FLAC, PCM) and convert others (AC-3, E-AC-3, DTS, TrueHD, Vorbis) with step B.

### 15.4 Caches (all under the per-user app data dir)

`cacheName(url) = <file stem> + "-" + base36(FNV-1a-64("path|size|mtime|fileNumber"))` (offset basis
`0xcbf29ce484222325`, prime `0x100000001b3`, wrapping). Derived caches use the **playable** URL (converted
copy if any). Swift formats `mtime` via `Date` interpolation (`2026-01-02 03:04:05 +0000`) — the port does not
need byte-compatible names, only the same invalidation rule (path, size, mtime, inode/file id).

| Folder | File | Content |
|---|---|---|
| `Editroom/Converted` | `<cacheName>.mov` | ffmpeg rewraps/transcodes |
| `Editroom/Waveforms` | `.wave` | §11.1 |
| `Editroom/Reversed` | `.wav` | §7 |
| `Editroom/Scrub` | `.scrub709` / `.strip` | §8.3 (≤ 6 GB LRU for `.scrub709`; older `.scrubhd`, `.scrub10` deleted) |
| `Editroom/Scenes` | `<cacheName>-3.json` | §17 |
| `Editroom/Transcripts` | `.json` | §18 |
| `Editroom/Analysis` | `<name>-<hash>-<kind>-v2.json` | beats / clip analysis (hash without file number) |

Background reads run at most **3** concurrently (`BlockingWork`), and any read that yields no sample for
**15 s** (checked every 2 s) is cancelled (`StallGuard`) — e.g. a file moved mid-read by Dropbox.

### 15.5 Changed and offline media, relinking

- `FileStamp = (size, mtime, file number)` recorded when opened; on app focus, changed files (stamp differs)
  are waited on until stable (up to 60× 1 s) and reloaded (`importFile(replacing:)`, keeping id/name;
  scene tags, transcripts, analysis forgotten).
- Offline = no runtime (video/audio) or no decoded still (image). Files still loading after project open
  are not drawn as missing (`opening` set).
- Finding moved files, in order: (1) `relativePath` from the project folder (`resolveMovedMedia`, also for
  linked folders); (2) macOS minimal **bookmarks** (`Bookmark.resolve`, ignored if in `/.Trash/`); a renamed
  file's library name follows the new file name unless the user renamed the item; (3) `adoptReplacements`:
  a missing item whose folder has **exactly one** other media file with the same stem and a different
  extension, not used elsewhere → relinked (and clips refitted to the new media length); (4) manual
  **Relink** (`relink(id, url)`): the new file must be the same kind; then every other missing item is
  looked for by **file name** in the chosen file's folder; for items in a linked folder, the folder itself is
  re-pointed if the relative path matches. Relinking clears undo history.
- Port: bookmarks → store `(volume id, file id/inode)` via `file-id` crate + last known path, and on miss
  search by file id on that volume (Windows: `GetFileInformationByHandle` index; Linux: inode, only reliable on
  the same filesystem). Parity risk: rename-tracking across moves is weaker than macOS bookmarks.

---

## 16. Export (`ExportSettings`, `Exporter`, `ExportJob`)

| Setting | Values (default first) |
|---|---|
| Format | **Video** (`.mp4`), Audio (`.wav`) |
| Codec | **H.264** (High profile, auto level), HEVC (encoder default profile — **UNSURE**, presumably Main, 8-bit since input is BGRA) |
| Quality | **High**, Web |
| Resolution | Source, 2160, 1440, 1080, 720 (§2.2) |
| Shape | Sequence, Vertical 9:16, Square 1:1, Portrait 4:5 (+ reframe point) |
| Range | whole timeline / in–out range (moved to start at 0) |
| Audio | included (default), none; loudness target (§13) |

Video:

```
bitrate = W * H * min(fps, 60) * bpp,   bpp = High 0.2 | Web 0.085,  HEVC × 0.62      (bits/s, average)
expected source frame rate = round(fps); max key-frame interval = round(fps*2) frames
frame rate = sequence fps (exact NTSC timebase, §0); size = renderSize (even)
colour tags: BT.709 primaries, BT.709 transfer, BT.709 matrix (all frame buffer attachments reset to 709)
container: MP4, shouldOptimizeForNetworkUse = true (moov atom at the front, "faststart")
```

Examples: 1080p30 High H.264 ≈ 12.44 Mb/s, Web ≈ 5.29 Mb/s, HEVC High ≈ 7.71 Mb/s; 4K30 High H.264 ≈ 49.8 Mb/s.
Rate control/B-frames: AVFoundation/VideoToolbox defaults (**UNSURE**: H.264 High via VideoToolbox allows
frame reordering by default).

Audio: mixed by AVFoundation to **48 kHz stereo**; MP4 → AAC-LC **256 kb/s (High) / 160 kb/s (Web)**, from
16-bit integer PCM (so the mix is hard-clipped at 0 dBFS before encoding); WAV → **24-bit** little-endian
integer PCM, 48 kHz stereo. Speed changes use the spectral time-pitch algorithm.

Pipeline: (1) wait for any reversed sound still being made; (2) loudness measurement pass if a target is set
(§13); (3) build at render size with `reframe` if cropping and `upscale: true`; (4) read composited frames
(BGRA) and mixed audio, encode, write; progress from video PTS / duration; cancel deletes the file.
Exports queue and run one at a time on a snapshot of the project.

Port:
- Video: render each frame with the WebGL2 compositor at `t = k*frameDuration`, convert RGB→Y′CbCr
  **ourselves** in a shader (BT.709 matrix, limited range, 4:2:0 with centre-sited chroma — **UNSURE** which
  siting VideoToolbox uses; MPEG-2/left siting is H.264's default) and wrap as `VideoFrame` `I420`/`NV12`
  with `colorSpace {primaries:'bt709', transfer:'bt709', matrix:'bt709', fullRange:false}`. Letting the
  browser do RGB→YUV picks an engine-specific matrix.
- `VideoEncoder` config: `avc1.640033`-style (High, level chosen for size/fps), `bitrate` per formula,
  `bitrateMode: 'variable'`, `latencyMode: 'quality'`, key frame forced every `round(2*fps)` frames;
  HEVC `hvc1.1.6.L…`.
- **Platform risk (high)**: WebCodecs availability differs per Tauri webview — WebView2 (Windows) yes;
  WKWebView (macOS) video encode yes, AAC `AudioEncoder` only on recent Safari (**UNSURE**); WebKitGTK
  (Linux) WebCodecs is incomplete. Keep an ffmpeg-sidecar fallback: stream raw I420 frames over a pipe to
  `ffmpeg -f rawvideo … -c:v <hw encoder|libopenh264> -b:v <bitrate> -g <2*fps> -colorspace bt709
  -color_primaries bt709 -color_trc bt709 -movflags +faststart`.
- Audio: mix in Rust (f32, 48 kHz), convert to s16 with clipping for MP4 (to match), encode AAC with
  ffmpeg's native `aac` encoder (`-b:a 256k|160k`) — different AAC encoder than Apple's, inaudible parity
  risk; WAV: write s24le in Rust (`hound`, MIT).
- Mux: Rust `mp4` crate (MIT) or `ffmpeg -c copy -movflags +faststart`; set `colr` nclx 1/1/1.
- *PromptEdit addition, ProRes MOV:* same frames; the compositor's (half-float) output is packed in a shader as v210 (10-bit
  4:2:2, BT.709 limited range, chroma co-sited on even pixels with a [1 2 1]/4 filter) and sent as the raw body of
  `export_frames` (Tauri raw invoke; dev server `/raw/export_frames`), straight into
  `ffmpeg -f v210 -video_size WxH -framerate N/D -i pipe:0 -i mix.wav -c:v prores_videotoolbox -allow_sw 1 | prores_ks -vendor apl0
  -profile:v proxy|lt|standard|hq -c:a pcm_s24le -color_primaries/trc/colorspace bt709 -movflags +write_colr -f mov`
  (`export_video_start` starts it after the mix and loudness gain are known). VideoToolbox is used only if a test frame
  encodes. *MP3:* the gained mix as 24-bit PCM → `libmp3lame -b:a 320k|192k` (CBR, ID3v2.3, Xing/LAME header).

---

## 17. Scene tags (`SceneTags`, `SceneTagStore`) — Vision classification

Videos: frames at `t_i = duration*(i+0.5)/n`, `n = min(20, max(8, round(duration)))`, max 640×640, preferred
transform applied. Each frame: `VNClassifyImageRequest` (Apple's ~1,300-label taxonomy; identifiers with `_`
→ space), keep labels with confidence ≥ **0.2**. Aggregate: per label max confidence; times (rounded to 0.01 s)
where confidence ≥ **0.35**; keep labels whose max ≥ **0.35**; confidence rounded to 0.01; sorted descending.
Photos: one 640-px thumbnail.
Plus Apple Intelligence keywords (macOS 27, vision-capable on-device model): frames at
`duration*(i+0.5)/m`, `m = min(6, max(2, Int(duration/3)))` (photos: one 768-px thumbnail), prompt (instructions):
"You label video frames for search. Reply with one line: up to 12 short comma-separated keywords for the place,
vehicles, objects, activity and people's expressions. Plain words, no sentences." + "Keywords for this frame:"
+ image; reply lower-cased, split on commas, trimmed of whitespace/punctuation, each ≤ 30 chars and ≤ 3 words,
≤ 12 kept; new words become tags with confidence **0.6**, existing tags gain the time.
Search: `shows(word)` matches tag words, the alias table (`SceneTags.aliases`, copy verbatim from
`Engine/SceneTags.swift` lines 77–205), singulars (`len>3`, trailing `s` not `ss`), prefix while typing, and
`sameStem` (both ≥5 chars, strip one of `ing ter ers er ed es s` when the rest is > suffix+3, then a trailing
`e` if > 4 chars). Cache: `Scenes/<cacheName>-3.json` (`{"tags":[{"name","confidence","times"}]}`).

Port: ONNX Runtime (`ort` crate) with a CLIP model (e.g. ViT-B/32) doing zero-shot classification against the
**same label list** (export once on a Mac from `VNClassifyImageRequest.supportedIdentifiers`, ship as JSON so
the alias table and Magic prompts keep working). Thresholds 0.2/0.35 must be re-calibrated (CLIP softmax over
1,300 classes is not comparable to Vision's per-label confidences; use per-label sigmoid on scaled cosine
similarity, tuned on a test set). Keywords: optional local VLM (llama.cpp with a small vision model) or skip.
Parity risk: high for exact tags, low for user-visible behaviour (search/Magic only).

---

## 18. Transcripts (`Transcripts`, `SpeechReader`) — Speech

macOS 26 `SpeechAnalyzer` + `SpeechTranscriber` (on-device; model downloaded once via `AssetInventory`),
locale = supported equivalent of the current locale, else `en-US`; no partial results; attribute option
`.audioTimeRange`. The file's first audio track is decoded to the analyser's best format. Each attributed
**run** with a time range becomes a word `{start, end, text}` (trimmed, non-empty), sorted by start. Runs
carry punctuation attached (`"guys,"`) — caption layout depends on trailing `, . ? !`
(**UNSURE**: whether a run can span more than one word). Stored as
`Transcripts/<cacheName>.json` `{"words":[{"start","end","text"}],"language":"en_US"}`. One file at a time;
`ready()` waits up to 90 s; failures are remembered for the session.
Helpers used elsewhere: `speech(gap 0.45)`, `sentences(gap 0.8, split after . ? !)`, `tokens()` = lower-case
split on anything but letters, digits and `'`.

Port: `whisper-rs` (whisper.cpp, MIT) with token timestamps and word splitting (`set_token_timestamps(true)`,
`set_split_on_word(true)`, `set_max_len(1)`; DTW timestamps for better word timing), language from the OS
locale, model `base`/`small` (multilingual) downloaded on first use; keep punctuation attached to the
preceding word. Audio: ffmpeg → 16 kHz mono f32. Parity risk: medium — different word boundaries/punctuation
change caption phrasing and timing (layout rules in §9.3 are deterministic given the words).

---

## 19. Apple framework → port replacement summary

| Subsystem | Apple dependency | Port replacement | Parity risk |
|---|---|---|---|
| Decode | AVFoundation, VideoToolbox | WebCodecs `VideoDecoder` (+ mp4box.js), ffmpeg sidecar for the rest | Medium (codec coverage, HDR raw access) |
| Compositor | AVVideoComposition + Core Image (Metal) | WebGL2 shaders (one path for preview + export) | Low if §0/§1 rules kept |
| Grade / LUT | CIColorCube | 3D texture RGBA16F, same 32³ bake | Low |
| HDR→SDR | AVFoundation tone mapping | §3.7 fitted curve as 64³ LUT | High (HLG/PQ only) |
| Apple Log | Core Image + own maths | same maths, own Y′CbCr shader | Low |
| Text/captions | AppKit/CoreText, SF Pro | OffscreenCanvas 2D + bundled Inter | Medium (font) |
| Upscaler | MetalFX Spatial | FSR1 EASU(+RCAS) shader | Medium (export only) |
| Audio mix/ramps | AVAudioMix | Rust mixer (exact per-sample gains) | Low (volume>1 UNSURE) |
| Time-stretch | `.spectral` | signalsmith-stretch / SoundTouch | Medium |
| Playback clock | AVSampleBufferRenderSynchronizer | Web Audio master clock + AudioWorklet | Low |
| Scrub audio | AVAudioEngine source node | AudioWorklet | Low |
| Waveforms/meters | AVAssetReader + Accelerate | ffmpeg pipe + Rust loop; TS meters | None |
| Loudness | own BS.1770 code | same code in Rust (ebur128 cross-check) | None |
| Beats | Accelerate vDSP | rustfft, same constants | Low |
| Export encode | AVAssetWriter / VideoToolbox | WebCodecs VideoEncoder + own RGB→YUV; ffmpeg fallback; ffmpeg AAC | Medium (platform availability) |
| Mux | AVAssetWriter MP4/WAV | `mp4` crate or ffmpeg `-c copy`; `hound` for WAV | Low |
| Scene tags | Vision `VNClassifyImageRequest`, FoundationModels | ort + CLIP over the Vision label list | High (labels) |
| Transcripts | Speech `SpeechTranscriber` | whisper-rs | Medium |
| Relinking | NSURL bookmarks | file-id + relative path + name search | Medium |
| Thumbs/scrub caches | AVAssetImageGenerator, ImageIO HEIC/JPEG | ffmpeg frames → JPEG/WebP | None (transient) |

### 19.1 Display colour (viewer) — parity note

The viewer shows BGRA buffers tagged BT.709 through Core Animation, which colour-manages them to the display
(macOS treats the BT.709 tag with its own transfer interpretation). A browser canvas treats the same values
as sRGB. Exported files are unaffected (tagged 709, players decide). **UNSURE** which transfer function
macOS applies for 709-tagged IOSurfaces; to match the Mac viewer exactly, the WebGL viewer would apply a
`709-decode → sRGB-encode` display transform (shadows render slightly lighter on the Mac than raw-as-sRGB).
Decide once and document; default recommendation: show raw values (matches how most web/players show 709).
