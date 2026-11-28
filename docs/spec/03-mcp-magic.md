# 03 — MCP server, agent connection and Magic

Reference for porting Editroom's AI surface to PromptEdit (Tauri 2 + Rust + React/TS, macOS and Windows).

Sources read (Editroom, read-only clone):
`Editroom/MCP/{MCPServer,MCPBridge,MCPTools,AgentConnect,ContactSheet,MediaDownload}.swift`,
`Editroom/Magic/*.swift` (all 21 files), `Editroom/UI/{MagicPopover,MentionField,SettingsView}.swift`
(Magic tab), `Editroom/App/EditroomApp.swift`, plus the bits they lean on
(`Model/EditorModel.swift` undo, `Engine/SceneTags.swift`, `Engine/Transcripts.swift`,
`Engine/Reverser.swift` cache naming, `App/SelfTest.swift` MCP tests).

Conventions: "verbatim" blocks are copied character for character from the Swift source
(Swift `\` line continuations joined). **UNSURE** marks things not verifiable from the source
(mostly third-party app behaviour on Windows).

---

## 0. Overview

```
 Claude Desktop ──stdio──► Editroom --mcp (bridge, no window) ──HTTP POST──┐
 Codex / ChatGPT ─stdio──► Editroom --mcp --from codex      ──HTTP POST──┤
 Claude Code ─────────────── Streamable HTTP (direct) ──────────────────────┤
                                                                           ▼
                                   Editroom app: MCPServer 127.0.0.1:47920/mcp
                                   ├─ live mode  → edits played by the agent's cursor on the real timeline
                                   └─ ?draft=<token> → edits go to a hidden MCPDraft (Magic runs)

 Magic popover ─► Claude tab:  spawns `claude -p …` (Claude Code CLI) with --mcp-config → /mcp?draft=…
               ─► ChatGPT tab: spawns `codex exec …` with -c mcp_servers.editroom.url=…/mcp?draft=…
               ─► Local tab:   heuristic planners (+ Apple FoundationModels to parse the request)
```

One MCP tool implementation (`MCPTools`) serves three callers: external agents (live), Magic's
own AI runs (draft), and SelfTest. There are no MCP resources or prompts.

---

## 1. The MCP server

### 1.1 Transport and endpoint

- Hand-written HTTP/1.1 server on `Network.framework` (`NWListener`), **loopback interface only**
  (`params.requiredInterfaceType = .loopback`, `allowLocalEndpointReuse = true`).
- Port **47920**; endpoint string `http://127.0.0.1:47920/mcp` (`MCPServer.endpoint`).
- If the port is in use (`EADDRINUSE`, i.e. another copy of Editroom), it re-listens on an
  ephemeral port (`NWEndpoint.Port.any`) and sets `problem = "Another copy of Editroom is answering
  AI apps; this one only runs its own Magic."`. `localEndpoint` (`http://127.0.0.1:<port>/mcp`) is what
  this copy's own Magic runs use. Other bind failures: `"Couldn't listen on port 47920: <error>"`.
- MCP "Streamable HTTP" transport, **JSON replies only** — never SSE, never a GET stream.
  - `POST /mcp…` → JSON-RPC. One request per TCP connection (`Connection: close`, `Content-Length` set).
  - `DELETE /mcp…` with `Mcp-Session-Id` → forgets that client, `200 OK`.
  - any other method → `405 Method Not Allowed`, `Allow: POST, DELETE`.
  - path not starting `/mcp` → `404`.
  - Request buffer limit 32 MiB (connection dropped past that); reads in 1 MiB chunks.
- Security checks, in order:
  1. `Host` header hostname (port stripped) must be `127.0.0.1`, `localhost` or `[::1]`, else `403`
     (DNS-rebinding guard).
  2. If `Origin` is present and non-empty, its host must be `127.0.0.1` or `localhost`, else `403`
     (blocks browser pages).
  3. `?draft=<token>` query item: a Magic run. If AI Agents is **off** (`enabled == false`) only
     requests with a valid open draft token are served; others `403`.
  4. `X-Editroom-From: claude-app` while the Claude app is "disconnected" in Settings
     (`UserDefaults claudeAppDisconnected`): notifications → `202`; requests → `200` with
     JSON-RPC error `-32001` `"Editroom is disconnected from Claude. To use it again, connect Claude in Editroom > Settings > Magic."`
- Body not JSON → `400 Bad Request` with `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`.
- Notifications (no `id`) → `202 Accepted`, empty body.
- Responses carry `Content-Type: application/json` and echo/assign `Mcp-Session-Id`.

### 1.2 Sessions and clients

- On `initialize` a new session id (`UUID().uuidString`, uppercase with dashes) is minted and
  returned in `Mcp-Session-Id`. Unless it's a draft (Magic) request, a `Client` is recorded:
  `{id, name: displayName(clientInfo.name ?? "Agent"), lastSeen}`.
- Later requests with a session id update `lastSeen` (an unknown session id is adopted as "Agent").
- `displayName`: contains "claude" → `Claude`; "codex" → `Codex`; "chatgpt" or "openai" → `ChatGPT`;
  else `-`/`_` → spaces and first letter uppercased. This name is the cursor label and colour key.
- Settings > Magic shows "Working now:" with clients seen in the last 60 s (refreshed every 5 s).

### 1.3 Protocol

- Supported versions: `["2025-06-18", "2025-03-26", "2024-11-05"]`. Echoes the client's
  `protocolVersion` if supported, else `2025-06-18`.
- `initialize` result (verbatim structure):
  ```json
  {
    "protocolVersion": "<negotiated>",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "editroom", "title": "Editroom", "version": "1.0" },
    "instructions": "<MCPTools.instructions, below>"
  }
  ```
- `ping` → `{}`; `tools/list` → `{"tools":[…definitions…]}` (no pagination);
  `resources/list` → `{"resources":[]}`; `resources/templates/list` → `{"resourceTemplates":[]}`;
  `prompts/list` → `{"prompts":[]}` (these three exist only because Codex asks at start-up).
- `tools/call` → `{"content":[…], "isError": false}`; tool errors are **results**, not JSON-RPC errors:
  `{"content":[{"type":"text","text":"<message>"}],"isError":true}`.
- Anything else → JSON-RPC error `-32601` `"Method not found"`.
- `MCPHandler.opensEditroom(method)` is true only for `tools/call`: everything else can be answered
  without the app (used by the bridge, §1.5).
- Debug: launching with `--magic-ai` logs `MCP CALL <name> <live|draft> from <client>` to stderr.

Server instructions (verbatim):

```
Editroom is a video editor. Times are in seconds. Video tracks are V1, V2, … (V1 is the bottom; higher tracks cover lower ones) and audio tracks are A1, A2, …. A video with sound is placed as a linked pair: moving, trimming or deleting either moves both. Placing, moving or trimming a clip, title or solid over another on the same track overwrites what's underneath, as on the timeline. Start with get_project and list_media; analyze_media finds a clip's best moments or a song's beats; look_at_media shows you a clip or photo, and get_frame shows you the cut; search_media finds shots by what they show or what's said. After looking at a clip, save what you saw with note_media; list_media gives those notes back next time, so trust a clip's notes and look again only for an exact frame. Each edit is shown to the person with your own cursor and can be undone with history. auto_edit builds a whole cut on its own, and export delivers it to a file (vertical, square or portrait too, at a loudness target).
```

### 1.4 Lifecycle and the "AI Agents" switch

- `AppDelegate.model didSet` → `MCPServer.shared.attach(model)`; starts listening if
  `UserDefaults agentsEnabled` (default **true**).
- Settings > Magic > "Let AI apps edit in Editroom" toggles `enabled` (`start()`/`stop()`).
- Magic AI runs need the server even when the switch is off: `MagicAgent.serverReady()` starts it,
  waits up to 2 s (40 × 50 ms) for `localEndpoint`, and stops it again afterwards if the switch is off.
- Connecting an AI from the Magic popover or Settings flips the switch on.

### 1.5 The stdio bridge: `Editroom --mcp`

Launch: `EditroomApp.init()` calls `MCPBridge.runIfRequested()` first thing; if `--mcp` is in argv
the process never shows UI and `exit(0)`s when stdin closes. Same executable as the app.

Behaviour (`MCPBridge.swift`):

1. `stdout` line-buffered. **Nothing but JSON-RPC replies is ever written to stdout.**
2. Optional `--from <who>` (`claude-app` or `codex`) is forwarded on every POST as `X-Editroom-From`.
3. Reads stdin line by line (newline-delimited JSON-RPC); skips blank lines.
4. Each line is POSTed verbatim to `http://127.0.0.1:47920/mcp` with `Content-Type: application/json`,
   `Accept: application/json, text/event-stream`, `Mcp-Session-Id` (once known; captured from any
   response header), timeout 600 s. Synchronous (one in flight).
5. Non-`tools/call` messages:
   - 200 → write body; 202 → write nothing.
   - connection refused (status 0, app not running) → answered **locally** by
     `MCPHandler.handshake` (initialize/ping/tools/list/resources/prompts lists; same tool definitions
     compiled into the binary), or `-32601 "Method not found: <method>"`. Notifications and replies
     (no method / no id) get nothing. An `initialize` answered locally is **held** (`heldHello`).
   - other status → write body as-is.
   - The app is **not** launched for these, so an agent idling or starting a chat never opens Editroom.
6. `tools/call`: up to 80 attempts × 250 ms (~20 s):
   - if a hello is held, POST it first (so the app learns the client name and issues a session id);
   - status 0 → launch the app once (`NSWorkspace.openApplication(at: Bundle.main.bundleURL)` with
     `activates = false`, i.e. in the background; waits ≤ 10 s for the open callback), sleep, retry;
   - 200/202 → reply; other status → write body, stop retrying.
   - nothing after all attempts → `-32000 "Editroom isn't answering. Open Editroom and turn on AI Agents (Editroom menu > AI Agents…)."`
7. Replies have `\n` replaced by spaces and are written as one line; only for messages with an `id`.

Quirk (do not copy): a non-200 HTTP status with an empty body (e.g. `403` when AI Agents is off
but the listener is up for a Magic run) is written as an **empty line** instead of a JSON-RPC error.

### 1.6 How edits are performed (live mode)

- `MCPTools.perform(edits, model, who, draft)`: in draft mode `draft.apply(edits)` and return. In live
  mode: `reveal()` scrolls/zooms the timeline to show the affected times, then
  `MagicShow.perform(model:edits:as: Performer(name, color, start: AgentPresence.take(name)))` plays the
  edits **one after another with that agent's single cursor**, at 4× the swarm's pace
  (`MagicShow.agentSpeed = 4.0`), and the tool call returns when the animation finishes.
  It waits for any other show to finish first. If no timeline window is visible, it just
  `model.mutate` s the change.
- At the end of a performed call: `model.live(autoCommit:false){…}` + `commitLive()` → **each tool call
  is exactly one undo step**; the cursor is parked (§3.10).
- Tools that bypass `perform` in live mode: `add_track` (`model.addTrack`), `set_sequence`
  (`model.setSequence`/`setFPS`), `playback`, `history`, `import_media`, `download_media`,
  `note_media`, `export`, `save_project`, `auto_edit`; `add_title` without a free track calls
  `model.addTrack` first (an extra undo step — quirk).
- `MagicEdit` primitives used by tools: `place`, `trimHead`, `trimTail`, `move`, `blade`, `remove`,
  `change(clipID?, label, closure)`, `type`, `gain`, `fadeIn`, `fadeOut`, `look`, `grade`, `transition`
  (see §3.5).
- Common argument helpers:
  - `asset_id`: matched against `MediaAsset.id.uuidString` (case-insensitive via uppercasing) **or the
    asset's exact name**. Error `"asset_id is needed (see list_media)."` / `"No library item with id <s>. list_media has them."`
  - `clip_id`: UUID; `"clip_id is needed (see get_project)."`, `"No clip with id <s>. get_project has them."`,
    `"That clip is on a locked track."`
  - `track`: `V<n>`/`A<n>` (1-based, case-insensitive). Errors: `"<name> isn't a video track (V1, V2…)."`,
    `"There's no <N>; there are <k>. add_track adds one."`, `"<N> is locked."`
  - numbers: accept JSON int or double. `"<key> is needed, in seconds."`
  - colours: `#RRGGBB` or `RRGGBB`; `"Colours are hex, like #FF4A1C."`
  - times are snapped to frames (`p.snapFrame`) where noted.
- Draft-only restrictions (`notInMagic`): `import_media`, `auto_edit`, `save_project` throw
  `"<name> isn't available while making a Magic edit."`; `export` throws
  `"export isn't available while making a Magic edit; the person can export it when it's done."`.
  `playback` in draft only moves `draft.playhead`.

### 1.7 Output JSON shapes (tool results are pretty-printed, keys sorted, as one `text` item)

Numbers via `round3` are written with at most 3 decimals (`NSDecimalNumber`).

- **clip** (`clipJSON`): `id, name, kind (video|audio|image|text|solid), track ("V1"), start, end, duration`;
  `source_start, asset_id` for source kinds; `speed` if ≠ 1; `speed_ramp {from, to, ease_in, ease_out,
  start_speed, end_speed}` (file seconds) if ramped; `reversed: true`; `freeze_frame: true`;
  `linked_to: <other clip id>`; `gain_db` (always for audio, else if ≠ 0); `fade_in`, `fade_out` if > 0;
  `transition_in {kind, duration}`; titles: `text`, `style {font ("System" if empty), size, bold, color
  "#RRGGBB", x, y}`; solids: `color`; `transform {scale, x, y, zoom? {mode: in|out|in_out, smooth,
  in:[p1,p2]?, out:[p3,p4]?}}` if not identity; `grade {look (label), look_file (path if a .cube),
  look_intensity (if ≠1), exposure, contrast, saturation, temperature, tint (each if ≠ 0)}`.
- **project** (`projectJSON`): `name, sequence {width, height, fps, duration}, playhead,
  tracks [video top-first: {name, kind:"video", hidden, locked}, then audio: {name, kind:"audio",
  muted, solo, locked, gain_db}], clips (sorted by track name then start), markers [{id, time, name,
  color}], in_out {in,out}|null, captions {hidden, size, position, highlight, clip_ids}|null`.
- **asset** (`assetJSON`): `id, name, kind (video|audio|image), path`; `duration` (not images);
  `width, height` (not audio); `fps, has_audio` (video). list_media adds `folder` (linked-folder label
  like "B-roll / Drone"), `shows` (top 8 of top-20 scene tags, minus tags shared by ≥60 % of tagged
  items when ≥4 are tagged), `notes` (MediaNotes text), `speech` (bool, once transcribed),
  `says` (first 120 chars of transcript + "…").

### 1.8 Tool catalogue (43 tools)

Every definition is built by `tool(name, title, description, props, required, readOnly)`:

```json
{ "name": "…", "title": "…", "description": "…",
  "inputSchema": { "type": "object", "properties": { … }, "required": [ … ] },
  "annotations": { "readOnlyHint": <bool>, "destructiveHint": false, "openWorldHint": false } }
```

`required` is always present (possibly `[]`). Defaults are stated **only in description text**; no
JSON-Schema `default` keywords are emitted. `num(d)` = `{"type":"number","description":d}`,
`str(d)` = `{"type":"string","description":d}`. Order below is the `tools/list` order.

#### get_project — "Get project" (readOnly)
Description: `The sequence (size, frame rate, length), tracks, and every clip with its id, track, times, source, grade, sound and transition.`
Schema: no properties.
Does: returns project JSON (§1.7) of the draft or live project; `playhead` = draft playhead or model playhead.

#### list_media — "List media" (readOnly)
Description: `Everything in the library: id, name, kind (video, audio, image), the folder it's in, length, size, frame rate, what it shows, whether people talk in it, and notes saved from looking at it before.`
Schema: none. Returns array of extended asset JSON (§1.7).

#### import_media — "Import media"
Description: `Adds files to the library. A folder brings in everything in it (and in folders inside it) and stays linked: files added to it later come in too, and list_media gives each item's folder.`
```json
{"paths":{"type":"array","items":{"type":"string"},"description":"Absolute paths of files or folders."}}  required: ["paths"]
```
Does: `~` expanded; missing → `"No file at <paths>"`; `model.importFiles(urls, offerMatch:false)`;
returns `{"imported":[asset…], "failed": <count>}`. Not in Magic.

#### download_media — "Download media"
Description: `Downloads one music or sound file you found online and adds it to the library, ready for add_clip. Give the direct link to the audio file (an .mp3, .m4a or .wav), not a web page. Only for music that's free to use; say where you found it and what its licence allows, which is noted beside the file.`
```json
{"url":{"type":"string","description":"https link to the audio file itself."},
 "name":{"type":"string","description":"What to call it, like the track and artist."},
 "source_page":{"type":"string","description":"The page you found it on."},
 "licence":{"type":"string","description":"What the licence says, for example \"Pixabay Content License: free to use, no attribution required\"."}}
required: ["url","source_page","licence"]
```
Does: see §1.9. Imports the file, adds it to the draft too (`draft.addAsset` puts it in base and
draft), returns `{"added": {asset…, "saved_to": path}, "note": "In the library now; add it with add_clip."}`.
Allowed in Magic (it's the one thing Magic may add from outside).

#### analyze_media — "Analyze media" (readOnly)
Description: `For a video or photo: its best moments, scored for focus, exposure, colour, faces and steadiness. For music: tempo, beats and where bars start. Done on this Mac; cached.`
```json
{"asset_id":{"type":"string","description":"A library item's id."},
 "moment_length":{"type":"number","description":"Length of moments to look for, in seconds (default 2)."}}
required: ["asset_id"]
```
Does: audio → `MediaAnalyzer.music` → `{bpm, beat_length, beat_count, first_beat, bar_starts (≤80 beat times)}`.
Video/photo → `MediaAnalyzer.clip`, `AutoPlanner.scorer(samples)`, `AutoPlanner.moments(limit: asset.duration,
length, count 5)` → `{duration, best_moments:[{start,end,score,faces}], average_brightness, has_faces,
filmed (ISO8601)?, looks_like_a_screenshot_or_document: true?}`. Errors `"Couldn't read the sound in <name>."` / `"Couldn't look at <name>."`

#### get_transcript — "Get transcript" (readOnly)
Description: `What's said in a video or sound file, heard on this Mac: its sentences and pauses with their times in the file (and each word's time if you ask). Use it for anything with people talking: to cut pauses, retakes and filler, keep sentences whole, find a moment by what's said, or put pictures over the talking. Made in the background after import; cached.`
```json
{"asset_id":{"type":"string","description":"A library item's id."},
 "words":{"type":"boolean","description":"Also every word with its start and end (default false)."}}
required: ["asset_id"]
```
Returns `{asset_id, status, …}`: `no_sound` (image or no sound URL, note "<name> has no sound."),
`unavailable` ("Hearing speech needs macOS 26 on this Mac."), `failed`, `no_speech` (note "Nobody talks in
it (or only music or noise)."), or `ready` with `name, duration, language, times: "Seconds in the file. A clip
plays the file from its source_start.", sentences [{start,end,text}], pauses [{start,end}] (silences ≥ 0.5 s
including before first and after last speech), words [[start,end,text]]?`. Waits for transcription (`Transcripts.shared.ready`).

#### look_at_media — "Look at media" (readOnly)
Description: `Shows you a library item: a photo, or frames from across a video in a grid, each marked with its time in the file. Use it to see what's in each shot before choosing.`
```json
{"asset_id":{"type":"string","description":"A library item's id."},
 "frames":{"type":"integer","description":"How many frames from across a video (default 6, at most 12)."},
 "times":{"type":"array","items":{"type":"number"},"description":"Or exactly which times in the file to show, in seconds (at most 12)."}}
required: ["asset_id"]
```
Returns `[{"type":"image","data":<base64 JPEG>,"mimeType":"image/jpeg"}, {"type":"text","text": note}]`.
Note text: photo → `"<name>, a photo."`; video → `"<name>, <dur>s long. Frames at 0.5s, 2.1s, …, left to right, top to bottom."`
then either `" Its saved notes: <text> Update them with note_media if you see more."` or `" Save what you see with note_media."`.
Audio → error `"<name> is sound only; analyze_media finds its beats."`. Contact sheet: §1.10.

#### note_media — "Note what's in media"
Description: `Saves what you saw in a library item after looking at it, for later edits: what happens and where (times in the file), the people, the place, the light, how steady, and its best and weakest moments. Two or three short lines. list_media hands it back as "notes", so it needn't be looked at again. Replaces any note it had; kept on this Mac, never in the project.`
```json
{"asset_id":{"type":"string","description":"A library item's id."},
 "notes":{"type":"string","description":"What's in it, with times, like \"0-3s girl in a high chair eating noodles; 3-8s close-up, laughing at the camera, best moment 5s; bright kitchen, handheld but steady.\""}}
required: ["asset_id","notes"]
```
Does: `MediaNotes.save` (§1.11). Returns text `"Saved. list_media will show it with <name>."`. Empty → `"Give notes: what's in it, with times."`

#### get_frame — "Get frame" (readOnly)
Description: `A picture of the cut at a time (default: the playhead), 640 pixels on its longer side.`
Schema: `{"time": num("Seconds.")}`. Returns PNG image item + text `"Frame at <t>s."`. Renders the draft
project when in Magic (`model.snapshot(of:p, at:t)`). Empty timeline → `"The timeline is empty."`

#### add_clip — "Add clip"
Description: `Drags a library item onto the timeline. A video with sound brings its audio, linked.`
```json
{"asset_id":{"type":"string","description":"A library item's id."},
 "start":{"type":"number","description":"Where on the timeline (default: the end of the track)."},
 "track":{"type":"string","description":"V1, V2… for video and photos; A1, A2… for audio (default V1 or A1)."},
 "source_start":{"type":"number","description":"Where in the file to start (default 0)."},
 "duration":{"type":"number","description":"How long (default: the rest of the file; 5 for a photo)."}}
required: ["asset_id"]
```
Does: linked audio goes on the first audio track free over the span (else first audio track, else a new
one). Duration capped to the rest of the file (photo ≤ 3600). `source_start` past end → error.
Overwrites what's underneath. Returns `{"added":[{id, track, start, end}]}`.

#### add_title — "Add title"
Description: `Adds a text title, typed in.`
```json
{"text":{"type":"string","description":"The words."},"start":{"type":"number","description":"Default 0."},
 "duration":{"type":"number","description":"Default 3."},
 "track":{"type":"string","description":"A video track (default: one that's free there, above V1)."}}
required: ["text"]
```
Does: first video track above V1 free over the span, else a new top track; places an empty text clip
then a `type` edit (cursor types the words). Min duration 0.2. Returns `{"added":{id,track,start,end}}`.

#### move_clip — "Move clip"
Description: `Moves a clip (and anything linked to it) in time, and optionally to another track of the same kind.`
`{"clip_id": str("A clip's id."), "start": num("New start."), "track": str("Optional new track.")}` required `["clip_id","start"]`.
Moves the unlocked linked group by the same delta; returns clips JSON.

#### trim_clip — "Trim clip"
Description: `Moves a clip's start and/or end edge on the timeline (and its linked clip's). The source moves with the start edge.`
`{"clip_id": str("A clip's id."), "start": num("New start edge."), "end": num("New end edge.")}` required `["clip_id"]`.
Clamped to the file's start/end (`sourceLimit`); `< 1 frame` → `"That would leave the clip with no length."`

#### set_speed — "Set speed"
Description: `Speeds a clip (and its linked sound) up or slows it down, keeping the same part of the file: 4 plays four times as fast and a quarter as long (a timelapse), 0.5 is slow motion. Clips after it on the track move to stay butted up.`
`{"clip_id": str("A clip's id."), "speed": num("0.05...100; 1 is normal.")}` required `["clip_id","speed"]`.
Clamped 0.05…100; undo label `Speed ×<n>` / `Slow ×<n>`. Only source clips.

#### set_speed_ramp — "Set speed ramp"
Description: ``A speed ramp on a clip (and its linked sound): it plays at `around` speed, eases into `speed` for the part of the file from `from` to `to`, then eases back. For a slow-motion moment (speed 0.25, around 1), fast-normal-fast B-roll (speed 1, around 4), or ramping into a cut (`to` left out, `speed` 4: it eases up toward the clip's end). Times are seconds in the file, like source_start. The clip's length changes; clips after it on the track move to stay butted up. remove: true takes a clip's ramp away.``
```json
{"clip_id":{"type":"string","description":"A clip's id."},
 "speed":{"type":"number","description":"The speed from `from` to `to`, 0.05...100 (1 is normal)."},
 "from":{"type":"number","description":"Seconds in the file where it reaches `speed` (default: the clip's start, so no ease in)."},
 "to":{"type":"number","description":"Seconds in the file where it starts easing back (default: the clip's end, so no ease out)."},
 "ease":{"type":"number","description":"Seconds of the file each ease takes (default 0.4)."},
 "around":{"type":"number","description":"The speed before and after (default 1)."},
 "remove":{"type":"boolean","description":"Take the clip's ramp away (its speed stays)."}}
required: ["clip_id"]
```
Maths: `s0 = sourceStart`, `L = sourceLength`, `f(s) = clamp((s-s0)/L, 0, 1)`; points default `(0,0,1,1)`;
if `from > s0+1e-3`: `p0=f(from-ease), p1=f(from)`; if `to < s1-1e-3`: `p2=f(to), p3=f(to+ease)`;
ease min 0.04; needs from or to (`"Give from and/or to (seconds in the file); for one speed throughout, use set_speed."`).
`proj.setRamp(ids, speed, points, start: around, end: around)`; label `Slow-mo ramp` if speed < around else `Speed ramp`.

#### set_captions — "Set captions"
Description: `Captions from what's said: a caption track above the video shows the words of each captioned clip in short phrases, timed to the speech, and follows every trim and move of those clips. Give clip_ids to caption those clips' speech (a video's sound is its linked audio clip); with none, every clip of people talking is captioned (sound from video files and voiceover tracks, not music). Also sets the captions' style, and with edit fixes captions: a misheard word, a name spelled right, or a caption taken out. remove: true takes captions off clip_ids, or removes the caption track with none. Returns the captions.`
```json
{"clip_ids":{"type":"array","items":{"type":"string"},"description":"Clips whose speech to caption (or un-caption with remove)."},
 "remove":{"type":"boolean","description":"Take captions off instead."},
 "size":{"type":"number","description":"Text size, 28...140 (default 64)."},
 "position":{"type":"number","description":"Where they sit, 0.1 (top) to 0.95 (bottom) of the frame (default 0.78)."},
 "highlight":{"type":"boolean","description":"Light up each word as it's said (default true)."},
 "hidden":{"type":"boolean","description":"Hide or show the caption track (hidden captions aren't exported)."},
 "edit":{"type":"array","description":"Captions to change, each found by a timeline time inside it (as set_captions or get_project return them): the words it should say, or \"\" to take it out. The caption keeps its time.",
         "items":{"type":"object","properties":{"at":{"type":"number","description":"Timeline seconds inside the caption."},
                                                "text":{"type":"string","description":"What it should say."}},"required":["at","text"]}}}
required: []
```
Does: waits for transcripts of targets; finds each `edit.at` in caption blocks (inside, else nearest
within ±0.5 s); one `change` edit "Captions". Returns `{"captions": {hidden,size,position,highlight,clip_ids,count,
captions:[{start,end,text}] (first 60)} | null}`. Errors include `"Captions need speech recognition, which needs macOS 26 on this Mac."`,
`"There's no one talking to caption: give clip_ids of clips with speech."`.

#### split_clip — "Split clip"
Description: `Cuts a clip (and its linked clip) in two with the blade. Returns the new right-hand pieces.`
`{"clip_id": str("A clip's id."), "at": num("Timeline time inside the clip.")}` required `["clip_id","at"]`.
Must be > half a frame inside. Returns `{"left":[…], "right":[…]}`. Right piece: `fadeIn=0`, left `fadeOut=0`, new link id.

#### delete_clips — "Delete clips"
Description: `Deletes clips and anything linked to them.`
`{"clip_ids":{"type":"array","items":{"type":"string"}}, "ripple":{"type":"boolean","description":"Close the gap left behind (default false)."}}` required `["clip_ids"]`.
Returns text `"Deleted N clip(s)."`; `"Nothing to delete (locked tracks?)."`

#### set_grade — "Set grade"
Description: `Colour for video, photo and title clips. Leave out what shouldn't change.`
```json
{"clip_ids":{"type":"array","items":{"type":"string"}},
 "look":{"type":"string","description":"A look from list_looks, a .cube file path, or \"none\"."},
 "look_intensity":{"type":"number","description":"0...1."},"exposure":{"type":"number","description":"Stops, -2...2."},
 "contrast":{"type":"number","description":"-50...50."},"saturation":{"type":"number","description":"-100...100."},
 "temperature":{"type":"number","description":"-50...50, negative is cooler."},
 "tint":{"type":"number","description":"-50...50, positive is toward magenta."}}
required: ["clip_ids"]
```
Also accepts undocumented `clip_id` (string). Exposure/contrast/saturation become `.grade` drags (cursor works the
grade card); look → `.look`; intensity/temperature/tint → one `change "Colour"`. `.cube` validated by `GradeBaker.cubeFile`.
Audio clip → `"<name> is sound; it has no colour."`. (Values are read with `as? Double`; Swift bridges JSON integers to `NSNumber`, which casts to `Double`, so `10` works. In Rust accept any JSON number.)

#### list_looks — "List looks" (readOnly)
Description: `The built-in looks for set_grade.` → JSON array of names:
`["Warm film","Golden hour","Film print","Teal and orange","Pastel","Bleach bypass","Mono","Cool night"]`
(retired `Faded` still accepted by name).

#### set_audio — "Set level and fades"
Description: `A clip's sound level, and its fades: a sound clip's fade its sound, a video, photo, title or solid's fade its picture (in from black, out to black).`
`{"clip_id": str("A clip's id."), "gain_db": num("Sound level in dB, -60...12."), "fade_in": num("Seconds."), "fade_out": num("Seconds.")}` required `["clip_id"]`.
Fades clamped to `[0, clip duration]`.

#### set_transition — "Set transition"
Description: `A transition into a clip from the clip that ends where it starts on the same track.`
`{"clip_id": str("The later clip's id."), "kind": {"type":"string","enum":["dissolve","dipToBlack","wipe","none"]}, "duration": num("Seconds (default 0.5).")}` required `["clip_id","kind"]`.
Needs a clip ending within 1 ms of its start on the same track; duration min 0.04.

#### add_track — "Add track"
Description: `Adds an empty track on top of the others of its kind.` `{"kind":{"type":"string","enum":["video","audio"]}}` required `["kind"]`. Returns `"Added V3."` etc.

#### set_sequence — "Set sequence"
Description: `The frame size and frame rate of the cut.` `{"width":{"type":"integer"},"height":{"type":"integer"},"fps": num("23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88 or 120.")}` required `[]`.
16…8192 each; fps snapped to nearest standard rate. Draft: also `settingsLocked = true`. Returns `{width,height,fps}`.

#### playback — "Playback"
Description: `Play, pause or move the playhead.` `{"action":{"type":"string","enum":["play","pause","seek"]},"time": num("For seek.")}` required `["action"]`.
Returns `"Playhead at 12.345s, playing|paused."`; in Magic: `"Playhead at …s. Playback is off while making a Magic edit; use get_frame to see the cut."`

#### history — "Undo or redo"
Description: `Undoes or redoes the last change (each tool call is one change).` `{"action":{"type":"string","enum":["undo","redo"]}}` required `["action"]`.
Live: `model.undo()/redo()` (the person's undo stack). Draft: the draft's own step stack. Returns `"Done. N clips on the timeline."`

#### auto_edit — "Auto edit"
Description: `Builds a whole cut from the library on its own: best moments, cut to the beat of a song if there is one, titled. Replaces what's on the timeline (one undo brings it back).`
No params. Runs `MagicShow.start(fromMouse:false)` (Local Magic, empty request) and waits; returns project JSON. Not in Magic.
(Description says "titled" but current Local only adds a title when asked — parity note.)

#### save_project — "Save project"
Description: `Saves the project to its file. A project that's never been saved has to be saved by the person.` No params.
Never-saved → `"This project has never been saved; ask the person to save it (File > Save)."`

#### export — "Export"
Description: `Exports the cut to a file, in the background (export_status says how it's going, or set wait). Saved in the folder the person last exported to (else beside the project, else Movies); never over an existing file. Not available while making a Magic edit.`
```json
{"name":{"type":"string","description":"File name, without extension (default: the project's)."},
 "format":{"type":"string","enum":["video","audio"],"description":"An MP4, or a WAV of the sound (default video)."},
 "shape":{"type":"string","enum":["original","vertical","square","portrait"],"description":"original is the sequence's own shape; vertical 9:16, square 1:1 and portrait 4:5 crop it."},
 "height":{"type":"integer","description":"Output height in pixels (for vertical, square and portrait: the short side), e.g. 720, 1080, 2160. Default: the sequence's."},
 "codec":{"type":"string","enum":["h264","hevc"]},"quality":{"type":"string","enum":["high","web"]},
 "include_audio":{"type":"boolean","description":"Default true."},
 "loudness":{"type":"number","description":"Target loudness in LUFS: -14 for YouTube and social, -16 for podcasts, -23 for broadcast. Leave out to keep the levels."},
 "range_only":{"type":"boolean","description":"Just the in/out range (see set_in_out)."},
 "reframe_x":{"type":"number","description":"For a crop: which part to keep, 0 (left) to 1 (right). Default 0.5."},
 "reframe_y":{"type":"number","description":"For a crop: 0 (top) to 1 (bottom). Default 0.5."},
 "wait":{"type":"boolean","description":"Wait until it's done (up to about 4 minutes) instead of returning straight away."}}
required: []
```
Validation: height 144…4320; loudness −40…−5; range_only needs in/out; wav needs audio clips. File name: `/` and `:` → `-`;
`"<base> 2.ext"`, `"<base> 3.ext"` … to avoid existing/queued files. Folder: `project.exportDir` if it exists, else project folder,
else `~/Movies`. Queues `model.exports.add(...)`; returns `{file, size: "WxH"|"audio", status:"started"}`; with `wait`, polls every
0.5 s up to 240 s → `done` / `cancelled` / error `"The export failed: <why>"` / `"still exporting; export_status says when it's done"`.
PromptEdit addition (not in Editroom): `format` also takes `"prores"` (a ProRes `.mov`) and `"mp3"` (`quality` high = 320 kb/s,
web = 192), and `"prores_profile": {"enum": ["proxy","lt","standard","hq"]}` picks the ProRes (default standard, ProRes 422); mp3
needs audio clips like wav.

#### export_status — "Export status" (readOnly)
Description: `Exports started from Editroom (by anyone): their files and whether they're waiting, running, done or failed.`
Returns `{"exports":[{file, status: waiting|running|done|failed: <why>|cancelled, progress (2 dp, running only)}]}` or
`{"exports":[],"note":"Nothing exporting, and nothing finished recently."}`.

#### search_media — "Search media" (readOnly)
Description: `Finds library items by what they show (people, places, things: "beach", "dog", "car at night") and/or what's said in them, with the times in each file. Much quicker than looking at or transcribing each one. Seen and heard on this Mac in the background after import, so a new file may not be searchable yet.`
`{"shows": str("Words for what's in the shot; every word has to match."), "said": str("Words someone says, in order.")}` required `[]`.
Algorithm: `shows` lowercased, split on spaces, stop-words `a an the of in on at with` dropped; every word must match the
asset name (substring) or its scene tags (`SceneTags.shows`); hit gets `shows:[{tag, times(≤8)}]`. `said`: `Transcript.occurrences`,
≤10 `{start,end,words(context)}`. Returns `{found:[{asset_id,name,shows?,said?}], times:"Seconds in each file, like source_start.", note?}`
note: `"<n> item(s) hasn't/haven't been looked through yet; <m> haven't been heard yet (get_transcript hears one now)."`

#### set_marker — "Set marker"
Description: `Adds a marker on the timeline, or changes one (give marker_id, from get_project). Use markers when asked to mark moments (beats, highlights, places to cut).`
`{"marker_id": str("To change an existing marker."), "time": num("Timeline seconds (needed for a new marker)."), "name": str("What to call it."), "color": {"type":"string","enum":["white","yellow","green","blue","purple","red"]}}` required `[]`.
New: default name `"Marker <n+1>"`, colour yellow. Returns `{id,time,name,color}`.

#### delete_markers — "Delete markers"
Description: `Removes markers.` `{"marker_ids":{"type":"array","items":{"type":"string"}},"all":{"type":"boolean","description":"Remove every marker."}}`. Returns `"N marker(s) left."`

#### set_in_out — "Set in and out"
Description: `The in/out range: what Loop plays and what export can be limited to (range_only).`
`{"in": num("Timeline seconds."), "out": num("Timeline seconds."), "clear": {"type":"boolean","description":"Remove the range."}}`. Returns `{in,out}` (nulls).

#### set_transform — "Position, scale and zoom"
Description: `Moves and scales a video, photo or solid in the frame, for reframing (keeping a subject in a vertical crop, a picture-in-picture). With zoom, it animates over the clip between the full frame and this scale and framing: pushing in on a moment, or following the action in a screen recording. A title's place is set with set_title_style.`
```json
{"clip_id":{"type":"string","description":"A clip's id."},
 "scale":{"type":"number","description":"1 fits the frame; 2 is twice as big (0.05...10). With zoom, how far in it goes (default 2)."},
 "x":{"type":"number","description":"Offset of its centre across, as a fraction of the frame's width (0 is centred, 0.5 is the right edge)."},
 "y":{"type":"number","description":"Offset down, as a fraction of the frame's height (0 is centred, positive is lower)."},
 "focus_x":{"type":"number","description":"Instead of x: the point to frame, across the picture (0 left edge, 0.5 centre, 1 right edge). Scaled up, the picture is placed so that point is centred, as near as its edges allow."},
 "focus_y":{"type":"number","description":"Instead of y: the point to frame, down the picture (0 top, 0.5 centre, 1 bottom)."},
 "zoom":{"type":"string","enum":["in","in_out","out","off"],"description":"Animate: in (full frame to this framing), in_out (in, hold, back out at the end), out (from this framing back to the full frame), or off (stay at this framing)."},
 "zoom_seconds":{"type":"number","description":"How long each move takes (default a quarter of the clip, 0.5 to 2 seconds)."},
 "zoom_start":{"type":"number","description":"Seconds into the clip when the move starts: for in and in_out, when it starts moving in (default 0); for out, when it starts moving out (default so it ends with the clip)."},
 "zoom_smooth":{"type":"boolean","description":"Eased in and out (the default), or false for an even pace."},
 "reset":{"type":"boolean","description":"Back to fitted and centred, with no zoom."}}
required: ["clip_id"]
```
Maths: x,y clamped −2…2; zoom without scale and current scale ≤ 1.01 → scale 2; `ZoomMove.starter(mode, length)` then
p1..p4 per mode (in: p1=start??0, p2=p1+m, p3=p4=len; out: p1=p2=0, p3=start??(len−m), p4=p3+m; in_out: p1=start??0, p2=p1+m,
p3=max(p2,len−m), p4=len), `m` clamped 0.05…(len or len/2), `move.fit(length)`. focus: `x = -(fx-0.5)*scale`. If `tf.fills`,
`(x,y) = tf.zoomedOffset` (keeps edges in frame). Identity → transform nil. Titles → `"Titles are placed with set_title_style."`

#### set_title_style — "Title style"
Description: `A title's words and look. Leave out what shouldn't change.`
```json
{"clip_id":{"type":"string","description":"A title clip's id."},"text":{"type":"string","description":"The words."},
 "font":{"type":"string","description":"A font family installed on this Mac, or \"System\"."},
 "size":{"type":"number","description":"Points, for a 1080-pixel-tall frame (12...600; default 110)."},"bold":{"type":"boolean"},
 "color":{"type":"string","description":"Hex, like #FFFFFF."},"x":{"type":"number","description":"Its centre across, 0 (left) to 1 (right)."},
 "y":{"type":"number","description":"Its centre down, 0 (top) to 1 (bottom)."}}
required: ["clip_id"]
```
Font matched case-insensitively against installed families; else `"<f> isn't installed on this Mac. Try System, Helvetica Neue, Futura, Avenir Next, Georgia or Didot."`

#### freeze_frame — "Freeze frame"
Description: `Holds one frame of a video clip: the clip is cut there, the held frame goes in, and what follows on its tracks moves along to make room.`
`{"clip_id": str("A video clip's id."), "at": num("Timeline time inside the clip (default: its middle)."), "seconds": num("How long to hold (default 2).")}` required `["clip_id"]`.
Freeze clip copies grade and transform; source time mirrored for reversed clips.

#### reverse_clip — "Reverse"
Description: `Plays a clip (and its linked sound) backwards; again plays it forwards.` `{"clip_id": str("A clip's id.")}` required.
Pre-renders reversed audio (`media.prepareReversedAudio`); mirrors sourceStart and ramp.

#### detach_audio — "Detach audio"
Description: `Unlinks a video from its sound, so each can be moved, trimmed or deleted on its own.` `{"clip_id": str("The video's or its sound's id.")}` required.

#### duplicate_clip — "Duplicate clip"
Description: `Copies a clip (and anything linked to it) to another time.` `{"clip_id": str("A clip's id."), "start": num("Where the copy starts (default: straight after the clip).")}` required `["clip_id"]`.

#### set_track — "Set track"
Description: `A track's switches and level.`
`{"track": str("V1, V2… or A1, A2…"), "hidden": {"type":"boolean","description":"Video tracks."}, "muted": {"type":"boolean","description":"Audio tracks."}, "solo": {"type":"boolean","description":"Audio tracks."}, "locked": {"type":"boolean"}, "gain_db": num("Audio tracks, -60...12.")}` required `["track"]`.
Returns `{track,hidden,muted,solo,locked,gain_db}`.

#### add_solid — "Add solid"
Description: `Adds a solid colour (a background, a flash, a colour card).`
`{"color": str("Hex, like #000000 (default black)."), "start": num("Default 0."), "duration": num("Default 3."), "track": str("A video track (default: one that's free there).")}` required `[]`.
Default track: first unlocked video track (V1 included) free over the span, else a new one.

#### set_solid_color — "Solid colour"
Description: `Changes a solid's colour.` `{"clip_id": str("A solid's id."), "color": str("Hex, like #1A1A1A.")}` required `["clip_id","color"]`.

### 1.9 Media download (`MediaDownload.swift`)

- Folder: `<project folder>/Downloaded Music/` if the project is saved, else
  `~/Library/Application Support/Editroom/Downloaded Music/`.
- Only `https` (`file` only in self-tests). `User-Agent: Editroom`, timeout 120 s, streamed to temp.
- Rejects: non-2xx (`"The site answered <code>; that link didn't give a file."`), MIME `text/*`, `*html*`, `*json*`
  (`"That link is a web page, not an audio file. Find the direct link to the file (it usually ends in .mp3 or .wav)."`),
  empty, > 200 MiB.
- Extension: URL path ext if in `mp3 m4a aac wav aif aiff caf flac`, else server's suggested filename ext, else from MIME
  (`audio/mpeg|mp3→mp3`, `audio/mp4|x-m4a|aac→m4a`, `audio/wav|x-wav|wave→wav`, `audio/aiff|x-aiff→aiff`, `audio/flac|x-flac→flac`, default `mp3`).
- File name: `name` (or suggested/URL basename) with `/\:?%*|"<>`, newlines and control chars → spaces, trimmed, ≤ 80 chars,
  empty → `Music`; `" 2"`, `" 3"` suffixes to avoid clobbering.
- Must decode as audio with ≥ 1 s duration, else deleted: `"That file isn't audio Editroom can play. Find the direct link to an .mp3 or .wav."`
- Appends to `Sources.txt` in the same folder (verbatim format):
  ```
  <file name>
    Downloaded: <ISO8601>
    File: <url>
    Found on: <source_page or "not given">
    Licence: <licence or "not given">


  ```

### 1.10 Contact sheets (`ContactSheet.swift`)

- Photo: thumbnail ≤ 768 px (EXIF orientation applied), JPEG q 0.8, no times.
- Video: times = `times` (clamped to `[0, dur-0.05]`, ≤ 12) or `n = clamp(frames,1,12)` evenly at `(i+0.5)*dur/n`.
  Frames ≤ 360×360 (track transform applied), ±0.1 s tolerance; sorted by time.
- Grid: columns = n if n ≤ 4, 3 if n ≤ 6, else 4; cell = first frame's size; 4 px gaps; background grey 0.1; frames of a
  different shape aspect-fit in their cell. Label `"%.1fs"` top-left in 15 pt monospaced-digit semibold white on a black
  60 % box (4 px inset, 4 px padding). JPEG q 0.8.
- `get_frame` instead renders the composited cut at 640 px long side as **PNG**.

### 1.11 Media notes (`MediaNotes.swift`)

- `~/Library/Application Support/Editroom/Notes/<basename>-<fnv1a64(path|size|mtime|inode) base36>.json`
  → `{"text": ≤800 chars, "by": client name?, "date": …}`. Keyed by file identity, so edited footage loses its note.
  Never stored in the project.

### 1.12 Analysis caches used by tools

- `MediaAnalyzer` caches JSON at `~/Library/Application Support/Editroom/Analysis/<basename>-<fnv1a64(path|size|mtime) base36>-<clip|beat>-v2.json`.
- Transcripts at `…/Editroom/Transcripts/` (Engine, see spec for transcripts); scene tags in `Engine/SceneTags.swift`.

---

## 2. Agent connection (`AgentConnect.swift`, Settings > Magic)

Three one-click targets (`AgentApp`): `claude` (Claude desktop app), `chatgpt` (Codex, incl. the ChatGPT app's Codex),
`claudeCode`. Cursor names: Claude/Claude Code → `Claude`, ChatGPT → `Codex`. Download links:
`https://claude.ai/download`, `https://chatgpt.com/download`.

States: `missing`, `ready`, `waiting` (Claude install dialog open), `connected`, `working`, `failed(msg)`.
`refresh()` on popover/settings appear and when the app becomes active.

### 2.1 Launcher script (macOS)

Written to `~/Library/Application Support/Editroom/Agents/editroom-mcp` (mode 0755), and into the Claude extension.
Verbatim template (`binary` = current executable path, `bundleID` = `com.wonderassembly.Editroom` fallback):

```sh
#!/bin/sh
# Starts Editroom's connection for AI apps (Claude, ChatGPT's Codex).
app='<binary path, shell-single-quoted>'
if [ ! -x "$app" ]; then
  found=$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "<bundleID>"' | /usr/bin/head -n 1)
  [ -n "$found" ] && app="$found/Contents/MacOS/Editroom"
fi
[ -x "$app" ] || app="/Applications/Editroom.app/Contents/MacOS/Editroom"
exec "$app" --mcp --from <claude-app|codex>
```

`followMove()` (once per launch, not in `--selftest`): rewrites the Codex launcher and any installed Claude extension's
`server/editroom-mcp` if their text differs from what this copy would write (app moved or a new copy runs).

### 2.2 Claude desktop app — `.mcpb` extension

- Detection: app by bundle id `com.anthropic.claudefordesktop`. Connected if any
  `~/Library/Application Support/Claude/Claude Extensions/*/manifest.json` has `"name": "editroom"`, **or**
  `~/Library/Application Support/Claude/claude_desktop_config.json` has `mcpServers.editroom` — and not `claudeAppOff`.
- Build: stage dir `~/Library/Application Support/Editroom/Agents/claude-extension/` containing
  `server/editroom-mcp` (launcher with `--from claude-app`), `icon.png` (app icon resized to 256×256), `manifest.json`;
  zipped with `/usr/bin/zip -qrX ~/Library/Application Support/Editroom/Agents/Editroom.mcpb .`
- `manifest.json` (keys sorted, pretty, slashes unescaped):
  ```json
  {
    "author": { "name": "Editroom" },
    "compatibility": { "platforms": ["darwin"] },
    "description": "Edit your videos in Editroom: cut, trim, arrange, grade, add titles and music.",
    "display_name": "Editroom",
    "icon": "icon.png",
    "keywords": ["video", "editing", "editroom"],
    "long_description": "Lets Claude edit in Editroom, the video editor on your Mac. Claude gets its own cursor in Editroom, so you can watch every edit, and each one can be undone. Editroom opens by itself when Claude needs it.",
    "manifest_version": "0.3",
    "name": "editroom",
    "server": {
      "entry_point": "server/editroom-mcp",
      "mcp_config": { "args": ["${__dirname}/server/editroom-mcp"], "command": "/bin/sh" },
      "type": "binary"
    },
    "tools": [ { "name": "get_project", "description": "<first sentence of its description, ending in '.'>" }, … all 43 … ],
    "version": "<CFBundleShortVersionString as x.y.z, non-numeric parts dropped, padded with .0>"
  }
  ```
  (`icon` only if the PNG was written.) The `tools` summary = description split on `". "`, first part, `.` appended if missing.
- Install: `NSWorkspace.open([Editroom.mcpb], withApplicationAt: Claude.app, activates: true)` → Claude shows its own
  install dialog. State `waiting`; a 1 s timer polls the extensions folder for up to 300 s. Popover offers
  "Cancel" and "Open Claude again" (re-opens the same file).
- Disconnect: **does not uninstall** — sets `UserDefaults claudeAppDisconnected = true`; the server then answers
  `X-Editroom-From: claude-app` with error −32001 (§1.1). Settings text: "Disconnected. To remove Editroom from Claude too, use Claude's Settings > Extensions."
  Reconnect clears the flag (no re-install if still installed).

### 2.3 ChatGPT / Codex — `~/.codex/config.toml`

- Detection: ChatGPT/Codex app bundle ids `com.openai.codex`, `com.openai.chat`, or `~/.codex` exists. Connected if a line
  trimmed equals `[mcp_servers.editroom]`.
- Connect: creates `~/.codex/`, writes launcher (`--from codex`), backs the existing file up **once** to
  `~/.codex/config.toml.before-editroom`, removes any existing Editroom section (the `[mcp_servers.editroom]` table and any
  `[mcp_servers.editroom.*]` sub-tables, until the next `[` header; trailing blank lines trimmed), then appends (after a blank line):
  ```toml
  [mcp_servers.editroom]
  command = "/bin/sh"
  args = ["/Users/<me>/Library/Application Support/Editroom/Agents/editroom-mcp"]
  startup_timeout_sec = 30
  tool_timeout_sec = 300
  ```
  (`tomlString` escapes `\` and `"`.) Every other line is preserved exactly. SelfTest verifies `[mcp_servers.other]` and `[features]` survive.
- Disconnect: removes the section, writes file + `\n`.
- Popover note after connecting: "To edit from the ChatGPT app as well, quit and reopen it once."
- `CODEX_HOME` is **not** honoured (always `~/.codex`).

### 2.4 Claude Code

- Connect: `claude mcp add --scope user --transport http editroom http://127.0.0.1:47920/mcp`
- Disconnect: `claude mcp remove --scope user editroom`
- Connected if `~/.claude.json` top-level `mcpServers.editroom` exists. No bridge: Claude Code talks HTTP directly, so it only
  works while Editroom is open (no auto-launch).
- `claude` lookup order: `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`,
  then the Claude app's copy: `~/Library/Application Support/Claude/claude-code/<version>/…/Contents/MacOS/claude` (newest version first).
- First stdout/stderr line is shown on failure.
- Settings lists Claude Code only when the CLI is found.

### 2.5 "Connect another AI app" (Settings, copy prompt)

Verbatim prompt copied to the clipboard (launcher = app executable path):
```
Connect to Editroom, the video editor on my Mac, and edit only through its MCP tools (never screenshots or clicks). Its MCP server runs as the command "<executable path>" with the argument --mcp (stdio; it opens Editroom when needed), or at http://127.0.0.1:47920/mcp (Streamable HTTP) while Editroom is open. Add it to your MCP settings as "editroom" (or use the entry if it's already there). Until its tools appear in a new session, call the address directly. Then call get_project and list_media, and follow the instructions Editroom sends when you connect.
```

### 2.6 Windows equivalents (what we know vs UNSURE)

| Item | macOS (Editroom) | Windows (proposed) | Confidence |
|---|---|---|---|
| App data | `~/Library/Application Support/Editroom/` | `%APPDATA%\PromptEdit\` (settings, Notes, Agents); `%LOCALAPPDATA%\PromptEdit\` (Analysis, Transcripts caches) | design choice |
| Movies (export fallback) | `~/Movies` | `FOLDERID_Videos` (`%USERPROFILE%\Videos`) via `dirs::video_dir()` | known |
| Claude desktop config | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | known (documented by Anthropic) |
| Claude extensions dir | `…/Claude/Claude Extensions/` | `%APPDATA%\Claude\Claude Extensions\` | **UNSURE** (same layout assumed; MSIX/Store installs may virtualise under `%LOCALAPPDATA%\Packages\…\LocalCache\Roaming\Claude\`) |
| Claude app detection | bundle id | `%LOCALAPPDATA%\AnthropicClaude\claude.exe` or uninstall registry key | **UNSURE** |
| Open `.mcpb` in Claude | `NSWorkspace.open(withApplicationAt:)` | `ShellExecuteW("open", Editroom.mcpb)` if Claude registers `.mcpb`, else `claude.exe <path>` | **UNSURE** — fallback: write `claude_desktop_config.json` `mcpServers.promptedit = {command, args}` (needs Claude restart) |
| `.mcpb` server entry | `/bin/sh ${__dirname}/server/editroom-mcp` | `"command": "${__dirname}\\server\\promptedit-mcp.exe"`, `"compatibility.platforms": ["darwin","win32"]`, or separate per-OS `mcp_config` overrides | `${__dirname}` substitution known; per-platform override keys **UNSURE** (check MCPB spec at implementation time) |
| Codex config | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` (honour `CODEX_HOME`) | likely (Codex CLI uses `~/.codex` cross-platform) |
| Codex command | `command = "/bin/sh"`, `args=[launcher]` | `command = "C:\\…\\promptedit-mcp.exe"`, `args = ["--from","codex"]` | design choice |
| Codex CLI binary | in ChatGPT app bundle / brew / `~/.local/bin` | `%APPDATA%\npm\codex.cmd` (npm), PATH lookup, or the Windows Codex/ChatGPT app's bundled copy | **UNSURE** where the Windows ChatGPT/Codex app keeps it; Codex on native Windows was historically "experimental" |
| `~/.codex/models_cache.json` | read for model list | `%USERPROFILE%\.codex\models_cache.json` | **UNSURE** (format undocumented on any OS) |
| Claude Code CLI | `~/.local/bin/claude`, etc. | `%USERPROFILE%\.local\bin\claude.exe` (native installer), `%APPDATA%\npm\claude.cmd` (npm), PATH | likely; app-embedded copy path **UNSURE** |
| `~/.claude.json` | home | `%USERPROFILE%\.claude.json` | likely |
| PATH augmentation for CLIs | prepends `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:` | prepend `%USERPROFILE%\.local\bin;%APPDATA%\npm;` with `;` | design choice |
| Launcher that finds a moved app | shell script + `mdfind` | not needed: bridge reads app path from `HKCU\Software\PromptEdit\InstallPath` or `%LOCALAPPDATA%\PromptEdit\app-path.txt` (written by app at each start) | design choice |
| Background launch | `openApplication(activates:false)` | `CreateProcessW` of `PromptEdit.exe` (no focus steal: `STARTF_USESHOWWINDOW` + `SW_SHOWNOACTIVATE`) | known Win32; Windows foreground rules usually prevent focus theft anyway |

Windows gotchas:
- Running `.cmd`/`.bat` shims from Rust `Command`: since Rust 1.77.2 arguments are escaped for `cmd.exe` and some
  (e.g. JSON with quotes, as Editroom passes to `--mcp-config`) can be **refused**. Pass the MCP config as a temp **file
  path** to `claude --mcp-config` (it accepts a path) and avoid quote-heavy `-c` values for codex, or resolve the
  underlying `node … cli.js` / native `.exe`.
- Port 47920 bound to `127.0.0.1` only: Windows Defender Firewall doesn't prompt for loopback-only listeners (likely; verify).
- A GUI-subsystem `PromptEdit.exe` can use inherited stdio pipes, but a separate console-subsystem sidecar is cleaner (§4.2).

---

## 3. Magic

### 3.1 Entry points and settings

- The Magic button opens `MagicPopover` (380 pt wide). Settings > Magic: "Enable Magic" (`magicEnabled`, default true; off
  hides the button), "Show Magic at work" (`magicShowWork`, default true; off applies plans at once as one undo step via
  `MagicShow.applyAtOnce` + `zoomToFit`), AI apps rows, "Let AI apps edit in Editroom" (`agentsEnabled`).
- Tabs: Claude | ChatGPT | Local (`MagicAgent.Tab`, persisted in `magicTab`, default `claude`). Local tab shows an Apple logo.
- Stop: the Magic button turns into Stop; Esc also stops (`MagicShow.stopAll()` → bumps `runID`, aborts show, terminates
  the CLI process, ends thinking show).
- While Magic works the window is locked (`MagicLock.judge`): mouse/scroll/gesture/keys in the editor window blocked,
  except Esc (stop), ⌘Q/⌘H/⌘M, the Magic button, and (where allowed) Space.

### 3.2 The popover per AI tab (Claude / ChatGPT)

Shown in order:
1. Just connected → "<Name> is connected" + Continue. (Claude: "Tell it what to make. You can disconnect any time in AI Agents."; ChatGPT: "Tell it what to make. To edit from the ChatGPT app as well, quit and reopen it once.")
2. Not installed (no app and no CLI) → "Get the <Name> app" + Download.
3. Claude extension install pending → "Finish in the Claude app" + Cancel / Open Claude again.
4. Not connected → "Connect <Name>" + "No API key needed". Claude connects the **Claude app extension** if the Claude app is
   installed, otherwise Claude Code. Connecting turns AI Agents on.
5. Connected but no CLI (Claude: Claude Code not found) → "Open Claude Code once" ("Magic uses Claude Code, which comes with
   the Claude app. Open the Claude app's Code tab once, then come back.").
6. Ready → `PromptForm`: heading "What should change?" (timeline has non-audio clips) or "What should it make?", Ideas
   (lightbulb) and History (clock) menus, PromptBox, model chip + effort chip, "Uses your <Name> plan", "Make it".

`available` = connected (AI Agents on AND (Claude: claude app or Claude Code connected; ChatGPT: codex connected)) AND
runnable (CLI found).

Ideas (verbatim, fill the box):
- Improve (only with an edit):
  - Tighten it — `Make this shorter so people keep watching: open on the strongest moment, cut the slow starts and ends of shots, and drop weak or repeated shots.`
  - Cut to the beat — `Recut this to the beat of the music: cuts on beats, the biggest moments on bar starts, and end on a bar.`
  - Smooth it out — `Smooth this out: fix jumpy cuts, add a dissolve only where the scene changes, even out the sound, and fade in and out.`
  - One look — `Give it one consistent look: the same warm film grade on every shot, matched in brightness so it feels like one film.`
- Create:
  - Story — `Make the best story you can from this footage: a clear beginning, middle and end, the strongest moments where they land hardest, and shots left to breathe where it matters.`
  - Highlight reel — `Make a 30 to 60 second highlight reel of the best moments, cut to the beat of the music, opening on the strongest shot and ending on a bar.`
  - Timelapse — `Make a timelapse over the music: speed the footage up, cut out the dead space where nothing changes, keep the moments where something happens, and end on the strongest shot.`
  - Vlog — `Make an engaging vlog, up to 8 minutes: hook in the first few seconds, keep the parts where someone is talking or something happens, cut pauses, retakes and repeats, and add short titles to mark each part.`
  - Vertical reel — `Make a fast, punchy 15 to 30 second vertical video for Reels and TikTok: 1080 by 1920, a hook in the first second, quick cuts on the beat.`
- Sound:
  - Find music — `Find music that suits this video and add it to the timeline. Make sure the music is royalty free and does not require attribution.`
  - Music and levels — `Pick the best music in my Media for this edit, cut so the music and pictures land together, keep voices clear over it, and fade in and out.`

Local ideas: Improve — "Make it shorter and faster.", "Cut it to the beat of the music.", "Give every shot the Film print look.",
"Take out repeats and weak shots, and trim long shots."; Create — "Make a new quick cut of the best moments, to the beat.",
"Make a fast 30 second highlight cut to the beat.", "Make a 20 second vertical video, fast.", "Speed every shot up 8x, over the music.",
"Make a calm 60 second cut."; Sound — "Make all audio clips the same output level."

Placeholders: AI with edit: `Describe what to change, or leave this empty and <Name> will make the best video it can from your Media.`;
AI empty: `Describe the video you want, or leave this empty and <Name> will make the best video it can from the clips and music in your Media.`;
Local with edit: `Describe what to change (length, pace, look, music, vertical), or leave this empty to improve the edit.`;
Local empty: `Describe the video you want (length, pace, look, music, vertical), or leave this empty for the best cut.`

Models (hard-coded, `MagicAgent.models`):
- Claude: `claude-opus-5-5` "Opus 5.5" (Best edits), `claude-sonnet-5-5` "Sonnet 5.5" (Fast), `claude-haiku-5-5` "Haiku 5.5"
  (Fastest), `claude-fable-5-2` "Fable 5.2" (Most capable); efforts `low, medium, high, xhigh, max`, default `medium`.
- ChatGPT: `gpt-6.2-sol` "GPT-6.2-Sol", `gpt-6.2-astra` "GPT-6.2-Astra", `gpt-6.1-terra` "GPT-6.1-Terra", `gpt-6-luna` "GPT-6-Luna",
  filtered by `~/.codex/models_cache.json` (`models[].slug`; if the cache lists models, unlisted picks are hidden); efforts from
  `supported_reasoning_levels[].effort` minus `ultra`, else `low, medium, high, xhigh`; default `default_reasoning_level` or `medium`.
- Persisted `magicModel.<claude|chatgpt>`, `magicEffort.<…>`. Effort labels: `xhigh` → "Extra high", else capitalised; blurbs low "Quickest", max "Slowest".
- Note detail: `"<Model> · <Effort> · <N>s"`.

### 3.3 The prompt box, @mentions and times

`PromptBox` + `MentionField` (an `NSTextView`):
- Height grows with text: min 66 pt, max 198 pt then scrolls. Font 12.5 pt; mentions and recognised times bold.
- Return sends; ⇧Return newline; when the @ list is open ↑/↓ move, Return/Tab pick, Esc closes the list (a second Esc closes the
  popover). IME composition (marked text) is left alone.
- ↑ in an empty box (no list) recalls the latest prompt from history; repeated ↑ goes older, ↓ newer, back to empty.
- On appear: if empty (or just `@selected`), prefilled with `"@selected "` when clips are selected, else cleared.
- The prompt text is kept on `MagicAgent.prompt` across popover closes; cleared when sent.
- Typing `@` (not preceded by an alphanumeric, ≤60 chars back on the same line) opens the list with the query after it.

Mention syntax (`MagicMention.find`), case-insensitive, whole-name (next char must not be a word char), longest match wins:
- `@playhead`, `@selected`, `@in-out`
- `@<file name>` or `@<name without extension>`; `@media:<name>` (same)
- `@clip:<label>` — one timeline clip; label = file name / title text (cut to 22 chars + "…" if > 24) / "Solid", duplicates
  `·2`, `·3` in time order; linked audio of a video isn't listed.
- `@marker:<name>` or `@<marker name>` (a file of the same name wins); unnamed markers are "<Colour> marker".
- Not inside an e-mail address (`me@example.com`).

The @ list (`MentionOption.list`): `@selected` (greyed "Select clips first" if none; detail "N clips"), `@playhead` (clock),
`@in-out` (if set), `@media:` (opens file list; `@media:video|videos|audio|sound|music|photo|photos|image|images` filters by kind),
`@clip:` (opens clip list; kind words `text/title/solid/video/audio/photo…` filter), `@marker:`; typed letters also list
matching markers and files (prefix first, then substring unless the query has a space). Clock in list: `m:ss.s`.

Typed times (`MagicTimes`): `hh:mm:ss:ff` / `hh:mm:ss;ff` (frames at project fps), `h:mm:ss(.s)`, `m:ss(.s)`, and `5s`/`5 sec`/`5 seconds`
(unit-only: only counts inside a span). Span: "between A and B", "from A to B" (connectors `and to - – — through until till`), or two
clock times "A to B". Markers named in the request are rewritten to their clock time first (`markersAsTimes`, `clock()` →
`m:ss.ss` trimmed, `h:mm:ss.ss` over an hour).

`MagicPointers` captured when "Make it" is pressed (before the lock clears the selection): `playhead`, `selected` (clip ids in
timeline order), `range` (in/out).

### 3.4 Claude / ChatGPT run (`MagicAgent.start`)

They do **go through the MCP server**, but via a private **draft** endpoint, driven by the vendor CLIs in headless mode using the
person's own subscription (no API key):

1. Guard: not already running; `AgentConnect.refresh()`; kind in `available`; CLI path found.
2. `pointers = MagicPointers.now(model)`; `model.pause()`; status "<Name> is starting".
3. `serverReady()` (§1.4) else alert "Couldn't start Magic" / "Editroom couldn't open its connection for <Name>."
4. Sign-in check: Claude `claude auth status --json` → `loggedIn`; Codex `codex login status` output contains "logged in" and not
   "not logged in". If not: alert "Sign in to <Name>" (Claude: "Magic uses Claude through Claude Code on this Mac, with your Claude
   plan. It needs signing in once, in your browser."; ChatGPT: "Magic uses ChatGPT through Codex, which comes with the ChatGPT app,
   with your ChatGPT plan. It needs signing in once, in your browser."), buttons Sign In / Cancel → `claude auth login --claudeai`
   or `codex login`; status "Signing in to <Name>".
5. `MCPDraft.open(model.project)` (token = 32 lowercase hex), `draft.playhead = pointers.playhead`; status "<Name> is thinking";
   `MagicThinking.begin(name, color)`.
6. Spawn the CLI with cwd `~/Library/Application Support/Editroom/Magic/` (empty folder so no project CLAUDE.md/AGENTS.md is read),
   env PATH augmented, **brief written to stdin then stdin closed**.

Claude Code args (verbatim order):
```
claude -p --output-format stream-json --verbose --no-session-persistence
       --mcp-config {"mcpServers":{"editroom":{"type":"http","url":"http://127.0.0.1:<port>/mcp?draft=<token>"}}}
       --strict-mcp-config
       --tools WebSearch,WebFetch
       --allowedTools mcp__editroom WebSearch WebFetch
       --disallowedTools mcp__editroom__auto_edit mcp__editroom__import_media mcp__editroom__save_project mcp__editroom__export
       [--model <id>] [--effort <effort>]
```
Codex args (verbatim order):
```
codex --search exec --json --ephemeral --skip-git-repo-check --ignore-user-config
      -s read-only -C <magic folder>
      -c mcp_servers.editroom.url="http://127.0.0.1:<port>/mcp?draft=<token>"
      -c mcp_servers.editroom.tool_timeout_sec=300
      -c mcp_servers.editroom.startup_timeout_sec=30
      -c approval_policy="never"
      [-m <model>] [-c model_reasoning_effort="<effort>"]
      -
```
7. Stdout parsed as JSON lines:
   - Claude: `type=="assistant"` → last `tool_use.name` (strip `mcp__editroom__`) drives status; last `text` → `lastMessage`.
     `type=="result"` → `result` is the final message; `is_error` or `subtype != "success"` → failure.
   - Codex: `item.started` + `item.type=="mcp_tool_call"` → `item.tool`; `item.completed` + `agent_message` → `item.text`;
     `turn.failed` → `error.message` (default "ChatGPT stopped."); `type=="error"` → `message`.
   - Status verb map (`"<Name> is <verb>"`): list_media/get_project/list_looks → reading; look_at_media → watching; note_media → noting;
     analyze_media → studying; get_transcript → listening; add_clip/trim_clip/move_clip/split_clip/delete_clips/set_sequence/add_track
     → cutting; set_grade → grading; add_title/set_title_style → titling; search_media → searching; set_marker/delete_markers/set_in_out
     → marking; set_transform/freeze_frame/reverse_clip/detach_audio/duplicate_clip/add_solid/set_solid_color/set_track → editing;
     set_audio/set_transition → finishing; get_frame/playback/history → checking; else thinking.
   - In parallel, the server-side `MCPHandler.describe()` gives a finer activity line on the Magic button for ~1.5 s per call
     ("looking at <asset>", "placing <asset>", "trimming <clip>", "searching for “…”", "downloading “…”", "undoing a step", …; names
     cut to 23 chars + "…"), via `MagicState.begin/finish(activity:)`.
   - Stderr captured (≤ 20 kB per chunk) for error alerts.
8. On exit (+300 ms grace) `finish(code)`: if stopped → nothing. No edits + failure → alert "<Name> couldn't make the edit" (≤600 chars);
   no edits + non-zero exit → alert with stderr tail or "It stopped (code N)."; no edits otherwise → note "<said>" or
   "<Name> didn't change anything." (changed=false). If the app is in the background: `requestUserAttention(.informationalRequest)` (Dock bounce).
9. With edits: `MCPDraft.resultPlan(base: model.project /* as it is now */, edits:)` → `MagicShow.fit` + thinking `handOver()` →
   `MagicShow.play(plan)` (multi-cursor swarm) → note `{agent, text: said, changed: true, detail}`. If no timeline is visible:
   `model.mutate` applies the edits directly.

Brief sent on stdin — `MagicAgent.brief(request:project:pointers:)`, paragraphs joined by blank lines. Verbatim:

```
You're the editor in Editroom, the video editor open on this Mac. Use only the editroom tools, and don't stop to ask anything: nobody can answer until you've finished. If what they wrote isn't about the video (a question, a chat), just answer it in a sentence or two: don't look at the media or change anything.
```
then one of:
- empty request + edit: `They didn't ask for anything in particular: make the edit on the timeline better, the way a skilled editor would.`
- empty request, no edit: `They didn't ask for anything in particular: make the best short video you can from the library, the way a skilled editor would cut it to share.`
- else: `What they asked for: "<request>"`

then the pointing block (below) if any, then:
- with edit: `The timeline already has an edit (%d clips, about %.0f seconds). Work on that edit: change it to do what they asked, and keep what already works. Don't delete it and start again unless they asked for something new.` (clips = non-audio clips; seconds = project duration)
- else: `The timeline is empty: build the video from the library.`

then (verbatim):
```
Use what's in the library (list_media) and Editroom's own titles, transitions, colour and sound levels. The one thing you can add is music or sound you find online, with download_media (see below). If what they asked for needs something else the library doesn't have (a logo, more footage), do the best you can without it, and say what was missing at the end.

Finding music or sound: only when they ask for it, or the edit clearly needs music and the library has none. Search the web for tracks that are royalty-free and need no attribution (for example CC0, or a site licence that says no credit is required), and read the licence to make sure. Choose one that suits the footage's mood and pace. Then download_media the direct link to the audio file (not the web page), with the page you found it on and what the licence says, and use it like any other music. Never take music from a place that doesn't clearly allow it. At the end, name the track, where it's from and its licence.

Your edits go into a draft that the person sees all at once, played onto their timeline, when you finish. So take the time to get it right; if a step goes wrong, history undoes it.

How to work:
1. get_project and list_media.
2. list_media says what each clip "shows" (seen on this Mac): a quick guide to find shots by what's in them, and search_media finds shots by what they show or what's said in them, with times. Look at the footage with look_at_media to see what's in each shot, then save what you saw with note_media. A clip whose list_media "notes" already say what's in it needn't be looked at again unless you need an exact frame. If people talk in it (list_media says "speech"), get_transcript gives what's said with times: cut pauses, retakes and filler between sentences, keep sentences whole, and put other shots over the talking where it helps. For captions or subtitles, use set_captions, never add_title: it captions what's said, timed to the speech, and keeps up with every later edit; its edit option fixes a misheard word or takes a caption out. analyze_media finds a clip's best moments, or a song's tempo and bar starts.
3. Choose. Leave out shots that are blurry, dark, shaky, accidental, near-duplicates of a better one, or screenshots. Find an order that tells something: an opening that sets the scene, a build, the best moments, and a shot that feels like an ending. Prefer moments where something happens, faces and expressions, and variety of framing.
4. Cut. Shots on V1 back to back with no gaps, using source_start and duration (or trim_clip) to keep just the best part of each. With music: the song on A1 from 0, cut on bar starts or beats, shorter shots where the music is busy and longer where it's calm, end on a bar start, and turn the clips' own sound down to about -20 dB unless someone is talking and it matters. Without music: keep the clips' sound and cut where the action or sound makes a natural break. If most of the footage is vertical and the timeline is empty, set_sequence to 1080 by 1920 first.
5. To make an edit shorter or keep people watching: open on the strongest moment, cut the slow starts and ends of shots, drop weak or repeated shots, and close every gap (delete_clips with ripple, or move clips).
6. Speed: set_speed speeds a clip up (4 to 20 times for a timelapse) or slows it down. Turn a sped-up clip's own sound right down (set_audio gain_db -60) unless they asked to keep it. set_speed_ramp eases the speed within a clip: a slow-motion moment on the best part of an action (look at the frames to find it), fast-normal-fast on travel shots, or ramping up into a cut and down out of it on the next shot. Use ramps when asked, or sparingly where they make the moment. set_transform's zoom pushes in on a moment or follows the action in a screen recording (focus_x and focus_y say where to look): use it when asked, or sparingly. For a long video like a vlog, keep what people say whole, and use short titles to mark each part.
7. Finish. Colour only when they asked for it, or when the footage clearly needs it (look at the frames): shots from different cameras or light that don't match, or shots too dark or washed out. Then one look from list_looks, or small set_grade fixes, on every shot so it feels like one film. Otherwise leave colour as it is, and on an existing edit don't change colour unless they asked. set_transform reframes a shot (to keep a subject in a vertical frame); set_title_style sets a title's font, size, colour and place. Markers (set_marker), the in/out range, freeze frames, reversing, detaching sound, track switches and solids only when they ask for them. Titles and text only when they asked for them, or the kind of video needs them (a vlog's parts); most videos don't. Fade music out over the last 2 seconds. A dissolve or dip to black only where it helps, never on every cut.
8. Check a few moments with get_frame and fix what's wrong.

When you're done, write one or two short sentences for the person: what you made or changed, and anything you couldn't do and why. Plain words, no lists, no ids.
```

Pointing block (`MagicAgent.pointing`), only when the timeline has clips or the request has mentions. Clip phrase:
`"<name>" on V1 1.00s-3.00s (id <UUID>)`; times `%.2fs`.
```
Where they were in the editor when they asked:
- Playhead: 12.34s[, over <clip>; <clip>]          (non-audio clips under it, top track first)
- Selected: nothing | N clip(s): <clip>; <clip>
- In/out range: 1.00s to 5.00s | none
They pointed with @: <sentences, sorted> Act on exactly what they pointed at.
Times in their request: "<span text>" is A to B on the timeline[, over …]. "<typed>" is Xs (if it's a place on the timeline[, over …]; it may be a length instead).
Use the playhead, selection and range only when their words point at them ("here", "this clip", "these", "this spot", "from here on", or an @). Otherwise the request is about the whole edit, whatever happens to be selected.
```
Mention sentences: `@playhead means the playhead above.`; `@selected means exactly the selected clips above, no others.` /
`@selected: nothing was selected, so do the best you can from the rest of what they said.`; `@in-out means the in/out range above.` /
`@in-out: no in/out range was set, so do the best you can from the rest of what they said.`; `@<file> means the library file <file> (asset_id <UUID>).`;
`@clip:<label> means exactly one clip on the timeline: <clip phrase>.`; `@<marker> (or @marker:<marker>) means the marker "<marker>" at 12.00s on the timeline.`

### 3.5 Plan format (`MagicPlan.swift`)

- `MagicEdit` (one human-sized action, applied with progress `p` ∈ [0,1], cubic ease-in-out `MagicEase.inOut`):
  | case | apply | cursor label | performTime (s) |
  |---|---|---|---|
  | `place([Clip], asset: UUID?)` | at p≥1 append, `resolveOverlaps(keeping:)` (overwrite) | Music / Title / Place | 0.5 |
  | `trimHead(ids, from, to)` / `trimTail` | edge animates (frame-snapped), overlaps resolved at end | Trim | 0.28 |
  | `move(ids, from, to, tracks: [clip: track])` | delta animates; track switch at e ≥ 0.5 | Move | 0.42 |
  | `blade(ids, at, pieces: [old: new], link)` | split; right piece fadeIn=0, left fadeOut=0, new link id | ✂ Cut | 0.16 |
  | `remove(ids, ripple)` | `project.remove(ids:ripple:)` | Delete | 0.14 |
  | `change(clipID?, label, (inout Project)->Void)` | closure at p≥1 (nil clip = sequence-level "barrier") | label | 0.16 |
  | `type(id, text)` | types `prefix(n)` | text so far + `|` | 0.12 + 0.045·chars |
  | `gain(id, from, to)` | dB to 0.1 | "−12 dB" | 0.24 |
  | `fadeIn(id, to)` / `fadeOut` | animates, `clampFades` | Fade in / Fade out | 0.22 |
  | `look(id, name)` | at end | look name | 0.1 |
  | `grade(id, key ∈ exposure/contrast/saturation, to)` | at end (ranges ±2, ±50, ±100) | key label | 0.2 |
  | `transition(id, Transition)` | at p≥0.85 | kind label | 0.46 |
- `MagicTask { edit, after: [taskIndex], delay }`, `MagicPlan { base: Project, tasks }`. Tasks form a DAG; the swarm hands each
  ready task to a cursor. `inSteps()` splits multi-clip trims/removes into one task per link-group, staggered 0.07 s.
- **Porting note**: `change` carries a Swift closure — not serialisable. In Rust, model `MagicEdit` as an enum whose `Change`
  variant holds a typed `ProjectOp` (or a full "after" clip/project patch, as `resultPlan.rest` already does), so plans can cross the
  Rust↔TS boundary.
- `MCPDraft.plan(base, edits)`: dependency inference by footprint (clip ids touched incl. overwritten/rippled, track spans;
  `change(nil)` or track/size/fps changes are barriers; plain deletes don't depend on each other; per-clip settings don't depend on
  each other; transitions treat touching as overlapping, slack 1e-3). Transitive reduction of `after`.
  Runs of ≥2 ripple deletes become plain deletes + one "Close gaps" change.
- `MCPDraft.resultPlan(base, edits)`: replays an AI's step-by-step edits as a *result*: removed groups lifted first; non-clip
  project changes (tracks, sequence, markers, library) as one "Sequence" change; changed clips → move / trimHead / trimTail
  when shape allows, then setting edits (gain, fades, look/grade, transition, type) and a final "Edit" change for anything else;
  new clips placed bare then given settings. Verified: if applying it doesn't land **exactly** on the AI's final project (clips and
  rest), falls back to `plan(base, edits)`.
- `Choreographer.plan(project, decision)` (Local new cut): clears clips/in-out, ensures ≥2 video and 2 (3 with music) audio tracks,
  unlocks all; rough cut of shuffled long shots (head 0.35–0.8 s, tail 0.35–0.85 s handles) on V2/A2, every 3rd shot (`i%3==1`,
  head > 0.2) has its head bladed off and deleted, others trimHead/trimTail, then moved to V1/A1. Music placed first on A3 with
  fade-in 0.3, fade-out `min(fadeOut, dur/3)`, gain −2. Title (if asked) on V2: length `min(3, max(2, total·0.12))`, size 130,
  start or end, typed, fade-in 0.4, fade-out 0.5. Per shot: gain, alternating 0.2/0.25 audio fades, dissolves, last shot fade to black
  0.6, look + contrast 12 + saturation 18, exposure if |exp| ≥ 0.2. Deterministic `SeededRandom` (LCG `x*6364136223846793005+1442695040888963407`,
  seed `shots·7919 + assets.count`).

### 3.6 Local planner pipeline (`LocalMagic.run` in MagicPopover.swift)

Empty request → `MagicShow.start(model, fromMouse:false)` (improve existing edit with `LocalImprover`, or new cut with
`AutoPlanner` + `Choreographer`). Note "On this Mac · Ns".

With a request (only offered when `LocalBrain.available`; otherwise the Local tab shows the unavailability reason and only "Make it" for the empty request):
1. `typed = markersAsTimes(request)`; `pointers`; `pointed` = @media ids; `request = MagicMention.plain(typed)` ("@selected" → "the selected clips", "@in-out" → "the marked range", "@playhead" → "the playhead", files → names, `@clip:x` → "the clip x", markers → clock).
2. Thinking show "Local" (white cursor), status "Reading your request". Router, first match wins:
   1. `LocalSpeech.asks` (dead space/air, pause, silence, um/ums/uhs, filler, jump cut, tighten the talk/speech/what) → hears clips
      (`Transcripts.ready(limit: 60)`) → `LocalSpeech.plan`: on the main video track, keep talk (gaps < 0.45 s joined) with 0.12 s before /
      0.2 s after, cut gaps ≥ 0.3 s on that track and its linked-sound tracks, rippling.
   2. `LocalZoom.asks` (zoom, push/punch in, ken burns) → zoom on @clip/@selected/selected or top clip under playhead; mode in / out / in_out,
      "linear/steady/even pace/constant" = not smooth, scale from "2x"/"150%"; "remove/no zoom…" = off.
   3. `LocalCombined.parts` > 1 of {add, title, captions} → each in order on the running result.
   4. `LocalCaptions.asks` (caption/subtitle/…, not quoted text, not a new cut, and there's audio or it's a removal) → add/remove caption track.
   5. `LocalAdd.asks` (verb add/put/append/insert/stick/throw in/include + thing clip/shot/video/photo… + place word, edit exists, not a new cut)
      → count ("one/two/couple/few/3…" ≤ 20), spot (before/after @selected/@clip/@file/"third clip"/marker/playhead/typed time/start/end),
      shots 2–5 s from the middle of unused (or named) files, ripple-insert.
   6. `LocalTitle.asks` (edit exists, not a new cut, `titleAsked`) → title at start / end / playhead / typed time; length `min(3, max(1, edit·0.25))`,
      size 130, quoted words or "Title", fades 0.4/0.5, first free video track above V1 or new one.
   7. `LocalRamp.asks` ("ramp", "slow-mo moment") → at cuts (shot before speeds up into cut, after slows out; default 4×) or a moment
      (around playhead or middle, ±20 % of the source with 10 % eases; default 0.3×, "fast/speed up" 3×).
   8. Otherwise **`LocalBrain.recipe`** (Apple FoundationModels) → then heuristics fill/override fields: `speed`, `soundEffects`,
      `askedJudgement`, `title`, `titleAtEnd`, `wholeLibrary`, `shots`, `every`, `levelAudio` (+ `model.levelGains(matchOutput:true)` per
      unmuted unlocked audio clip), `onlyAsked = !isGeneral`, and strips handled items from `cannotDo`.
      - `LocalPointed.plan` (reorder shots by name: "put @b in front of @a", "swap", "move … to the end", "open on"; "add video of the girl eating";
        @selected/@clip remove-ripple / speed / look; range keep-only / remove / speed / look; playhead "end here" / "start here" / split).
      - else if recipe empty and not general → note: `Local can't do <what>. It can change the length, the pace, the look, the music, the frame shape (vertical, square), and which files to use or take out, by name. For anything that needs understanding what's in your shots, use Claude or ChatGPT.`
        or for a question: `Local only edits your video, so it left it as it was. To ask a question, use Claude or ChatGPT.`
      - else `MagicShow.start(recipe:)` → `LocalImprover.plan` (edit exists and not `wholeLibrary`) or `AutoPlanner.decide` + `Choreographer`;
        frame shape → base 1080×1920 / 1920×1080 / 1080×1080 with `settingsLocked`; captions added afterwards via `amendLastStep` (same undo step).
3. Each ready-made outcome: thinking show sketches the final project (ghost clips), holds `min(2, max(0.8, secondsUntilDrawn+0.35))`, hands
   over, swarm plays. Notes are `MagicAgent.Note(agent: nil, …)` with detail "On this Mac · Ns".

Pure-heuristic (portable as-is to Rust): `LocalSpeech`, `LocalZoom`, `LocalRamp`, `LocalCaptions`, `LocalCombined`, `LocalAdd`, `LocalTitle`,
`LocalPointed`, `LocalImprover`, `AutoPlanner` (scorer, moments, decide, title-from-dates), `Choreographer`, `MCPDraft.plan/resultPlan`,
`MagicMention`, `MagicTimes`, all `LocalBrain` helpers except `recipe()` (`isGeneral`, `asksJudgement`, `shotCount`, `wantsEvery`,
`wantsLibrary`, `titleAsked`, `quotedWords`, `wantsSoundEffects`, `wantsLevels`, `speed`, `applyMedia`, `checked`, `named`, `showing`,
`askedPhrase`, `moments`), `MediaAnalyzer.FrameMeasure` and `beats()` (needs an FFT; vDSP → `rustfft`).

Needs Apple frameworks:
| Piece | Apple API | Used for |
|---|---|---|
| `LocalBrain.recipe` | **FoundationModels** `LanguageModelSession` + `@Generable RecipeOut` (macOS 26) | request → settings |
| `SceneTags.describe` (Engine) | **FoundationModels** with `.vision` capability (macOS 27) | ≤12 keywords per frame (supplements Vision tags) |
| `SceneTags.classify` (Engine) | Vision `VNClassifyImageRequest` | "shows" tags for list_media/search_media/LocalBrain.showing |
| `MediaAnalyzer.faces` | Vision `VNDetectFaceRectanglesRequest` | `faces` per sample |
| `MediaAnalyzer.aesthetics` | Vision `VNCalculateImageAestheticsScoresRequest` (macOS 15) | `aesthetic` −1…1, `utility` (screenshot/document) |
| Transcripts (Engine) | Speech `SpeechTranscriber` (macOS 26) | get_transcript, captions, LocalSpeech |
| Frame/audio decode | AVFoundation | sampling, PCM |
| FFT | Accelerate vDSP | beat tracking |

FoundationModels prompts (verbatim):

`LocalBrain.recipe` instructions (`<names>` = library file names joined with ", "):
```
You turn a person's request for editing their video into settings. Set a field ONLY if their words ask for it; every other field stays "unchanged" (seconds stays 0). Most requests change one or two fields. The editor can only: set a length, make the pacing calm or fast, put one colour look on every shot or take looks off, turn music off or add music from their library, and make the frame vertical, horizontal or square. If they ask for something else (sound effects, a title or text, a particular story, effects), write just that in cannotDo, in their words; otherwise leave cannotDo empty. Never mention anything they didn't ask for. Their media files are: <names>. If they name files to use only those, mediaAction is "only"; to take them out, "remove". Naming files isn't something to put in cannotDo.
```
User prompt = the plain request. Guided output (`@Generable(description: "Settings for editing a video, from the person's request")`):
```
seconds:     Int,    "How long the video should be, in seconds; 0 if they didn't say", range 0...900
pace:        String, "Pacing: calm (longer, slower shots), fast (short, punchy shots), or unchanged", anyOf [unchanged, calm, fast]
look:        String, "One colour look for every shot, none to take looks off, or unchanged", anyOf [unchanged, none, Warm film, Golden hour, Film print, Teal and orange, Pastel, Bleach bypass, Mono, Cool night, Faded]
music:       String, "Music: off to remove it, add to put a song from their library under it, or unchanged", anyOf [unchanged, off, add]
frame:       String, "Frame shape: vertical (for phones, Reels, TikTok, Shorts), horizontal, square, or unchanged", anyOf [unchanged, vertical, horizontal, square]
cannotDo:    String, "What they asked for that these settings can't do, in a few plain words; empty if nothing"
mediaAction: String, "If they name media files: only (use just those), remove (take those out), or unchanged", anyOf [unchanged, only, remove]
```
Post-processing `checked()` drops any field whose topic words aren't in the request (length needs a number + time unit or
"long/length/duration" + digit; music off needs "no/without/remove/off/mute/silent/drop/take out"; cannotDo parts must share a ≥4-letter
word prefix with the request and not be about a handled topic). Errors: `"Apple Intelligence couldn't read that: <error>"`.
Unavailable reasons: "Turn on Apple Intelligence in System Settings to describe what you want." / "Apple Intelligence is still getting ready on this Mac." /
"Describing what you want needs a Mac with Apple Intelligence." / "Describing what you want needs macOS 26 or later with Apple Intelligence."

`SceneTags.describe` instructions:
```
You label video frames for search. Reply with one line: up to 12 short comma-separated keywords for the place, vehicles, objects, activity and people's expressions. Plain words, no sentences.
```
prompt `"Keywords for this frame:"` + image; output split on commas, ≤30 chars and ≤3 words each, ≤12.

`MediaAnalyzer` details (portable maths): video sampled every `max(0.25, dur/60)` s at ≤320 px (±0.12 s); per sample: luma (mean of
160×90 grey), sharpness (Laplacian variance), motion (mean abs diff vs previous sample /255), colourfulness (Hasler–Süsstrunk on
48×27, /110, ≤1.5); faces every other sample; aesthetics ~1/s. Photo: duration 5, creation date from file. Music: mono 22.05 kHz,
1024-pt Hann FFT hop 512, spectral flux + bass envelopes, local-mean detrend (±0.25 s), tempo autocorrelation 70–180 BPM step 0.2,
log-Gaussian prior around 120 BPM (σ 0.9 octave), phase search, ±8 % onset nudging, straight-line fit if residual < 30 ms, bar phase by bass,
per-beat RMS energy normalised. `AutoPlanner.scorer`: `0.36·sharp + 0.2·exposure + 0.14·colour + 0.16·faces + (0.26·(aes+1)/2 or 0.12) − 0.35·utility − motion penalty`.
`AnalysisWarmer` warms analysis in the background after import, one file at a time (`warm(url, kind, song)`).

### 3.7 History (`MagicHistory`)

Per project, stored in the project file as `magicHistory: [{text, tab: "claude"|"chatgpt"|"local", date}]`, newest first, deduplicated
by text, max 20. Added when a prompt is sent (empty prompts not added). **Not affected by undo/redo** (`undo()` copies the current
`magicHistory` onto the restored project). History menu: header "History", empty → "Prompts you send show up here.", rows wrapped to
two lines of ~34 chars with "…", tab badge on the right, 8 rows visible then scrolls; clicking fills the box.

### 3.8 Undo

- `EditorModel` keeps whole-project snapshots (`undoStack` ≤ 200). The swarm uses `live(autoCommit:false)` while animating and
  `commitLive()` at the end: **one Magic run = one undo step**. Stopping mid-show `discardLive()`s (no step).
- Note view has Undo (calls `model.undo()`) when `changed`, and Done (Return/Esc); Space toggles playback while the note is up.
  Markdown inline links in the AI's note are clickable.
- Captions added after a Local cut use `amendLastStep` (same undo step).
- Live MCP calls: one undo step per call (§1.6). Draft runs: the AI's `history` tool works on the draft only.

### 3.9 The shows (UI only)

- `MagicThinking`: dims the app; stages only forward Looking → Analyzing → Thinking; scan brackets and sweep lines over Media items,
  timeline clips and viewer; dot-field shimmer on the viewer; dashed ghost clips of the coming edit (`plan(project)` called after every
  editing tool in a draft run, and with the final project for Local). In AI runs, tool calls drive it: look_at_media/analyze_media →
  `focus(asset)`, list_media/get_project/list_looks → `look()`, get_frame → `think()`, editing tools → `plan(draft.project)`.
- `MagicShow`: multi-cursor swarm playing a `MagicPlan`'s DAG; cursors leave the Magic button (or the click point if planning took
  < 1.5 s), drag from the Media panel, trim edges, open a transition menu, stack grade cards in the inspector, type titles. Starts
  unhurried and speeds up (`tempo(t) = 0.72 + 1.1·e^(−t/0.8)`); off-screen windows keep a clock so the show still finishes. At the end:
  commit, `zoomToFit`, seek 0, paused.
- Colours: Local cursor white (0.95); Claude `#D97857` (sRGB 0.85, 0.47, 0.34); Codex/ChatGPT `#0FA380` (0.06, 0.64, 0.50); other
  names: FNV-1a-64 of UTF-8 name → hue `h % 360`, saturation 0.65, brightness 0.95.

### 3.10 Agent presence (`AgentPresence`)

- After a live agent's call, its cursor is parked where it stopped, in a transparent click-through child window over the editor:
  cursor image 18×24 (hot spot 2,2) plus a name tag (system 10 pt semibold white on the agent colour blended 18 % toward black,
  corner radius 4, height 16, width text+12) at offset (+10 + w/2, +26).
- Bobs `sin(now·2.2 + hash(name)%7)·2` px; lingers **12 s** after the last call, fading over the last 0.5 s; updated at 30 Hz.
- The next call by the same name `take()`s it and starts from there; otherwise from the Magic button.

---

## 4. Recommended cross-platform design

### 4.1 MCP server (Rust, in `src-tauri`)

- Keep the **wire contract identical**: `127.0.0.1:47920`, path `/mcp`, `?draft=<token>`, JSON replies (no SSE), `Mcp-Session-Id`,
  `X-Editroom-From` (rename to `X-PromptEdit-From` but accept both), Host/Origin checks, the 202/403/405/404/400 behaviour, the ephemeral-port
  fallback, protocol versions, `instructions`, tool names, titles, descriptions, schemas and error strings (minus "on this Mac" →
  platform-neutral wording, see risks). Agents' prompts and Editroom's brief depend on the text.
- Implementation: either `rmcp` (official Rust SDK) with its streamable-HTTP server, or a ~200-line hand-rolled JSON-RPC handler on
  `axum`/`hyper`. The surface is tiny (initialize, ping, tools/list, tools/call, 3 empty lists) and Editroom's behaviour is non-standard in
  small ways (no GET stream, `Connection: close`, answering resources/prompts without capabilities, custom header checks), so
  **hand-rolled on axum is recommended** for exact parity; use `rmcp`'s model types (`Tool`, `CallToolResult`) only if convenient. **UNSURE**
  whether current `rmcp` can be configured for JSON-only (non-SSE) responses.
- Put tool **definitions** (static JSON) and the handshake in a small shared crate (`crates/mcp-schema`) used by both the app and the bridge.
- Tool **handlers** call `crates/core` edit functions (same as UI commands), returning `Vec<MagicEdit>`; live mode emits them to the UI for the
  agent-cursor animation and awaits an "animation done" event before replying (with a timeout and a no-window fallback that applies directly).
- Drafts: `HashMap<token, Draft>` in Rust core; `Draft` = base, project, steps, undone, playhead, calls.
- Image results: contact sheet (JPEG) built in Rust from FFmpeg-extracted frames (`image` + `ab_glyph`/`imageproc` for labels); `get_frame`
  needs the WebGL compositor → request a frame render from the UI (or an offscreen render path) and return PNG.

### 4.2 Bridge

- Ship a separate tiny **console** binary `promptedit-mcp` (Rust, no Tauri/webview; Tauri `externalBin` sidecar) on both OSes instead of re-entering
  the GUI exe with `--mcp`. Reasons: Windows GUI-subsystem stdio quirks, faster start, no second app instance, no single-instance plugin conflicts.
  Keep `PromptEdit --mcp` as an alias that execs the sidecar for parity with the copy-prompt text.
- Same algorithm as §1.5 (local handshake, held hello, launch on first `tools/call`, 20 s retry, one-line replies), but return a proper JSON-RPC
  error for non-2xx-without-body.
- Launch: macOS `open -g -b <bundle id>` (or `LSOpenCFURLRef` without activation); Windows `CreateProcessW` on the path from
  `HKCU\Software\PromptEdit\InstallPath` (written by the app on each start) with `SW_SHOWNOACTIVATE`. Use `tauri-plugin-single-instance` in the app.
- The bridge path given to Claude/Codex should be the installed sidecar's absolute path; refresh registrations on app start (equivalent of
  `followMove`). On macOS keep a shell launcher only if the sidecar path inside the .app can change on update (it shouldn't).

### 4.3 Agent connect

- Port `AgentConnect` to Rust with a per-OS path table (§2.6). Claude: build the `.mcpb` with the `zip` crate; on Windows set
  `compatibility.platforms` to include `win32` and point `mcp_config.command` at `${__dirname}/server/promptedit-mcp(.exe)` with the binary
  copied into the extension, or at the installed sidecar. Provide a fallback "write `claude_desktop_config.json`" path with a "restart Claude"
  note when opening the `.mcpb` isn't possible. Codex: same TOML section logic (use `toml_edit` to preserve formatting rather than
  line-scanning, but keep the identical output for the section and the one-time backup); honour `CODEX_HOME`. Claude Code: same `claude mcp add`
  arguments.
- CLI discovery: PATH search (`which` crate) plus the known locations per OS.

### 4.4 Magic AI (Claude / ChatGPT)

- Port `MagicAgent` to Rust (`tokio::process`): same CLI flags, same brief, same stream parsers. On Windows pass the `--mcp-config` JSON via a temp
  file and avoid `.cmd` quoting problems (§2.6). Use a per-OS empty working folder (`%LOCALAPPDATA%\PromptEdit\Magic`).
- Model lists: keep hard-coded Claude ids; keep reading `models_cache.json` for Codex.
- Attention request when backgrounded: Tauri `window.request_user_attention(Informational)` (Dock bounce / taskbar flash).

### 4.5 Local

- Port all heuristics (§3.6 list) to Rust 1:1 with unit tests ported from SelfTest where possible.
- Replace FoundationModels `recipe()` with a **`RecipeReader` trait**:
  1. `LlmReader`: local LLM with JSON-schema-constrained output — Ollama (`/api/chat` with `format` = the RecipeOut JSON schema) if the
     user has it, or a bundled/downloaded `llama.cpp` (`llama-cpp-2` crate, `json_schema`/GBNF grammar) with a ~3–4B instruct model
     (e.g. Qwen2.5-3B/Llama-3.2-3B Q4_K_M, ~2 GB) as an optional download — Apple's model is ~3B, so similar quality is plausible.
     Same instructions text, enum constraints → JSON schema `enum`s, `seconds` integer 0…900.
  2. `KeywordReader`: a deterministic fallback using the existing `checked()` vocabularies (length regex, pace words, look names, music words,
     frame words), so Local with a prompt works with **no model at all** (better than Editroom on Macs without Apple Intelligence).
  `checked()` and `applyMedia()` run after either reader, unchanged.
- `SceneTags.describe` (frame keywords) → CLIP zero-shot tags (already planned) or the same local VLM if one is installed; optional.
- Vision replacements: faces → small ONNX detector (YuNet/UltraFace via `ort`); aesthetics → LAION aesthetic head on CLIP embeddings
  (map 1–10 → −1…1); `utility` → CLIP zero-shot ("a screenshot", "a document", "a receipt") threshold. If absent, keep Editroom's
  fallback (`aesthetic` nil → constant 0.12).
- Shows: re-implement `MagicThinking`, `MagicShow`, `AgentPresence` as a React overlay (absolutely positioned layer over the window, using
  DOM rects registered by components, the analogue of `MagicAnchor`), driven by the Rust `MagicPlan` DAG; commit to core as one undo step at the end.

### 4.6 Parity risks

| Risk | Impact | Mitigation |
|---|---|---|
| Claude Desktop `.mcpb` install flow and folders on Windows unknown | Claude one-click connect may fail | config-file fallback; test on real Windows Claude |
| Codex/ChatGPT app on Windows: CLI location, `models_cache.json`, native support | ChatGPT Magic may be unavailable | PATH/npm lookup; WSL not supported (loopback differs) — document |
| Local LLM quality/size vs Apple's on-device model | Local prompts misread | schema-constrained output + `checked()` + keyword fallback; optional download |
| Tool texts say "on this Mac", font error lists Mac fonts | Misleading on Windows | make strings platform-aware (keep identical on macOS) |
| `get_frame` needs the GPU compositor in the WebView | Tool fails if window closed/minimised | offscreen render path or headless WebGL; Editroom also needs the app open |
| whisper vs Apple Speech timing/word boundaries | captions, pauses, LocalSpeech cut points differ | tune `join`/`keep*` constants against test clips |
| CLIP tags vs Vision taxonomy | `shows`, search_media, Local "showing" differ | map CLIP labels to Vision-like vocabulary; keep stop-word/common-tag filtering |
| Swarm animation timing in React | look-and-feel only | port constants (performTime, tempo, agentSpeed 4) |
| Closures in `MagicEdit.change` | plans can't cross IPC | typed ops / clip snapshots |
| Port 47920 shared with a running Editroom on the same Mac | PromptEdit falls back to ephemeral port; external agents reach Editroom instead | consider a different default port for PromptEdit, or detect and warn; **decision needed** |
| Bridge empty-line quirk, `add_title` extra undo step | minor | fix deliberately and list in PARITY.md |
| Model ids (`claude-opus-5-5`, `gpt-6.2-sol`, …) are hard-coded | go stale | keep list in config, refresh from CLI where possible |
