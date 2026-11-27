# 01 — Data model, project file format and editing operations

Source of truth: the Editroom Swift sources at `/home/user/robbietilton/editroom` (read-only). The main files are
`Editroom/Model/Project.swift`, `EditorModel.swift`, `SpeedRamp.swift`, `ZoomMove.swift`, `ColorGrade.swift`,
`Captions.swift`, `MediaFolders.swift`, `Magic/MagicHistory.swift`, and the gesture code in `UI/TimelineCanvas.swift`,
`UI/InspectorView.swift`, `UI/TimelinePanel.swift` and `UI/PreviewView.swift`.
Anything marked **UNSURE** was inferred rather than read directly in the code. Check it against a real `.room` file
before relying on it.

Conventions in this document:
- **All times are `Double` seconds.** Nothing is stored in frames. Timeline times are seconds from timeline zero.
  Source times are seconds into the media file, measured from the end of the file for reversed clips (see §2.10).
  Frame alignment comes only from `snapFrame(t) = round(t * fps) / fps`, applied by the operations.
- `eps` constants (1e-6, 1e-9, 0.5/fps) are quoted exactly. Porting them exactly matters for parity.
- "linked group" of a set S = `project.linked(S)`: S plus every clip that shares a non-nil `linkID` with a member of S.
- "unlocked(S)" = S minus clips on locked tracks.

---

## 1. Project file format

### 1.1 File, extension, UTI

| Item | Value |
|---|---|
| Extension written | `.room` (Save As offers `<title>.room`) |
| Extensions read | `room`, `cutplay` (`cutplay` is the legacy name from before the app was called Editroom). Matching is case-insensitive (`pathExtension.lowercased()`). |
| UTI | `com.wonderassembly.editroom.project`, conforms to `public.data`, `public.content`. Description "Editroom Project", icon text "ROOM". |
| Layout | **A single flat JSON file, not a bundle or package.** Media is referenced by absolute path, with a relative path as fallback, and is never copied into the project. Exception: files dropped from Photos are written to a `From Photos/` folder next to the project file (see §1.6). |
| Encoding | UTF-8 JSON written by Swift `JSONEncoder`. On Save and on in-place autosave the encoder uses `outputFormatting = [.prettyPrinted, .sortedKeys]`. The recovery copy uses the default compact, unsorted output. Writes are atomic. |
| Title | The file name without its extension. An unsaved project is "Untitled". |

Top-level wrapper (`SavedDocument`):

```json
{ "project": { ... }, "version": 1 }
```

- `version: Int`, always `1`. No reader branches on it, and no migration code depends on the version number.
- `project: Project`.

Note: some self-tests encode a bare `Project` without the wrapper. Real project files always have the wrapper.

### 1.2 Swift `JSONEncoder` conventions (needed for a compatible serde/TS codec)

- **Key names are exactly the Swift property names.** No type in the model declares custom `CodingKeys` strings.
- **Optionals:** a `nil` optional is **omitted** from the output (synthesized `encodeIfPresent`). On decode, a
  missing key or `null` gives `nil`.
- **Non-optional properties with Swift default values are still REQUIRED on decode** wherever the type uses
  synthesized `Decodable` (Swift ignores property defaults when decoding). Only `Track` and `CaptionStyle` have
  hand-written decoders that tolerate missing keys. A PromptEdit writer must emit every non-optional key. A
  PromptEdit reader may use defaults, but must not count on Editroom doing the same.
- `UUID` is encoded as a string from `uuidString`: uppercase, hyphenated, for example `"6F1D8C64-1B2E-4C38-9A6E-0B9C1F6A1B2C"`.
  Decoding is case-insensitive. Write uppercase.
- `Double` is a JSON number. Integral values may be written without a decimal point (`30`, not `30.0`).
  NaN or ±Infinity make encoding throw, so the save fails with "Couldn't save to X." Never write them.
- `Int` fields (`width`, `height`) should be written as integers with no fraction. **UNSURE** whether Editroom's
  decoder accepts `1920.0`.
- `Bool` is a JSON boolean.
- `Data` (`bookmark`) is a **base64 string**, the default `.base64` strategy.
- `Date` (`MagicHistory.Entry.date`) uses the default `.deferredToDate` strategy: a **Double number of seconds since
  2001-01-01T00:00:00Z** (Apple reference date), not Unix time. Unix = value + 978307200.
- String enums are encoded as their raw values (listed with each type).
- `/` in strings is escaped as `\/` (the default; `.withoutEscapingSlashes` is not set). Any JSON reader handles this.
- **`[UUID: [CaptionFix]]` (`Project.captionFixes`)**: a dictionary whose key is not `String` or `Int`. Swift's
  `Dictionary` coding writes such a dictionary as a **flat JSON array of alternating key and value**
  (`["<UUID>", [fix, ...], "<UUID>", [fix, ...]]`) unless the key type conforms to `CodingKeyRepresentable`.
  **UNSURE** whether Foundation's `UUID` conforms on the Editroom build's SDK. I believe it does not, so the array
  form is used. Recommendation: the PromptEdit reader accepts both the alternating-array form and the
  `{ "<UUID>": [...] }` object form. The writer emits the alternating-array form until it has been checked against a
  file that Editroom wrote. Plain `[String]` and other arrays are ordinary JSON arrays.

### 1.3 Where else project JSON lives

| What | Where | Format |
|---|---|---|
| Recovery copy (untitled work, or unsaved changes to a saved project while Auto-save is off) | `~/Library/Application Support/Editroom/Recovery/Untitled.room` | `SavedDocument`, compact JSON, no relative paths stamped |
| Last session to reopen | UserDefaults `lastSession` = a project file path, or the string `"untitled"` for the recovery copy | — |
| Which project file the recovery copy belongs to | UserDefaults `recoveryFor` (a path) | — |
| Media held for an unsaved project (Photos drops) | `~/Library/Application Support/Editroom/From Photos/` (temporary files in `.incoming/`) | media files |

### 1.4 Save / open / autosave behaviour

- **Save (`write(to:)`)**: `commitLive()` first. `adoptHeldMedia` moves media from the held folder into
  `<projectDir>/From Photos/` and repoints those assets. The encoder then works on a copy of the project with
  `stampRelativePaths(projectDir)` applied, so the relative paths are not stored back into the live model. The
  recovery file is removed if the project was untitled or had a recovery copy. After a successful write:
  `fileURL = url`, `isDirty = false`, `lastSession = path`.
- **`stampRelativePaths(projectDir)`**: for every asset and every linked folder, the relative path is computed from
  standardized path components. Count the shared leading components, then build
  `relativePath = ("../" × (base.count − shared)) + remaining file components`, joined with `/`.
  Example: project `/a/b/p.room` and media `/a/c/x.mov` give `"../c/x.mov"`.
- **Open (`open(url:)`)**: decode `SavedDocument`, then `resolveMovedMedia(projectDir)`:
  1. For each linked folder whose `path` no longer exists and that has a `relativePath`: if
     `projectDir/relativePath` (standardized) is a directory, `movePaths(from: old, to: candidate)`. This rewrites
     the paths of every asset, folder and hidden entry under it.
  2. For each asset whose `path` does not exist and that has a `relativePath`: if `projectDir/relativePath` exists,
     set `path = candidate`.
  Then `load()`: stop playback, clear the undo and redo stacks, clear the selection, set the playhead to 0, and
  create a bookmark for any asset or folder that has none (older projects). Set the project, mark it clean, and
  fit the timeline rows. Then, asynchronously: re-attach media (playable copies converted again if they have gone
  stale), `syncFolders()` (follow bookmarks, import new files from linked folders, drop deleted unused files), and
  offer to locate missing media. A decode failure shows "Couldn't open <name>."
  **`sanitize()` is not run on load**; it runs only on edits.
- **Autosave**: a 1 s timer. If `isDirty`, no live (continuous) edit is in progress, and more than 2 s have passed
  since the last change:
  - Saved project with Auto-save on (UserDefaults `autosave`, default `true`): written in place (same as Save).
  - Saved project with Auto-save off: written to the recovery copy, and `recoveryFor = path`.
  - Untitled and empty (no clips, no assets): the recovery copy is deleted.
  - Untitled with content: written to the recovery copy, and `lastSession = "untitled"`.
- **Launch**: reopens `lastSession` (the recovery copy is loaded as dirty). If `recoveryFor == lastSession`, the
  recovery copy is loaded over the file, still dirty.
- **Close / New / Open another**: with Auto-save on, untitled work with clips asks "Discard unsaved changes?", and a
  saved file is just autosaved. With Auto-save off, Save / Cancel / Don't Save is offered.

### 1.5 Example minimal file (every required key present)

```json
{
  "project" : {
    "assets" : [ {
      "duration" : 12.5, "fps" : 29.97, "hasAudio" : true, "height" : 1080,
      "id" : "11111111-1111-1111-1111-111111111111", "kind" : "video", "name" : "beach",
      "path" : "\/Users\/me\/Movies\/beach.mov", "relativePath" : "..\/Movies\/beach.mov", "width" : 1920
    } ],
    "audioTracks" : [
      { "duckDB" : -12, "gainDB" : 0, "hidden" : false, "id" : "AAAA0001-0000-0000-0000-000000000000", "kind" : "audio", "locked" : false, "muted" : false, "solo" : false },
      { "duckDB" : -12, "gainDB" : 0, "hidden" : false, "id" : "AAAA0002-0000-0000-0000-000000000000", "kind" : "audio", "locked" : false, "muted" : false, "solo" : false } ],
    "clips" : [ {
      "assetID" : "11111111-1111-1111-1111-111111111111",
      "color" : { "a" : 1, "b" : 0.2, "g" : 0.16, "r" : 0.16 },
      "duration" : 4, "fadeIn" : 0, "fadeOut" : 0, "gainDB" : 0,
      "id" : "22222222-2222-2222-2222-222222222222", "kind" : "video",
      "linkID" : "33333333-3333-3333-3333-333333333333",
      "sourceStart" : 0, "speed" : 1, "start" : 0,
      "text" : { "bold" : true, "color" : { "a" : 1, "b" : 1, "g" : 1, "r" : 1 }, "fontName" : "", "size" : 110, "string" : "Text", "x" : 0.5, "y" : 0.5 },
      "trackID" : "BBBB0001-0000-0000-0000-000000000000"
    } ],
    "fps" : 30, "height" : 1080, "settingsLocked" : true,
    "videoTracks" : [
      { "duckDB" : -12, "gainDB" : 0, "hidden" : false, "id" : "BBBB0001-0000-0000-0000-000000000000", "kind" : "video", "locked" : false, "muted" : false, "solo" : false },
      { "duckDB" : -12, "gainDB" : 0, "hidden" : false, "id" : "BBBB0002-0000-0000-0000-000000000000", "kind" : "video", "locked" : false, "muted" : false, "solo" : false } ],
    "width" : 1920
  },
  "version" : 1
}
```

(A real file would also contain the linked audio clip and a base64 `bookmark` for the asset.)

### 1.6 Not stored in the project

These are app state (UserDefaults or memory), not project data: selection, playhead, timeline zoom and scroll,
tool, snapping (`true` at launch, not persisted), clipboard, copied grade, and the undo history.
UserDefaults keys: `timeStyle` (`"timecode"` | `"simple"`), `skimming`, `thumbnails`, `audioScrub`,
`stickyEdges`, `loopPlayback`, `autosave`, `lastSession`, `recoveryFor`, `zoomMoveMode`, `speedRampMode`
(`"in"` | `"inOut"`; legacy `speedRampTwoPoint`), `playFromSkimmer`, `shortcuts`.
Per-file caches (transcripts, scene tags, media notes, scrub strips, waveforms) live outside the project and are
covered in other specs.

---

## 2. Codable types

Every field is listed as **Name · Swift type · default (used when created by the app) · units/range · notes**.
"req" means the key is required when Editroom decodes it.

### 2.1 `SavedDocument` (synthesized)
| Field | Type | Default | Notes |
|---|---|---|---|
| version | Int | 1 | req |
| project | Project | — | req |

### 2.2 `Project` (synthesized Codable, Equatable)
| Field | Type | Default | Units / notes |
|---|---|---|---|
| width | Int | 1920 | px, req. The UI keeps it even, 16–8192. |
| height | Int | 1080 | px, req. The UI keeps it even, 16–8192. |
| fps | Double | 30 | req. The UI picks from `[23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120]`. |
| settingsLocked | Bool | false | req. Set true once the sequence size or rate has been decided (first video import, or any manual change). Stops the "match sequence to first video?" offer. |
| videoTracks | [Track] | 2 new video tracks | req. **Index 0 = V1 = bottom-most** (drawn first). |
| audioTracks | [Track] | 2 new audio tracks | req. **Index 0 = A1 = top-most** in the UI. |
| clips | [Clip] | [] | req. Order is not meaningful except as a tiebreak (new split pieces are appended). |
| assets | [MediaAsset] | [] | req. The library ("Media panel"); order is the display order. |
| exportName | String? | nil | Last export file name (no extension). |
| exportDir | String? | nil | Last export directory path. |
| markers | [Marker]? | nil | nil when there are none (deleting the last marker sets nil). |
| inPoint | Double? | nil | seconds |
| outPoint | Double? | nil | seconds |
| magicHistory | [MagicHistory.Entry]? | nil | Newest first, at most 20, unique by text. |
| captions | CaptionTrack? | nil | Present while at least one clip is captioned. |
| captionFixes | [UUID: [CaptionFix]]? | nil | Keyed by **asset id**. See the encoding note in §1.2. |
| folders | [MediaFolder]? | nil | Linked folders on disk. nil when empty. |
| hiddenMedia | [String]? | nil | Absolute paths (files or folders) inside linked folders that were removed from the project. nil when empty. |

Derived values (not stored):
- `duration = max(clip.end)`, or 0 with no clips.
- `aspect = width / max(1, height)`.
- `Project.minClip = 1/60` s.
- `snapFrame(t) = (t * fps).rounded() / fps`. Swift `.rounded()` is round-half-away-from-zero.
- `markerList` = markers sorted by time.
- `playRange`: nil if neither in nor out is set. Otherwise `a = inPoint ?? 0`, `b = outPoint ?? duration`,
  `lo = min(a,b)`, `hi = max(a,b)`. Returns `(lo, hi)` only if `hi - lo >= 1/fps`, else nil.
- `isAudible(track) = !muted && (no audio track is soloed || track.solo)`.
- `editPoints` = sorted unique set of {0, every clip start and end, every marker time}.
- `snapTargets(excluding ids)` = [0] + marker times + inPoint + outPoint + start and end of every clip not in `ids`.
  Drag gestures also add the playhead.

### 2.3 `Track` (custom decoder, synthesized encoder)
| Field | Type | Default | Notes |
|---|---|---|---|
| id | UUID | new | **req** |
| kind | TrackKind (`"video"`/`"audio"`) | — | **req** |
| hidden | Bool | false | optional on decode. Video tracks only: not drawn. |
| muted | Bool | false | optional. Audio only. |
| gainDB | Double | 0 | optional. dB, UI range −60…+12, step 0.1. ≤ −59.5 dB is silent. Audio only. |
| solo | Bool | false | optional. Audio only. |
| locked | Bool | false | optional. Clips can't be selected, moved, trimmed, cut or added to. |
| duckUnder | UUID? | nil | optional. Audio only: id of another audio track. This track is turned down while that track has sound. Not cleared when the target track is removed (left dangling; renderers ignore an id that no longer exists). |
| duckDB | Double | −12 | optional. The ducked level in dB (menu: −6, −12, −18, −24). |

Fixed placeholder track ids (`TrackToken`), used only in memory during drags and drops:
`newVideo = 00000000-0000-0000-0000-0000000000A1` and `newAudio = 00000000-0000-0000-0000-0000000000A2`.
`materializeTokens()` replaces them with real new tracks before an edit is committed. They are never saved
(`sanitize` would drop clips on unknown tracks).

### 2.4 `Clip` (synthesized; Identifiable, Hashable)
| Field | Type | Default | Units / notes |
|---|---|---|---|
| id | UUID | new | req |
| trackID | UUID | — | req |
| kind | ClipKind | — | req. `"video"`, `"audio"`, `"image"`, `"solid"`, `"text"`. `audio` goes on audio tracks; all other kinds on video tracks. |
| assetID | UUID? | nil | The source asset for video, audio and image clips. nil for solid and text. |
| start | Double | — | req. Timeline seconds, ≥ 0. |
| duration | Double | — | req. Timeline seconds. Must be > 1e-6 or `sanitize` drops the clip. |
| sourceStart | Double | 0 | req. Source seconds at the clip's start (reversed coordinate for reversed clips). For freeze clips, the frame that is held. Unused for image, solid and text. |
| speed | Double | 1 | req. Playback rate (2 = twice as fast), clamped 0.05…100 by operations. With a ramp, the speed of the middle section. |
| fadeIn | Double | 0 | req. Seconds, 0…duration. |
| fadeOut | Double | 0 | req. Seconds, 0…duration − fadeIn. |
| fadeInCurve | FadeCurve? | nil (=linear) | `"linear"`, `"easeIn"` (labelled "Exponential"), `"easeOut"` ("Logarithmic"), `"smooth"` ("S-Curve"). |
| fadeOutCurve | FadeCurve? | nil (=linear) | |
| gainDB | Double | 0 | req. Clip volume in dB, −60…+12 (audio clips). |
| linkID | UUID? | nil | Clips sharing a linkID are linked (a video and its own sound). |
| color | RGBA | (0.16, 0.16, 0.2, 1) | req. Fill for solid clips. The values are sRGB 0…1. |
| text | TextStyle | TextStyle() | req (present on every clip, used only by text clips). |
| grade | ColorGrade? | nil | nil = untouched. The UI stores nil when the grade is neutral. |
| transform | ClipTransform? | nil | nil = fitted to the frame. The UI stores nil when it is identity. |
| transitionIn | Transition? | nil | Transition into this clip from the clip that ends where this one starts (same track, non-audio). |
| freeze | Bool? | nil | `true` = freeze frame (the frame at `sourceStart` is shown for the clip's whole length). |
| reversedFrom | ReverseSource? | nil | **Legacy**: set on clips from old projects that were reversed into a reversed copy of the file. |
| reversed | Bool? | nil | `true` = plays its source backwards. The app writes nil, never false, when it is not reversed. |
| ramp | SpeedRamp? | nil | Speed ramp. nil = constant `speed`. |
| captioned | Bool? | nil | `true` on audio clips whose speech shows on the caption track. The app writes nil, never false. |

Derived values:
- `end = start + duration`.
- `isFreeze = freeze == true`, `playsBackwards = reversed == true`, `isReversed = playsBackwards || reversedFrom != nil`.
- `playsSource = (kind == video || kind == audio) && !isFreeze`. Speed and source limits apply only to such clips.
- `isTransformable = kind ∈ {video, image, solid}`. Text has its own `x`/`y`.
- `inCurve = fadeInCurve ?? .linear`, `outCurve = fadeOutCurve ?? .linear`.
- `FadeCurve.apply(x)` with x clamped to 0…1: linear `x`, easeIn `x³`, easeOut `1 − (1−x)³`, smooth `x²(3−2x)`.
- `fadeGain(t) = clamp01(min(1, fadeIn>0 ? inCurve((t−start)/fadeIn) : 1, fadeOut>0 ? outCurve((end−t)/fadeOut) : 1))`.
  It multiplies video opacity and audio gain. In the extra time a transition shows (lead-in or tail-out), the
  renderer clamps `t` into `[start, end]` before applying the fades.
- `clampFades()`: `fadeIn = clamp(fadeIn, 0, duration)`, then `fadeOut = clamp(fadeOut, 0, duration − fadeIn)`.
- Display name: text clips use the string with newlines replaced by spaces (empty gives "Text"). Solids are "Solid".
  Others use the asset name, or "Missing".

### 2.5 `RGBA` (synthesized)
`r, g, b, a: Double`, all required, 0…1, sRGB. Constants: `white = (1,1,1,1)`, `black = (0,0,0,1)`.

### 2.6 `TextStyle` (synthesized; all keys required)
| Field | Type | Default | Units |
|---|---|---|---|
| string | String | "Text" | Can contain newlines. An empty string draws nothing. |
| fontName | String | "" | A font family name. "" = system font. |
| bold | Bool | true | |
| size | Double | 110 | Points relative to a **1080 px tall frame**: rendered pt = `size * renderHeight / 1080`. UI range 12…600 (logarithmic slider), whole numbers. |
| color | RGBA | white | |
| x | Double | 0.5 | Centre of the text block as a fraction of frame width (0 = left, 1 = right). A drag in the viewer clamps it to 0…1. |
| y | Double | 0.5 | Centre as a fraction of frame height (0 = top). |

Rendering facts that matter for parity: centred paragraph; wraps at 94% of frame width; padding
`ceil(pt * 0.25)` on every side of the text image.

### 2.7 `Transition` / `TransitionKind`
| Field | Type | Default | Notes |
|---|---|---|---|
| kind | TransitionKind | `"dissolve"` | `"dissolve"`, `"dipToBlack"`, `"wipe"`. Labels: Dissolve, Dip to Black, Wipe. |
| duration | Double | 0.5 | Seconds. UI 0.1…5, rounded to 0.01. **The length actually used can be shorter** (§3.13). |

### 2.8 `ReverseSource` (legacy)
`assetID: UUID` and `sourceStart: Double`, both required. They identify the original footage that a
legacy reversed copy was made from.

### 2.9 `ClipTransform`
| Field | Type | Default | Units |
|---|---|---|---|
| scale | Double | 1.0 | 1 = fitted to the frame (aspect-fit, centred). Range `0.05…10`. UI 5%…1000%, rounded to 0.1%. |
| x | Double | 0 | Offset of the clip's centre from the frame centre, as a **fraction of frame width**. Positive = right. |
| y | Double | 0 | Offset as a **fraction of frame height**. **Positive = down.** |
| zoom | ZoomMove? | nil | An animated zoom between the full frame and this scale and offset. |

- `isIdentity`: equal to `ClipTransform()`.
- `fills = scale > 1.001`.
- `zoomedOffset`: if `fills`, with `m = (scale−1)/2`, the result is `(clamp(x,−m,m), clamp(y,−m,m))`, so a picture
  larger than the frame always covers it. Otherwise `(x, y)`.
- `at(u)`, the framing `u` seconds into the clip:
  - With no zoom: `scale` with `(x,y) = zoomedOffset` (nil if that is identity).
  - With a zoom: `k = zoom.amount(u)`, `scale' = 1 + (scale−1)·k`, `(x',y') = zoomedOffset · k`.
- The renderer scales about the frame centre, then translates by `(x·W, −y·H)` in Core Image's y-up coordinates,
  which is `+y·H` downward on screen.
- Inspector: when `fills`, X/Y are **shown** as `−x·W` and `−y·H` ("where it frames") and limited to ±m. Otherwise
  they are shown as `x·W`, `y·H` px, limited to ±`(1+scale)/2` of the frame. Values are rounded to 0.1 px. A drag in
  the viewer snaps to the centre within 5 screen points and rounds to whole frame pixels.

### 2.10 `ZoomMove`
| Field | Type | Default | Notes |
|---|---|---|---|
| mode | Mode | — | Raw values **`"in"`** (zoomIn), **`"inOut"`**, **`"out"`** (zoomOut). |
| p1, p2, p3, p4 | Double | — | **Seconds from the clip's start** (timeline seconds, not source). The move in runs over p1…p2, the move out over p3…p4. |
| smooth | Bool | true | req (synthesized). Smoothstep easing when true, linear when false. |

- `ramp(u, a, b)`: if `b − a ≤ 1e-6` the result is `u ≥ a ? 1 : 0`. Otherwise `k = clamp01((u−a)/(b−a))`, and the
  result is `smooth ? k²(3−2k) : k`.
- `amount(u)`: in → `ramp(u,p1,p2)`; out → `1 − ramp(u,p3,p4)`; inOut → `u < p3 ? ramp(u,p1,p2) : 1 − ramp(u,p3,p4)`.
- `starter(mode, length)`: `m = min(max(length·0.25, 0.5), 2, length/2)`. in = (0, m, L, L); out = (0, 0, L−m, L);
  inOut = (0, m, L−m, L).
- `fit(length)`: clamp each point to 0…L and keep them in order: `p1=c(p1); p2=max(p1,c(p2)); p3=max(p2,c(p3)); p4=max(p3,c(p4))`.
- `shift(by d, length)`: subtract d from every point, then `fit`. Used by trimHead so the zoom stays on the same picture.
- `zoomedTime(L)`, where the zoom is fully in: in/inOut → `clamp(p2, 0, L−1e-3)`; out → `clamp(p3−1e-3, 0, L−1e-3)`.

### 2.11 `SpeedRamp` (all keys required)
| Field | Type | Notes |
|---|---|---|
| inFrom, inTo | Double | **Source seconds** (in the clip's source coordinate). The speed eases from `startSpeed` to the clip's `speed` (mid) over this range. |
| outFrom, outTo | Double | Source seconds. The speed eases from mid to `endSpeed` over this range. |
| startSpeed | Double | Speed before `inFrom`, and when extrapolating before the clip. |
| endSpeed | Double | Speed after `outTo`, and when extrapolating after it. |

Because the points are in source time, a trim or split shows a different part of the same curve, and both halves
of a split keep a copy of the whole ramp. Formulas are in §3.2.

### 2.12 `ColorGrade` (all keys required except `look`)
| Field | Type | Default | Range / units |
|---|---|---|---|
| look | String? | nil | A built-in look name, or the absolute path of a `.cube` file. |
| lookIntensity | Double | 1.0 | 0…1 (UI 0–100%, whole percents) |
| exposure | Double | 0 | Stops, −2…2 (UI rounds to 0.01) |
| contrast | Double | 0 | −50…50 (whole numbers) |
| saturation | Double | 0 | −100…100 |
| temperature | Double | 0 | −50…50, negative = cooler |
| tint | Double | 0 | −50…50, positive = toward magenta |
| shadows, midtones, highlights | WheelPoint | (0,0) | |

`WheelPoint { x: Double = 0, y: Double = 0 }`, both required. A position inside the unit circle, x right, y down.
Red is at 0°, green at 120°, blue at 240°. `offset`: `m = min(1, √(x²+y²))·0.22`, `a = atan2(y,x)`, and the RGB
offset is `(cos a·m, cos(a−2π/3)·m, cos(a+2π/3)·m)`.

`isNeutral`: no look and everything else at default. `lookIntensity` is ignored when `look == nil`.
Built-in look names (exact strings): `"Warm film"`, `"Golden hour"`, `"Film print"`, `"Teal and orange"`,
`"Pastel"`, `"Bleach bypass"`, `"Mono"`, `"Cool night"`. Retired but still read: `"Faded"`.
Any other string is treated as a `.cube` path. The colour maths (GradeRecipe, LookMath, the 32³ baked cube) belongs
to the colour/compositor spec. Order of operations: look blended by intensity, then user adjustments.

### 2.13 `MediaAsset` (synthesized)
| Field | Type | Default | Notes |
|---|---|---|---|
| id | UUID | new | req. The id is kept when relinking or replacing a file. |
| path | String | — | req. Absolute, standardized path of the original file. |
| relativePath | String? | nil | Written on save (§1.4). Used to find the file if the project folder moved. |
| playablePath | String? | nil | A converted copy (via ffmpeg) when AVFoundation can't decode the original. Playback reads `playablePath ?? path`. Machine-specific cache path. |
| name | String | file name without extension | req. Display name. A rename on disk updates it only if it still equals the old file stem. |
| kind | MediaKind | — | req. `"video"`, `"audio"`, `"image"`. |
| duration | Double | — | req. Seconds. **0 for images.** For video it is the video track's end time; for audio-only files, the audio end. |
| width, height | Int | — | req. Display size after rotation (pixel size with EXIF orientation ≥5 swapped for images). 0 for audio. |
| fps | Double | — | req. Nominal frame rate. 0 for images. Audio files: whatever was probed (**UNSURE**, probably 0). |
| hasAudio | Bool | — | req |
| bookmark | Data? | nil | A macOS minimal bookmark (base64). **PromptEdit should preserve it unchanged but cannot resolve it.** |

### 2.14 `Marker`
| Field | Type | Default | Notes |
|---|---|---|---|
| id | UUID | new | req |
| time | Double | — | req. Seconds, frame-snapped by the UI. |
| name | String | "Marker N" | req |
| tint | Tint | `"yellow"` | req (synthesized). One of `white` #EDEDEA, `yellow` #F2B33D, `green` #6CC08B, `blue` #5B9BF0, `purple` #B07CF0, `red` #F0503C. |

### 2.15 `MagicHistory.Entry`
`text: String` (trimmed, unique in the list), `tab: String` (`"claude"`, `"chatgpt"` or `"local"`, a MagicAgent tab
raw value), `date: Date` (§1.2). All required. `id` is computed from text and not encoded.
Adding a prompt: trim it, ignore it if empty, remove any existing entry with the same text, insert at index 0, and
keep the first 20. **This is not an undoable edit**, and undo/redo never changes it.

### 2.16 `CaptionTrack` / `CaptionStyle` / `CaptionFix`
`CaptionTrack` (synthesized, both keys required): `hidden: Bool = false`, `style: CaptionStyle`.

`CaptionStyle` (**custom decoder: every key optional**, with these defaults):
| Field | Type | Default | Units |
|---|---|---|---|
| size | Double | 64 | Points relative to a 1080 px frame's **shorter side**. Range 28…140, whole numbers. |
| y | Double | 0.78 | Middle of the captions as a fraction down the frame. UI 0.10…0.95, rounded to 0.001. |
| highlight | Bool | true | The word currently being said is highlighted. |
| textColor | RGBA | white | |
| highlightColor | RGBA | (1, 0.84, 0.25, 1) | |
| outline | Bool | true | |
| outlineColor | RGBA | black | |

`CaptionFix` (synthesized): `start: Double` (req; the word's start time **in the file**, which identifies the
word, matched within 0.0005 s), `text: String` (req; `""` means the word is left out), `merged: Bool?` (true =
joined to the previous word, which takes over this word's time).

Captions themselves are **not stored**. They are computed from each captioned clip's file transcript and the
fixes (§3.20).

### 2.17 `MediaFolder`
| Field | Type | Notes |
|---|---|---|
| id | UUID | req |
| path | String | req. Absolute folder path. |
| relativePath | String? | Written on save. |
| bookmark | Data? | macOS bookmark (base64). |

`name` is the last path component (computed). `contains(folder, path)` is true when `path == folder` or path starts
with `folder + "/"`. Sub-folders are not stored; the Media panel's tree is derived from asset paths under each
linked folder. Media extensions accepted by a folder scan: anything conforming to movie, video, audio, image or
audiovisual content, plus `mkv webm avi flv wmv mts m2ts ts mxf ogv ogg opus flac 3gp mpg mpeg vob f4v`. Hidden
files and package contents are skipped. Results are sorted with Finder-like natural ordering.

### 2.18 Migration / compatibility logic (complete list found)
1. A `.cutplay` extension is accepted when reading.
2. `Track`: `hidden`, `muted`, `gainDB`, `solo`, `locked`, `duckUnder` and `duckDB` may be missing (older files).
3. `CaptionStyle`: every field may be missing.
4. Every `Project` field added later is optional (`markers`, `inPoint`, `outPoint`, `magicHistory`, `captions`,
   `captionFixes`, `folders`, `hiddenMedia`, `exportName`, `exportDir`).
5. Legacy reversed clips (`reversedFrom` set, pointing at a reversed copy of the file): they count as reversed.
   Reversing one again restores `assetID`/`sourceStart` from `reversedFrom` and clears it (§3.11).
6. On load, a bookmark is created for any asset or folder without one (only if the file is where the path says).
7. On load, `playablePath` copies that are missing or stale are made again and the paths updated.
8. The retired look name `"Faded"` still renders.
9. Moved projects: assets and folders are found through `relativePath` (§1.4).

---

## 3. Editing operations

### 3.0 Common primitives (Project methods)

**`trimHead(to t)`** (Clip): `d = t − start`; `newSource = sourceTime(at: t)`; `start = t`; `duration −= d`; if
`playsSource` then `sourceStart = max(0, newSource)`; `clampFades()`; `transform.zoom.shift(by: d, length: duration)`.
Freeze, image, solid and text clips keep their `sourceStart`.

**`trimTail(to t)`** (Clip): `duration = t − start`; `clampFades()`; `zoom.fit(length: duration)`.

**`sanitize()`**, run after the body of every `mutate` (but not after `live`):
remove clips whose `trackID` is not a current track, or whose `duration ≤ 1e-6`. For each clip:
`start = max(0, start)`, `clampFades()`, `zoom.fit(duration)`. If `captions != nil` and no clip has
`captioned == true`, set `captions = nil` and `captionFixes = nil`.

**`resolveOverlaps(keeping ids)`**, the overwrite edit (the given clips win). `eps = 1e-6`. For each kept clip m,
in `clips` order, rebuild `clips`. For every clip c that is not kept, on m's track, and overlapping
(`c.end > m.start + eps && c.start < m.end − eps`):
- If c sticks out on both sides (`c.start < m.start − eps && c.end > m.end + eps`), split it. The right piece is a
  copy with a new id, `linkID = nil`, `fadeIn = 0`, and `trimHead(to: m.end)`; it keeps the original's
  `transitionIn`. The left piece gets `fadeOut = 0` and `trimTail(to: m.start)`. If c had a link, remember
  `rights[right.id] = (c.linkID, m.start, m.end)`.
- If only the head sticks out: `trimTail(to: m.start)` (fades are clamped, not reset).
- If only the tail sticks out: `trimHead(to: m.end)`.
- If c is fully covered, remove it.

Afterwards, group the right pieces by key `"\(link)|\(round(from·1000))|\(round(to·1000))"`. A group with more than
one piece **and** pieces on both track kinds (video and audio) gets a fresh shared `linkID`. Otherwise its pieces
stay unlinked. Kept clips that overlap each other are left as they are.

**`split(ids, at t)` → ids of new right pieces.** `minDur = 0.5/fps`. For each id, skip unless
`c.start + minDur < t < c.end − minDur`. The right piece is a copy of c with a new id, `fadeIn = 0`, and
`trimHead(to: t)`. Linked clips get one new link id per original `linkID` (`linkMap`), so split partners stay linked
to each other while the left pieces keep the old link. The left piece gets `fadeOut = 0` and `trimTail(to: t)`. The
right piece is **appended** to `clips`. Note: the right piece keeps a copy of `transitionIn`, `grade`, `transform`
(zoom shifted), `ramp`, `captioned`, `reversed` and `freeze`. (Copying `transitionIn` means the new cut can get a
transition if the original had one. That is what the code does; **UNSURE** whether it was intended. Port it as is
for parity.)

**`remove(ids, ripple)`**: take the removed clips sorted by `start` **descending**, then remove all of them. If
ripple: for each removed r (in that descending order), every remaining clip on `r.trackID` with
`start ≥ r.end − 1e-6` gets `start = max(0, start − r.duration)`. Ripple happens per track only. Linked partners
ripple their own tracks because they are removed too.

**`rippleRemove(from a, to b, tracks)`**: drop locked tracks. `gap = b − a`; return if `gap ≤ 1e-9`. Split the
clips on those tracks that cross a, at a. Then split those crossing b, at b. `eps = 0.5/fps`. Remove clips on those
tracks with `start ≥ a − eps && end ≤ b + eps`. Clips on those tracks with `start ≥ b − eps` get
`start = max(0, start − gap)`.

**`fits(changed)`**: false if any changed clip has `start < −1e-9`. Otherwise, apply the changes, sort each track's
clips by start, and check adjacent pairs where at least one clip changed: `a.end > b.start + 1e-6` means it does
not fit.

**`pullLeft(on track, from time, by amount)` → distance moved.** Return 0 if the track is locked or
`amount ≤ 1e-9`. Movers = `unlocked(linked(clips on track with start ≥ time − 1e-6))`. If moving them all left by
`amount` doesn't fit, binary-search 30 iterations between 0 and amount for the largest `ok` that fits. Then use
`d = snapFrame(ok)` if `snapFrame(ok) ≤ ok + 1e-9`, else `ok`, and fall back to `ok` if that doesn't fit. Apply if
`d > 1e-9`. Linked partners on other tracks move too, so a clip in the way on another track limits the move.

**`carried(by edited)`** (sticky edges): `touch = 0.5/fps`. Queue `(track, oldEnd, newEnd)` for each edited clip
(old values from the current project). Pop entries in FIFO order. Let `shift = newEnd − oldEnd`; skip if
`|shift| ≤ 1e-9` or the track is locked. `after` = clips on that track that are not edited and have
`start ≥ oldEnd − touch`. `nearest = min(after.start)`. For each c in `after` with `start ≤ nearest + 1e-9` that is
not already carried: `touching = |c.start − oldEnd| ≤ touch`, `runInto = shift > 0 && c.start < newEnd − 1e-9`.
Skip c unless one of them is true. Then `s = newEnd − c.start`, so the carried clip **butts exactly onto the new
end**. Every clip in `linked([c.id])` that is not edited and not yet carried gets `start += s`, is recorded in the
output, and is queued with its own (track, oldEnd, newEnd). The result contains only carried clips.

**`materializeTokens()`**: the first clip on `TrackToken.newVideo` creates one new video track, appended (the new
top track), and every token clip goes onto it. The same for audio (new bottom audio track).

**`addTrack(kind)`** appends a new track: the top video track, or the bottom audio track.
**`removeTrack(id)`** works only if more than one track of that kind remains; it deletes the track **and its clips**.

**`freeTrack(kind, start, duration)`**: the first unlocked track of the kind in array order (video bottom-up, audio
top-down) with no clip overlapping `(start, start+duration)` (eps 1e-6).

**`firstFreeVideoSpot(from time, duration)`**: for each unlocked video track, the candidate starts are `[time]` plus
every clip end on that track that is after `time`, sorted. Take the first candidate where a clip of that length fits
(eps 1e-6). Over all tracks, pick the earliest start; on a tie the lower track wins (strict `<` with 1e-9 tolerance).

**`fitClips(toMedia ids)`** (after a file got shorter): for playsSource clips of those assets that reach past
`limit = asset.duration` (`sourceStart + sourceLength > limit + 1e-4`): if `sourceStart ≥ limit − 1e-3` the clip is
removed. Otherwise binary-search 40 iterations over [start, end] for the timeline time where
`sourceTime < limit`, and `trimTail` there.

**`cropped(to range)`** (used for "export range only"): split all clips at `range.start`, then at `range.end`;
remove clips with `end ≤ start+1e-6` or `start ≥ end−1e-6`; shift everything by `−range.start`; keep the markers
inside the range, shifted; clear in/out.

### 3.1 Clip time ↔ source time (no ramp)
`sourceTime(t) = sourceStart + (t − start) · speed`. This is valid for any t, including outside the clip.
`sourceLength = duration · speed`. `timelineSpan(s0, s1) = (s1 − s0) / speed`.
Freeze clips: the renderer uses speed 0 and no ramp (`SourceClock`), so the source is always `sourceStart`.
Non-playsSource clips ignore the ramp (`sourceTime` uses the ramp only when `playsSource`).

### 3.2 Speed ramp maths
- `speed(at s, mid)`:
  - if `s < inTo`: return `startSpeed` if `s ≤ inFrom`, else `blend(startSpeed, mid, (s−inFrom)/(inTo−inFrom))`;
  - else if `s > outFrom`: return `endSpeed` if `s ≥ outTo`, else `blend(mid, endSpeed, (s−outFrom)/(outTo−outFrom))`;
  - else `mid`.
- `blend(a, b, u) = exp(ln a + (ln b − ln a) · e)` with `e = u²(3−2u)`. **The smoothstep is applied in log-speed.**
- `span(s0, s1, mid)`, the timeline seconds needed to play footage s0→s1: negative if s1 < s0. Walk the marks
  `[inFrom, inTo, outFrom, outTo, s1]` that are greater than the current point. For each piece `[a, b]`, if speed is
  constant (|va−vb| and |va−vm| < 1e-12, where vm is the speed at the midpoint), the piece takes `(b−a)/va`.
  Otherwise use **Simpson's rule with n = 24**:
  `h=(b−a)/24; sum = 1/va + 1/vb + Σ_{i=1..23} (i even ? 2 : 4)/v(a+i·h); piece = sum·h/3`.
- `source(from s0, after dt, mid)`, the footage reached after dt timeline seconds: if `|dt| < 1e-12` return s0. Walk
  the marks in the direction of dt (marks `> s0` ascending, or `< s0` descending). For each mark m,
  `t = |span(a, m)|`. If `t ≥ left`, solve inside this stretch by **bisection, 40 iterations** on the fraction
  `f ∈ [0,1]` with `|span(a, a+(m−a)f)| < left`, and return `a + (m−a)·(lo+hi)/2`. Otherwise subtract t and continue
  from m. Past every mark the speed is constant: `v = speed(a ± 1e-9)`, result `a ± left·v`.
- With a ramp, `Clip.sourceTime(t) = ramp.source(from: sourceStart, after: t − start, mid: speed)`,
  `sourceLength = sourceTime(end) − sourceStart`, and `timelineSpan(s0,s1) = ramp.span(s0,s1,mid: speed)`.
- `speedRange` = (min, max) of `{startSpeed, speed, endSpeed}`. The audio renderer drops audio clips whose range goes
  outside [1/32, 32] (engine rule, noted here for completeness).
- `shifted(by d)` adds d to all four marks. `mirrored(length L)`:
  `inFrom' = L−outTo, inTo' = L−outFrom, outFrom' = L−inTo, outTo' = L−inFrom`, with start and end speeds swapped.
- **`SpeedRamp.drawn(s0, s1, points (p1,p2,p3,p4), start, end, mid)`**: with `L = s1 − s0`, `hasIn = p2−p1 > 0.001`
  and `hasOut = p4−p3 > 0.001`, return nil if neither is true or `L ≤ 0`. `at(f) = s0 + L·clamp01(f)`.
  `inFrom = hasIn ? at(p1) : s0`, `inTo = hasIn ? at(p2) : s0`,
  `outFrom = hasOut ? max(inTo, at(p3)) : s1`, `outTo = hasOut ? max(inTo, at(p4)) : s1`,
  `startSpeed = hasIn ? start : mid`, `endSpeed = hasOut ? end : mid`.

### 3.3 Retime (speed / ramp changes keep the footage; the length follows)
`Clip.retime(snap, minimum, change)`: if not playsSource, apply `change` and stop. Otherwise
`s0 = sourceStart`, `length = sourceLength` (before the change), apply `change`,
`duration = max(snapFrame(timelineSpan(s0, s0+length)), 1/fps)`, `clampFades()`.
`sourceStart` is unchanged and the clip's start stays put.

`Project.retime(ids, sticky, change)`:
- **Non-sticky:** for each track (all video tracks, then all audio tracks) that holds a changed playsSource clip,
  walk the track's clips sorted by start with `shift = 0` and `prevEnd = 0`. A changed playsSource clip is retimed,
  then `start += shift` and `shift += newDuration − oldDuration`. Any other changed clip gets `start += shift`.
  **Every** clip then gets `start = max(start, prevEnd)` and sets `prevEnd = end`. So changed clips stay butted to
  each other; unchanged clips are not pulled left when the changed ones shrink (a gap opens), but are pushed right if
  they would be overlapped.
- **Sticky:** run the non-sticky retime on a copy and take only the edited clips' new states. Compute `carried(by:)`
  on the original project, and write back only the edited and carried clips. Nothing else is pushed.

`setSpeed(ids, speed, sticky)`: clamp speed to `[0.05, 100]`, then `retime { $0.speed = speed }`. **A ramp, if any,
is kept**; only its middle speed changes.
`setRamp(ids, speed, points, start, end, sticky)`: clamp all speeds to [0.05, 100], then retime each clip with
`speed = mid` and `ramp = SpeedRamp.drawn(s0 = sourceStart, s1 = sourceStart + sourceLength, points, start, end, mid)`,
using that clip's own footage. A nil result removes the ramp.
EditorModel entry points use `linked(selection)` and `model.sticky`:
- `setSpeed(_:)`. The context-menu presets are 25, 50, 100, 200, 400, 800, 1600 and 3000 %. The inspector slider is
  10–5000 %, logarithmic, and is always recomputed from the clips as they were when the drag began.
- `resetPlayback(volume:)`: `speed = 1`, `ramp = nil` through retime, and gainDB 0 on the given clips. One step.
- Ramp toggle on: `mid = |speed−1| < 0.001 ? 0.5 : speed`. Points are (0.3, 0.6, 1.0, 1.0) for mode `in`, or
  (0.3, 0.4, 0.6, 0.7) for `inOut`; start = end = 1. Toggle off: `retime { ramp = nil }`.
- The ramp graph's speed axis is 0.1…10.

### 3.4 Snapping (UI gesture layer)
- Snapping is active when `model.snapping XOR (⌘ held)`. Snapping defaults to on and the S key toggles it.
- `snap(candidates, targets, pixels)`: `threshold = pixels / pps` (pixels per second). Return the (delta, target)
  with the smallest |delta| over all candidate/target pairs with `|delta| ≤ threshold`.
- Pixel thresholds: clip move, trim and Media drop = **8 px**. Playhead scrub, marker drag, in/out edge drag and the
  cut-tool position = **6 px**.
- Targets: `snapTargets(excluding: draggedIDs)`, plus the playhead for every drag except the playhead scrub itself.
  Marker drags exclude that marker's own time.
- With no snap the value is frame-snapped instead (`snapFrame`).

### 3.5 Selection rules
- Clicking a clip body selects its unlocked linked group, unless the clip is already selected. Shift-click toggles
  the whole group.
- Clicking empty space clears the selection (unless Shift is held) and starts a marquee. The marquee selects
  `unlocked(linked(base ∪ clips intersecting the box))`. A box touching no clips but touching captions selects
  captions instead.
- Clips on locked tracks are never hit.
- `selectAll` selects every clip, including clips on locked tracks.
- Selecting clips clears the caption selection and Media picks. After any change, ids of clips that no longer exist
  are dropped from the selection.

### 3.6 Move (drag a clip body)
A drag starts after the pointer moves more than 3 px in x or y. Dragged set = `originals = unlocked(linked(selection))`.
1. `dt = max(time(x) − grabTime, −minStart)`, where minStart is the earliest start among originals.
2. Candidates are each original's start+dt and end+dt. If a snap is found and `minStart + dt + delta ≥ −1e-9`, apply
   it and show the snap line. Otherwise `dt = max(snapFrame(grabbed.start + dt) − grabbed.start, −minStart)`.
3. Track change: the grabbed clip's kind (video or audio) gives `trackDelta = hoveredTrackIndex − grabbedIndex`.
   Hovering the "new track" zone gives `tracks.count − grabbedIndex`. Clamp so every original of that kind stays in
   `[0, tracks.count]`; an index equal to count means a new track. If any target track is locked, keep the previous
   delta.
4. Partners of the other kind (linked to a moved clip) move by the same delta **only if** each one sits on the
   matching index of its own kind (V2 ↔ A2), and **only if** the destination track is unlocked and free over the new
   time range. Clips there that are linked to something the dragged clips overwrite on their own kind do not count as
   occupying it. A destination index ≥ count becomes a new-track token. Otherwise the partner stays on its track
   (and still moves in time).
5. Every original gets `start = max(0, start + dt)`.
6. While dragging, nothing is written into the project; the new positions are display-only overrides.
   **Mouse-up does one `mutate`**: write the overrides, `materializeTokens()`, and
   `resolveOverlaps(keeping: moved ids)`. The move is an overwrite edit.
7. **⌥ held at mouse-up (duplicate drag)**: the originals stay where they were. Copies are made with `placed()`
   (new ids, consistent new link ids), placed at the dropped times and tracks, and added with `insert()`
   (overwrite).

### 3.7 Trim (drag a clip edge)
- Edge hit zone: `min(7, max(2, width/4))` px from either end.
- Trimmed set = `unlocked(linked(selection ∪ grabbed group))`. **Every trimmed clip's same edge moves by the same
  delta d**, on any track.
- `edge = grabbed.start` (left) or `grabbed.end` (right). `d = time(x) − grabTime`. Snap `edge+d` (8 px) or
  frame-snap it.
- **Non-sticky trim** (sticky off, or a left edge that isn't attached): the limits are the intersection of
  `trimLimits(c, left, excluding: trimmed)` over all trimmed clips. Clamp with `d = clamp(d, lo, max(lo, hi))`.
  Apply `trimHead(to: start+d)` or `trimTail(to: end+d)`.
  `trimLimits`, with `minDur = max(1/60, 1/fps)` and only the other clips on the same track considered:
  - Left: `prevEnd = max end of clips ending ≤ c.start+1e-6` (default 0). `lo = prevEnd − c.start`. For a
    playsSource clip, `lo = max(lo, −timelineSpan(0, sourceStart))`. `hi = duration − minDur`. Range `min(lo,hi)…hi`.
  - Right: `nextStart = min start of clips starting ≥ c.end−1e-6` (default ∞). `hi = nextStart − c.end`. If there is
    a source limit (playsSource and an asset), `hi = min(hi, timelineSpan(sourceStart, asset.duration) − duration)`.
    `lo = minDur − duration`. Range `lo…max(lo,hi)`.
  - Images, solids, text and freeze frames have no source limit.
- **Sticky trim** is used when sticky edges are on and (it is the right edge, or `attachedOnLeft`).
  `attachedOnLeft` means some trimmed clip has `start ≤ 0.5/fps`, or another clip on its track ends within 0.5/fps of
  its start. Only the clip's own media and minimum length limit the trim:
  left `lo = −timelineSpan(0, sourceStart)` (playsSource), `hi = duration − minDur`;
  right `lo = minDur − duration`, `hi = timelineSpan(sourceStart, limit) − duration`.
  A **left sticky trim keeps the clip's start**: it calls `trimHead`, then restores `start`, so content comes off the
  front and the end moves by −d. The edited clips are merged with `carried(by: edited)`. If the result doesn't
  `fits`, binary-search 24 iterations over [0, d] for the largest delta that fits.
- During the drag the viewer shows the frame at the new edge (an engine detail). The edit is committed on mouse-up
  with the same one-step `mutate` as a move (overrides, then `materializeTokens`, then `resolveOverlaps`).

### 3.8 Fades, clip gain (timeline handles and inspector)
- Fade handles show only when a fade is already set (> 0) and the clip is wider than 36 px. They sit in the top
  17 px, with a hit radius of 7 px. When the two dots overlap, the longer fade wins; with equal fades, the side
  clicked decides.
- Fade-in drag: `fadeIn = min(max(0, snapFrame(t − start)), duration − fadeOut)`.
  Fade-out drag: `fadeOut = min(max(0, snapFrame(end − t)), duration − fadeIn)`. These are live edits, committed on
  mouse-up.
- Inspector fades: range `0…max(0.1, min(duration, 10))`, values `min(snapFrame(v), duration − otherFade)`, applied
  to every selected visual clip (or audio clip). The curve menu sets `fadeInCurve`/`fadeOutCurve` (one step).
- The context menu "Remove Fades" sets fadeIn = fadeOut = 0 on every selected clip.
- Audio clip gain line, dragged vertically: `norm(db) = db ≥ 0 ? 0.3 − db/12·0.2 : 0.3 + (−db/60)·0.62`. The inverse
  clamps norm to 0.1…0.92 and rounds to 0.1 dB; a result ≤ −59.5 is stored as −60. Double-clicking the line sets
  0 dB (one step). The inspector volume is −60…+12, rounded to 0.1, applied to every selected audio clip.
- `dbToLinear(db) = db ≤ −59.5 ? 0 : 10^(db/20)`.

### 3.9 Split / blade
- **Split at Playhead (⌘K)**: `t = playhead`. `under` = clips with `start < t < end`. Targets =
  `unlocked(linked(selected ∩ under, or all of under if none of them is selected))`. `split(targets, t)` in one step.
- **Cut tool (C)**: hovering a clip gives `t` snapped at 6 px (targets exclude that clip; the playhead is included),
  else frame-snapped. It is valid only if `start + 0.5/fps < t < end − 0.5/fps`. A click runs
  `split(linked([clip]), t)`.
- `split(clip:at:)` (EditorModel) always splits the clip's linked group.

### 3.10 Delete / ripple delete / cut / ripple trim
- **Delete** (⌫ / ⌦): if Media items are picked, they are removed from the project instead (§3.19). If no clips are
  selected but captions are, the captions' words are left out (§3.20). Otherwise
  `remove(unlocked(linked(selection)), ripple: false)`.
- **Ripple Delete** (⇧⌫): the same with `ripple: true` (per-track ripple, §3.0).
- **Cut (⌘X)**: copy, then delete (one undo step; copying is not an edit).
- **Ripple Trim Start / End (Q / W)**: pause if playing. `under` = clips with `start < t < end` on unlocked tracks.
  If any of them are selected, the tracks are those of `linked(selected)`; otherwise every track. `edges` = `under`
  clips on those tracks. Head: range = `(max(edges.start), t)`. Tail: range = `(t, min(edges.end))`. Require
  `range length ≥ 0.5/fps`. Run `rippleRemove(range, unlocked tracks)` in one step. After a head trim,
  `seek(to: range.start)`. Resume playing if it was playing.

### 3.11 Reverse (⌥R)
Target: the first selected clip (in `clips` order) that is playsSource on an unlocked track. Group =
`unlocked(linked([c]))`.
- **Legacy** (`c.reversedFrom != nil`): for each group clip with `reversedFrom`, set `assetID = from.assetID`,
  `sourceStart = from.sourceStart`, `reversedFrom = nil`. One step.
- **Otherwise**: `backwards = !c.playsBackwards`. For each group clip that is playsSource with no `reversedFrom` and
  whose asset has a duration L:
  `sourceStart = max(0, L − (sourceStart + sourceLength))`, `ramp = ramp?.mirrored(length: L)`,
  `reversed = backwards ? true : nil`. Duration, fades and transitions are unchanged. Partners are set to the same
  state as c, not toggled independently. One step. When reversing, the reversed audio is prepared in the background.
- **Reversed coordinate**: for a reversed clip, the source time `s` from §3.1/§3.2 corresponds to file time `L − s`.
  The compositor shows the frame just before `L − clock.source(t − 1e-4)`. Trims, splits and retimes work on `s`
  exactly as for forward clips.

### 3.12 Freeze frame (⌥F)
Target: a selected **video** clip that is not a freeze, on an unlocked track, with `start ≤ t < end`, where
`t = snapFrame(playhead)`. Hold = 2 s.
1. `source = c.sourceTime(t)`. If the clip plays backwards, `source = max(0, L − source − 0.001)`, converted to
   forward file time because the freeze clip is not reversed.
2. In one step: `group = linked([c])`; `split(group, t)`; `tracks` = the group's tracks; `shifting` =
   `unlocked(linked(clips on those tracks with start ≥ t − 1e-6))`; each gets `start += 2`.
3. A new clip: `kind video`, the same track and asset, `start = t`, `duration = 2`, `sourceStart = source`,
   `freeze = true`, `grade` and `transform` copied from c. Everything else is default (speed 1, gain 0, no fades,
   no link). Append it, then `resolveOverlaps(keeping: shifting ∪ {freeze})`. The freeze clip becomes the selection.
   The linked audio track gets 2 s of silence (its later clips were shifted).
4. If `t == c.start`, no split happens; c itself shifts and the freeze goes in before it.

### 3.13 Transitions (overlap rules)
Stored as `transitionIn` on the **incoming** clip b. It only takes effect when
`previous(touching: b)` exists: a non-audio clip a on the same track, `a.id ≠ b.id`, with `|a.end − b.start| ≤ 0.5/fps`
(the first one found in `clips` order). `next(touching:)` is the mirror case. **Clips never overlap on the timeline
because of a transition.** Instead, one clip is drawn for longer using its unused media (handles).

`headRoom(b) = b.playsSource ? b.timelineSpan(0, b.sourceStart) : ∞`.
`tailRoom(a) = a.playsSource && asset ? max(0, a.timelineSpan(a.sourceStart + a.sourceLength, L)) : ∞`.

`transitionSpan(a → b)`, with `cut = b.start` and `frame = 1/fps`:
- **dipToBlack**: `d = min(T, 2·a.duration, 2·b.duration)`. If `d ≥ frame`, the span is `(cut − d/2, cut + d/2)`
  with fromHead = false; otherwise nil.
- **dissolve / wipe**: `want = min(T, a.duration, b.duration)`.
  If `headRoom(b) ≥ want`, the span is `(cut − want, cut)` with fromHead = true.
  Otherwise, if `tailRoom(a) ≥ want`, it is `(cut, cut + want)` with fromHead = false.
  Otherwise `d = max(head, tail)`; return nil if `d < frame`; else
  `head ≥ tail ? (cut − d, cut, true) : (cut, cut + d, false)`.
  The inspector says "Shortened to X s: no more media beyond the cut." when the span is shorter than `T − 0.01`,
  or "Needs media beyond the cut to blend; try Dip to Black." when it is nil.

`transitionPlan(c)` (non-audio only):
- **Incoming side** (c has a previous clip and a span):
  - dip: `reveal = (c.start … span.end)`.
  - dissolve/wipe: `reveal = (span.start … span.end)`, and if fromHead, `leadIn = c.start − span.start`. c is drawn
    from `span.start`, with source taken from before its in point: `shown.start = start − leadIn` and
    `shown.sourceStart = sourceTime(shown.start)`.
- **Outgoing side** (c has a next clip b with a span):
  - dip: `conceal = (span.start … c.end)`.
  - dissolve/wipe with fromHead = false: `tailOut = span.end − c.end` (c is drawn past its end).

Renderer use: a layer is drawn over `[start − leadIn, end + tailOut)`.
`opacity = fades × (reveal && kind ≠ wipe ? progress : 1) × (conceal ? 1 − progress : 1)`, where
`progress = clamp01((t − s)/max(1e-6, e − s))`. A **wipe** instead crops the incoming layer to the left `W·w` of the
frame, with `w = smoothstep(progress)`, revealing it from left to right. A dissolve fades the incoming clip in over
an outgoing clip at full opacity (on the same track, later clips are drawn above earlier ones). A dip fades the
outgoing clip out, then the incoming clip in. What shows through is whatever is underneath (lower tracks, or black).
Audio clips never get transitions.

Operations:
- `setTransition(into id, t?)` sets or clears it (one step). The menu or inspector can pick a kind; a new
  transition starts as dissolve, 0.5 s.
- **Add Dissolve (⌘D)**: candidates are non-audio clips on unlocked tracks that have a previous touching clip, and
  where the clip itself or its previous clip is selected. Choose the one whose `start` is closest to the playhead.
  Set `transitionIn ?? Transition()`. Nothing happens if there is no candidate.

### 3.14 Insert / add clips
- `payloadDuration`: for an asset that is not an image, `max(1/fps, floor(duration·fps + 1e-6)/fps)`. Images,
  solids and text get **5 s**.
- `makeClips(payload, start, vTrack, aTrack)`:
  - Solid: a solid clip on vTrack (default colour).
  - Text: a text clip (default TextStyle).
  - Image: an image clip.
  - Audio asset: an audio clip on aTrack.
  - Video asset: a video clip, plus an audio clip on aTrack sharing a **new linkID** if `hasAudio`.
  - All have `sourceStart = 0` and `speed = 1`.
- `insert(clips)`: one step: append, `materializeTokens`, `resolveOverlaps(keeping: new ids)`. Then
  `selection = new ids`.
- **Add at playhead** (double-click or "Add to Timeline" in Media, ⌘T for text):
  - text/solid: at `firstFreeVideoSpot(from: playhead, dur)` on that track (with the first audio track as aTrack),
    or else at the playhead on a new video track. Text and solids never cover anything.
  - media: at the playhead on `freeTrack(video)` and `freeTrack(audio)`, falling back to new-track tokens.
- **Drop from Media onto the timeline**: the lane under the pointer picks the tracks. Over a video track index i,
  aTrack is audio index `min(i, count−1)`, and the mirror case over audio. The new-track zones use tokens. A locked
  track is replaced by the first unlocked track of its kind, or a token. `start = 0` if the pointer is over the
  headers, else `time(x)`. Snap (8 px) the run's start or end, and accept only if `start+delta ≥ −1e-9`; else
  frame-snap. Several payloads go end to end, each next start = `snapFrame(prev + payloadDuration)`. Then insert
  (overwrite). Dropping files from Finder imports them first, then lays them end to end from the drop point
  (`t += payloadDuration`, not frame-snapped). Locked tracks are never written to.

### 3.15 Copy / paste / duplicate
- `selectedForCopy = clips in unlocked(linked(selection))`.
- **Copy (⌘C)**: `clipboard` = those clips with times relative to their earliest start. Stored in memory only.
- **Paste (⌘V)**: `placed(clipboard, at: playhead)` gives fresh ids and fresh link ids (consistent across the
  pasted set). Track ids are kept; a track that is gone or locked is replaced by the first unlocked track of the kind
  or a token. Then `insert` (an **overwrite**, like Premiere) and `seek(to: max end of pasted)`.
- **Duplicate (⇧⌘D)**: `placed(selection relative to t0, at: t1 = max end)` on the same tracks, then `insert`.

### 3.16 Detach audio / link
- **Detach Audio (⇧⌘L)**: `unlink(selection)`, which sets `linkID = nil` on the selection's whole linked group. One
  step. Enabled when a selected clip has a linkID.
- There is no explicit re-link operation. New links come only from makeClips, split, resolveOverlaps and copies.

### 3.17 Gaps
- `gap(on track, at t)`: nil if t is on a clip. Otherwise `before = max end ≤ t + 1e-9` (or 0) and
  `after = min start ≥ t − 1e-9`. The result is nil if there is no `after` or `after − before ≤ 1e-6`. A gap after the
  last clip doesn't count.
- **Delete Gap** (context menu on empty track space): `pullLeft(track, from: gap.end, by: gap.length)`.
- **Close All Gaps**: on the given tracks, else the selected clips' tracks, else all tracks. In one step, for each
  track, repeat up to 500 times: sort by start, find the first i with `next.start − here[i].end > 1e-6`, and
  `pullLeft(from: next.start, by: that gap)`. Stop when there is none or nothing moved. The gap before the first clip
  is **not** closed.

### 3.18 Track operations
- Add Video/Audio Track: append (one step).
- Delete Track: only if more than one track of that kind remains; its clips go too (one step).
- Toggles, each one step through `updateTrack`: `hidden` (video "eye"), `muted` (M), `solo` (S), `locked` (lock).
- Track gain pill: live edits, −60…+12, rounded to 0.1, committed at the end of the drag.
- Duck Under: `duck(track, under: otherAudioTrack?, amount?)` sets `duckUnder` and, if given, `duckDB`. One step.
  Track labels are V1…Vn and A1…An by array index + 1.
- **Even Out Levels** (audio context menu): applies to the selected audio clips, or all audio clips when none are
  selected, excluding locked tracks. For each clip with a waveform, `level = 10·log10(mean(p²))` over the waveform
  peaks > 0.003 in its source range. The gain is `round1(−20 − level)`, clamped −24…+12. One step. (`matchOutput`
  mode, used elsewhere: the target is the median of `level + clipGain + trackGain`, the gain is
  `min(target − level − track, −1 − peak − track)`.)

### 3.19 Sequence settings and media library edits
- `setSequence(width,height)`: one step, `settingsLocked = true`. Presets: 3840×2160, 2560×1440, 1920×1080,
  1280×720, 1080×1920, 2160×3840, 1080×1080. Custom values are made even and clamped to 16…8192.
- `setFPS(fps)`: one step, `settingsLocked = true`. **Clips are not moved or re-snapped when the frame rate changes.**
- `matchSequence(to asset)`: width, height, and `fps = standardFPS(asset.fps)` (the nearest entry in the rate list;
  `fps ≤ 1` gives 30), with `settingsLocked = true`. One step.
- First video import while `!settingsLocked`: set `settingsLocked = true` **directly (not undoable)**. If the size or
  rate differs, ask "Match the sequence to “name”?"; Match is one undoable step.
- `removeAssets(ids, folders)`: removes items, plus the clips that use them, in **one step** (after a confirmation if
  clips use them). Removed files inside linked folders, and removed sub-folders, are added to `hiddenMedia` so they
  don't come back on the next folder sync. Removing a linked folder root drops it from `folders`. Ends with
  `pruneFolders`: linked folders with no assets left are dropped, and hidden entries outside the remaining folders
  are dropped.
- Not undoable (written into the project directly, marked dirty): importing assets, folder linking, sync/relink/
  reload changing asset paths or metadata, `adoptReplacements`, `addMagicPrompt`, `setExportTarget`, held-media
  repointing. `reloadMedia` and `adoptReplacements` then run `fitClips(toMedia:)` as an undoable step. **`relink`
  (Locate…) clears the whole undo and redo history**, because the snapshots hold old paths.

### 3.20 Markers, in/out, captions, text, solids, transform, grade
- **Add Marker (M)**: `t = snapFrame(playhead)`. If a marker is within `0.5/fps`, open its editor; otherwise add
  `Marker(time: t, name: "Marker \(count+1)", tint: .yellow)` (one step).
- Marker drag: snapped at 6 px or frame-snapped, never < 0; one step per drag (live). Rename: live with auto-commit,
  so typing becomes one step per 0.8 s pause. `updateMarker` (tint and others): one step. Delete removes the marker,
  and `markers = nil` when the list becomes empty. Clear Markers: one step.
- **Set In (I)**: `inPoint = snapFrame(playhead)`; if `outPoint ≤ in`, the out point is cleared. **Set Out (O)**:
  `outPoint = snapFrame(playhead)`; if `inPoint ≥ out`, the in point is cleared. **Clear (⇧X)**: both nil. Dragging
  a range edge is live, snapped, with no ordering check (`playRange` sorts the two).
- **Captions**: `addCaptions(ids?)`. If nothing is picked, or everything is, the targets are
  `defaultCaptionTargets` (audio clips whose asset is a video, plus audio clips on any track that another track
  ducks under). Otherwise `captionTargets(picked)` = audio, playsSource clips in `linked(picked)`. Locked clips are
  excluded. This sets `captions` if it was nil and `captioned = true` on the targets (one step). An AI pass may
  `amendLastStep` this into its previous step.
  `removeCaptions(ids)`: `captioned = nil` on the targets. If nothing is captioned any more, the caption track is
  removed; otherwise `captionFixes` entries for assets no captioned clip uses are dropped.
  `removeCaptionTrack`: `captions = nil`, `captionFixes = nil`, and every `captioned = nil`.
  `setCaptionsHidden`, and the style setters (one step; or live for sliders; colour wells are live with
  auto-commit).
  `setCaptionText(block, text)`: split the new text on whitespace. Empty → every covered word gets the fix `""`.
  The same number of words → a one-for-one fix. Otherwise the first covered word gets the whole new text and the
  others get `""` with `merged = true`. Fixes for that asset are replaced by source start (±0.0005) and sorted by
  start. Deleting selected captions applies `setCaptionText("")` to each. Retyping in the inspector is live and
  commits when editing ends; empty text is ignored while typing.
  Caption **layout** (derived, for the renderer and timeline): only audio, playsSource, non-backwards clips with
  `captioned == true` are used. For each word whose midpoint is inside the clip's source range, map it to the
  timeline via `start + timelineSpan(s0, s)`, clamped to the clip, and apply the fixes. A word with several new words
  shares its time between them by `(len+1)` weights. Runs break at a pause ≥ 0.5 s or after `. ? !`. Each run is cut
  into `n = min(words, max(1, ceil(chars/26), ceil(dur/2.6)))` phrases at the word nearest each even character
  share; a comma lowers the score by 6, and retyped multi-word groups are never cut. Each block ends at
  `min(nextStart, clip.end, max(lastWord.end + 0.25, first.start + 0.6))`, but not before the last word's end.
  Across clips, after sorting, an overlapping block is shortened to `max(start + 0.05, next.start)`. A block's id is
  `"<clipUUID>@<Int(firstWordSource·1000)>"`.
- **Text clips**: the inspector text editor, font family, Bold toggle, colour and size are live edits with
  auto-commit (a step per 0.8 s pause). X/Y position: px from the centre, rounded, stored as `0.5 + px/W`. The reset
  sets 0.5, 0.5.
- **Solids**: the Fill colour picker is a live edit with auto-commit, stored in `clip.color` (opacity not offered).
- **Transform**: live edits on every selected transformable clip, stored as nil when identity. Reset sets
  `transform = nil`. **Zoom toggle** (single clip): with a zoom present, it removes the zoom (and the transform if
  that leaves identity). Otherwise `scale = 2` if `scale ≤ 1.01`, and
  `zoom = ZoomMove.starter(lastMode, length: duration)`; then the playhead moves to `start + zoomedTime` if it
  isn't already where the zoom is fully in (amount > 0.999).
- **Grade**: live edits on every selected visual clip, stored as nil when neutral. Look choice and Reset are one
  step each. **Copy Grade (⌥⌘C)** needs exactly one selected non-audio clip on an unlocked track; it stores
  `.some(clip.grade)`, so copying "no grade" works. **Paste Grade (⌥⌘V)**: every selected non-audio unlocked clip
  gets `grade = copied` (possibly nil). One step.

### 3.21 Playhead / transport rules that touch the model
- `seek(t)` and `scrub(t)`: `playhead = max(0, snapFrame(t))`. `step(±1)` moves by `1/fps`. Previous/next edit
  jumps to the nearest `editPoints` entry beyond `playhead ± 0.5/fps`. Home goes to 0, End to `duration`.
- Pausing frame-snaps the playhead. Loop span = `playRange ?? (0, duration)`. Pressing play at the end (within one
  frame), or outside the range when looping with a range, jumps to the span start first.

---

## 4. Undo / redo model

- **Whole-project snapshots.** `undoStack: [Project]` and `redoStack: [Project]`, plus `redoKnown: [Set<UUID>]`
  (the asset ids that existed before each redo step). Selection is not part of a snapshot.
- **`mutate(body)`**, one undoable step: `commitLive()`; copy the project; run the body; `sanitize()`; **if the
  result equals the current project, do nothing (no step)**; push the old project; **cap at 200** (the oldest is
  dropped, checked here only); clear redo; set the project; mark it dirty and rebuild.
- **`live(autoCommit = true, body)`**, a continuous change (drag or slider): run the body **without sanitize**. If it
  changed something, keep the pre-change snapshot (only the first time), set the project and mark it dirty. With
  autoCommit, a 0.8 s one-shot timer (restarted on every call) runs `commitLive`. Without it, the caller must call
  `commitLive()` when the gesture ends.
- **`commitLive()`**: if a snapshot exists and differs from the current project, push it (not capped here) and clear
  redo. It runs automatically before any mutate, undo, redo, save or autosave.
- **`discardLive()`**: restore the snapshot; no step. Used for Esc in text fields.
- **`amendLastStep(body)`**: apply and sanitize without pushing, so the change joins the previous step (used by
  Magic's captions on the cut it just made). With an empty undo stack it acts as `mutate`.
- **Undo**: `commitLive`; pop prev; push the current project to redo; push `Set(prev.assets.ids)` to `redoKnown`.
  Then fix up the library:
  - `prev.assets = restoring(prev.assets, into: current.assets)`. Every asset that exists now keeps its current
    version (imports and relinks are not undone). Assets in prev that are missing now come back at their old
    position. Assets imported since stay, appended.
  - Assets dropped because their file was deleted from a linked folder (`droppedFromDisk`) stay gone, unless
    prev's clips use them.
  - Folders: the union of the current and prev folders (current first). `hiddenMedia` is the union of both. Then
    `pruneFolders` (folders still importing are kept).
  - `magicHistory` keeps its current value.
- **Redo**: pop next; push the current project to undo. Assets: those in `redoKnown.last` that are missing from
  `next` (that step deleted them) are removed from the current library; all other assets stay as they are now.
  Folders, hidden media and magicHistory are merged as for undo.
- History is cleared on load, open or new project, and on relink.
- **What is grouped into one step** (from the code above):
  - Every EditorModel command is a single `mutate`: split, delete, ripple delete, ripple trim, freeze frame (split +
    shift + insert + overwrite), reverse of a linked group, close all gaps (all tracks in one step), delete gap,
    paste, duplicate, drop insert, ⌥-drag duplicate, remove assets with their clips, captions on or off, paste grade,
    even out levels, reset playback, transition set, track add/remove/toggle/duck, sequence size/rate/match, marker
    add/update/delete/clear, in/out set/clear.
  - A clip move or trim drag is **one step at mouse-up**. It is not live; overrides are only displayed during the
    drag.
  - Live with one step per gesture (`autoCommit: false`, committed on gesture end): fade handle drag, clip gain
    line drag, marker drag, in/out edge drag, inspector sliders (volume, speed, ramp graph, scale/X/Y, zoom graph,
    transition length, fades, grade sliders and wheels, caption size and position), track gain pill, viewer
    position drag, caption retype.
  - Live with auto-commit (one step per 0.8 s pause): text-clip string, font, bold, colour and size; solid fill
    colour; marker rename; caption colour wells.
- Dirty flag: set by any mutate, live, undo, redo or library change; cleared by save. Autosave waits 2 s after the
  last change and never runs during a live edit.

---

## 5. Time display and entry

`TimeStyle` (UserDefaults `timeStyle`): `"timecode"` (default) or `"simple"`. `Timecode.string(t, fps)` uses the
current style.

- **Full timecode** `full(t, fps)`: `f = max(1, Int(fps.rounded()))`, `total = Int((max(0,t)·fps).rounded())`
  (**the true fps, e.g. 29.97**), `frames = total % f`, `secs = total / f` (integer division),
  `s = secs%60, m = (secs/60)%60, h = secs/3600`. The format is `"%02d:%02d:%02d:%02d"` → `HH:MM:SS:FF`.
  This is **non-drop-frame**: for 29.97 the display counts 30-frame "seconds", so it drifts from wall-clock time. No
  `;` separator is used for drop-frame.
- **Simple** `simple(t)`: `cs = Int((max(0,t)·100).rounded())`, `c = cs%100`, `secs = cs/100`. If hours > 0 the
  format is `"%d:%02d:%02d.%02d"` (`1:02:05.50`), else `"%d:%02d.%02d"` (`0:05.50`).
- **Short** `short(t)`: `secs = Int(max(0,t).rounded())`, formatted `h:mm:ss` if hours > 0, else `m:ss`.
- **Parse** `parse(s, fps)`, after trimming spaces (not newlines):
  1. Simple style only: if the text matches `^\d+(:\d{1,2}){0,2}(\.\d+)?$`, split on `:`, convert each part with
     `Double()`, and fold `acc·60 + part`. Note that plain digits like `"1000"` give **1000 s** in simple style.
  2. Otherwise, if the text contains any of `:` `;` `.`: split on those characters (empty pieces are omitted),
     allowing 1–4 parts, each a non-negative `Int`; anything else gives nil.
  3. Otherwise it must be digits only, 1–8 characters, read in **pairs from the right** (`"1000"` → [10, 00]).
  4. The parts count from the right as frames, seconds, minutes, hours (missing ones are 0):
     `frames = ((h·60 + m)·60 + s)·f + ff`, result `Double(frames) / fps`. Out-of-range values (for example 90
     frames) are not rejected; they just add up.
- `formatDB(db)`: `≤ −59.5` → `"−∞ dB"`. Otherwise `v = round(db·10)/10`, written as a sign (`+` if v > 0, U+2212
  `−` if v < 0, nothing for 0) followed by `"%.1f dB"` of |v|.
- Frame rate label: an integer rate shows as `"30 fps"`, otherwise two decimals (`"29.97 fps"`).
- The inspector shows durations and fades as `"%.2fs"`; trim drags show the new duration as a timecode string.

---

## 6. Notes for the port (facts, not recommendations about app code)

- Port the snapshot undo model as it is; operations depend on `Project` equality to skip no-op steps.
- The JSON field set in §2 is complete for every type reachable from `SavedDocument`. Nothing in the model uses
  custom key names, so serde structs need `rename_all = "camelCase"`-equivalent exact names (they are already
  camelCase in Swift), `skip_serializing_if = "Option::is_none"` for optionals, and `#[serde(default)]` only where
  §2 says a key is optional.
- Keep values PromptEdit cannot interpret (`bookmark`, `playablePath`, `.cube` paths, unknown look names) and
  round-trip them unchanged. **UNSURE** whether Editroom tolerates unknown extra keys: Swift's synthesized decoding
  ignores unknown keys, so PromptEdit-only fields would be lost on an Editroom save but would not break loading.
