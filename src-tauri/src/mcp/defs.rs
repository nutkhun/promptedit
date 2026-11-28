//! The tool definitions agents get from `tools/list` (docs/spec/03-mcp-magic.md §1.8): Editroom's 43
//! tools with the same names, titles, input schemas and wording, saying PromptEdit (and "on this PC"
//! on Windows). Compiled into the binary so the stdio bridge answers `tools/list` without the app.

use super::on_this;
use serde_json::{Map, Value, json};

fn tool(name: &str, title: &str, description: &str, props: Value, required: &[&str], read_only: bool) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": {"type": "object", "properties": props, "required": required},
        "annotations": {"readOnlyHint": read_only, "destructiveHint": false, "openWorldHint": false},
    })
}

fn num(d: &str) -> Value {
    json!({"type": "number", "description": d})
}
fn st(d: &str) -> Value {
    json!({"type": "string", "description": d})
}
fn boolean(d: &str) -> Value {
    json!({"type": "boolean", "description": d})
}
fn none() -> Value {
    Value::Object(Map::new())
}

/// Font families named in the set_title_style error, for this OS.
pub fn suggested_fonts() -> &'static str {
    if cfg!(windows) {
        "System, Segoe UI, Arial, Georgia, Impact or Bahnschrift"
    } else {
        "System, Helvetica Neue, Futura, Avenir Next, Georgia or Didot"
    }
}

/// Every tool, in Editroom's order.
pub fn definitions() -> Vec<Value> {
    let here = on_this();
    let ro = true;
    let rw = false;
    vec![
        tool("get_project", "Get project", "The sequence (size, frame rate, length), tracks, and every clip with its id, track, times, source, grade, sound and transition.", none(), &[], ro),
        tool("list_media", "List media", "Everything in the library: id, name, kind (video, audio, image), the folder it's in, length, size, frame rate, what it shows, whether people talk in it, and notes saved from looking at it before.", none(), &[], ro),
        tool("import_media", "Import media", "Adds files to the library. A folder brings in everything in it (and in folders inside it) and stays linked: files added to it later come in too, and list_media gives each item's folder.",
             json!({"paths": {"type": "array", "items": {"type": "string"}, "description": "Absolute paths of files or folders."}}), &["paths"], rw),
        tool("download_media", "Download media", "Downloads one music or sound file you found online and adds it to the library, ready for add_clip. Give the direct link to the audio file (an .mp3, .m4a or .wav), not a web page. Only for music that's free to use; say where you found it and what its licence allows, which is noted beside the file.",
             json!({"url": st("https link to the audio file itself."), "name": st("What to call it, like the track and artist."),
                    "source_page": st("The page you found it on."), "licence": st("What the licence says, for example \"Pixabay Content License: free to use, no attribution required\".")}),
             &["url", "source_page", "licence"], rw),
        tool("analyze_media", "Analyze media", &format!("For a video or photo: its best moments, scored for focus, exposure, colour, faces and steadiness. For music: tempo, beats and where bars start. Done {here}; cached."),
             json!({"asset_id": st("A library item's id."), "moment_length": num("Length of moments to look for, in seconds (default 2).")}), &["asset_id"], ro),
        tool("get_transcript", "Get transcript", &format!("What's said in a video or sound file, heard {here}: its sentences and pauses with their times in the file (and each word's time if you ask). Use it for anything with people talking: to cut pauses, retakes and filler, keep sentences whole, find a moment by what's said, or put pictures over the talking. Made in the background after import; cached."),
             json!({"asset_id": st("A library item's id."), "words": boolean("Also every word with its start and end (default false).")}), &["asset_id"], ro),
        tool("look_at_media", "Look at media", "Shows you a library item: a photo, or frames from across a video in a grid, each marked with its time in the file. Use it to see what's in each shot before choosing.",
             json!({"asset_id": st("A library item's id."), "frames": {"type": "integer", "description": "How many frames from across a video (default 6, at most 12)."},
                    "times": {"type": "array", "items": {"type": "number"}, "description": "Or exactly which times in the file to show, in seconds (at most 12)."}}),
             &["asset_id"], ro),
        tool("note_media", "Note what's in media", &format!("Saves what you saw in a library item after looking at it, for later edits: what happens and where (times in the file), the people, the place, the light, how steady, and its best and weakest moments. Two or three short lines. list_media hands it back as \"notes\", so it needn't be looked at again. Replaces any note it had; kept {here}, never in the project."),
             json!({"asset_id": st("A library item's id."), "notes": st("What's in it, with times, like \"0-3s girl in a high chair eating noodles; 3-8s close-up, laughing at the camera, best moment 5s; bright kitchen, handheld but steady.\"")}),
             &["asset_id", "notes"], rw),
        tool("get_frame", "Get frame", "A picture of the cut at a time (default: the playhead), 640 pixels on its longer side.", json!({"time": num("Seconds.")}), &[], ro),
        tool("add_clip", "Add clip", "Drags a library item onto the timeline. A video with sound brings its audio, linked.",
             json!({"asset_id": st("A library item's id."), "start": num("Where on the timeline (default: the end of the track)."),
                    "track": st("V1, V2… for video and photos; A1, A2… for audio (default V1 or A1)."),
                    "source_start": num("Where in the file to start (default 0)."), "duration": num("How long (default: the rest of the file; 5 for a photo).")}),
             &["asset_id"], rw),
        tool("add_title", "Add title", "Adds a text title, typed in.",
             json!({"text": st("The words."), "start": num("Default 0."), "duration": num("Default 3."), "track": st("A video track (default: one that's free there, above V1).")}), &["text"], rw),
        tool("move_clip", "Move clip", "Moves a clip (and anything linked to it) in time, and optionally to another track of the same kind.",
             json!({"clip_id": st("A clip's id."), "start": num("New start."), "track": st("Optional new track.")}), &["clip_id", "start"], rw),
        tool("trim_clip", "Trim clip", "Moves a clip's start and/or end edge on the timeline (and its linked clip's). The source moves with the start edge.",
             json!({"clip_id": st("A clip's id."), "start": num("New start edge."), "end": num("New end edge.")}), &["clip_id"], rw),
        tool("set_speed", "Set speed", "Speeds a clip (and its linked sound) up or slows it down, keeping the same part of the file: 4 plays four times as fast and a quarter as long (a timelapse), 0.5 is slow motion. Clips after it on the track move to stay butted up.",
             json!({"clip_id": st("A clip's id."), "speed": num("0.05...100; 1 is normal.")}), &["clip_id", "speed"], rw),
        tool("set_speed_ramp", "Set speed ramp", "A speed ramp on a clip (and its linked sound): it plays at `around` speed, eases into `speed` for the part of the file from `from` to `to`, then eases back. For a slow-motion moment (speed 0.25, around 1), fast-normal-fast B-roll (speed 1, around 4), or ramping into a cut (`to` left out, `speed` 4: it eases up toward the clip's end). Times are seconds in the file, like source_start. The clip's length changes; clips after it on the track move to stay butted up. remove: true takes a clip's ramp away.",
             json!({"clip_id": st("A clip's id."), "speed": num("The speed from `from` to `to`, 0.05...100 (1 is normal)."),
                    "from": num("Seconds in the file where it reaches `speed` (default: the clip's start, so no ease in)."),
                    "to": num("Seconds in the file where it starts easing back (default: the clip's end, so no ease out)."),
                    "ease": num("Seconds of the file each ease takes (default 0.4)."),
                    "around": num("The speed before and after (default 1)."),
                    "remove": boolean("Take the clip's ramp away (its speed stays).")}),
             &["clip_id"], rw),
        tool("set_captions", "Set captions", "Captions from what's said: a caption track above the video shows the words of each captioned clip in short phrases, timed to the speech, and follows every trim and move of those clips. Give clip_ids to caption those clips' speech (a video's sound is its linked audio clip); with none, every clip of people talking is captioned (sound from video files and voiceover tracks, not music). Also sets the captions' style, and with edit fixes captions: a misheard word, a name spelled right, or a caption taken out. remove: true takes captions off clip_ids, or removes the caption track with none. Returns the captions.",
             json!({"clip_ids": {"type": "array", "items": {"type": "string"}, "description": "Clips whose speech to caption (or un-caption with remove)."},
                    "remove": boolean("Take captions off instead."),
                    "size": num("Text size, 28...140 (default 64)."),
                    "position": num("Where they sit, 0.1 (top) to 0.95 (bottom) of the frame (default 0.78)."),
                    "highlight": boolean("Light up each word as it's said (default true)."),
                    "hidden": boolean("Hide or show the caption track (hidden captions aren't exported)."),
                    "edit": {"type": "array", "description": "Captions to change, each found by a timeline time inside it (as set_captions or get_project return them): the words it should say, or \"\" to take it out. The caption keeps its time.",
                             "items": {"type": "object", "properties": {"at": {"type": "number", "description": "Timeline seconds inside the caption."},
                                                                         "text": {"type": "string", "description": "What it should say."}},
                                       "required": ["at", "text"]}}}),
             &[], rw),
        tool("split_clip", "Split clip", "Cuts a clip (and its linked clip) in two with the blade. Returns the new right-hand pieces.",
             json!({"clip_id": st("A clip's id."), "at": num("Timeline time inside the clip.")}), &["clip_id", "at"], rw),
        tool("delete_clips", "Delete clips", "Deletes clips and anything linked to them.",
             json!({"clip_ids": {"type": "array", "items": {"type": "string"}}, "ripple": boolean("Close the gap left behind (default false).")}), &["clip_ids"], rw),
        tool("set_grade", "Set grade", "Colour for video, photo and title clips. Leave out what shouldn't change.",
             json!({"clip_ids": {"type": "array", "items": {"type": "string"}}, "look": st("A look from list_looks, a .cube file path, or \"none\"."),
                    "look_intensity": num("0...1."), "exposure": num("Stops, -2...2."), "contrast": num("-50...50."), "saturation": num("-100...100."),
                    "temperature": num("-50...50, negative is cooler."), "tint": num("-50...50, positive is toward magenta.")}),
             &["clip_ids"], rw),
        tool("list_looks", "List looks", "The built-in looks for set_grade.", none(), &[], ro),
        tool("set_audio", "Set level and fades", "A clip's sound level, and its fades: a sound clip's fade its sound, a video, photo, title or solid's fade its picture (in from black, out to black).",
             json!({"clip_id": st("A clip's id."), "gain_db": num("Sound level in dB, -60...12."), "fade_in": num("Seconds."), "fade_out": num("Seconds.")}), &["clip_id"], rw),
        tool("set_transition", "Set transition", "A transition into a clip from the clip that ends where it starts on the same track.",
             json!({"clip_id": st("The later clip's id."), "kind": {"type": "string", "enum": ["dissolve", "dipToBlack", "wipe", "none"]}, "duration": num("Seconds (default 0.5).")}),
             &["clip_id", "kind"], rw),
        tool("add_track", "Add track", "Adds an empty track on top of the others of its kind.", json!({"kind": {"type": "string", "enum": ["video", "audio"]}}), &["kind"], rw),
        tool("set_sequence", "Set sequence", "The frame size and frame rate of the cut.",
             json!({"width": {"type": "integer"}, "height": {"type": "integer"}, "fps": num("23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88 or 120.")}), &[], rw),
        tool("playback", "Playback", "Play, pause or move the playhead.",
             json!({"action": {"type": "string", "enum": ["play", "pause", "seek"]}, "time": num("For seek.")}), &["action"], rw),
        tool("history", "Undo or redo", "Undoes or redoes the last change (each tool call is one change).", json!({"action": {"type": "string", "enum": ["undo", "redo"]}}), &["action"], rw),
        tool("auto_edit", "Auto edit", "Builds a whole cut from the library on its own: best moments, cut to the beat of a song if there is one, titled. Replaces what's on the timeline (one undo brings it back).", none(), &[], rw),
        tool("save_project", "Save project", "Saves the project to its file. A project that's never been saved has to be saved by the person.", none(), &[], rw),
        // Delivering, finding, marking, framing, and the rest.
        tool("export", "Export", "Exports the cut to a file, in the background (export_status says how it's going, or set wait). Saved in the folder the person last exported to (else beside the project, else Movies); never over an existing file. Not available while making a Magic edit.",
             json!({"name": st("File name, without extension (default: the project's)."),
                    "format": {"type": "string", "enum": ["video", "audio", "prores", "mp3"], "description": "video: an MP4 (default); audio: a WAV of the sound; prores: a ProRes MOV (for further editing or delivery masters; large); mp3: an MP3 of the sound (quality high is 320 kb/s, web 192)."},
                    "prores_profile": {"type": "string", "enum": ["proxy", "lt", "standard", "hq"], "description": "For prores: ProRes 422 Proxy, LT, 422 (standard, the default) or HQ."},
                    "shape": {"type": "string", "enum": ["original", "vertical", "square", "portrait"], "description": "original is the sequence's own shape; vertical 9:16, square 1:1 and portrait 4:5 crop it."},
                    "height": {"type": "integer", "description": "Output height in pixels (for vertical, square and portrait: the short side), e.g. 720, 1080, 2160. Default: the sequence's."},
                    "codec": {"type": "string", "enum": ["h264", "hevc"]}, "quality": {"type": "string", "enum": ["high", "web"]},
                    "include_audio": boolean("Default true."),
                    "loudness": num("Target loudness in LUFS: -14 for YouTube and social, -16 for podcasts, -23 for broadcast. Leave out to keep the levels."),
                    "range_only": boolean("Just the in/out range (see set_in_out)."),
                    "reframe_x": num("For a crop: which part to keep, 0 (left) to 1 (right). Default 0.5."),
                    "reframe_y": num("For a crop: 0 (top) to 1 (bottom). Default 0.5."),
                    "wait": boolean("Wait until it's done (up to about 4 minutes) instead of returning straight away.")}),
             &[], rw),
        tool("export_status", "Export status", "Exports started from PromptEdit (by anyone): their files and whether they're waiting, running, done or failed.", none(), &[], ro),
        tool("search_media", "Search media", &format!("Finds library items by what they show (people, places, things: \"beach\", \"dog\", \"car at night\") and/or what's said in them, with the times in each file. Much quicker than looking at or transcribing each one. Seen and heard {here} in the background after import, so a new file may not be searchable yet."),
             json!({"shows": st("Words for what's in the shot; every word has to match."), "said": st("Words someone says, in order.")}), &[], ro),
        tool("set_marker", "Set marker", "Adds a marker on the timeline, or changes one (give marker_id, from get_project). Use markers when asked to mark moments (beats, highlights, places to cut).",
             json!({"marker_id": st("To change an existing marker."), "time": num("Timeline seconds (needed for a new marker)."), "name": st("What to call it."),
                    "color": {"type": "string", "enum": ["white", "yellow", "green", "blue", "purple", "red"]}}),
             &[], rw),
        tool("delete_markers", "Delete markers", "Removes markers.",
             json!({"marker_ids": {"type": "array", "items": {"type": "string"}}, "all": boolean("Remove every marker.")}), &[], rw),
        tool("set_in_out", "Set in and out", "The in/out range: what Loop plays and what export can be limited to (range_only).",
             json!({"in": num("Timeline seconds."), "out": num("Timeline seconds."), "clear": boolean("Remove the range.")}), &[], rw),
        tool("set_transform", "Position, scale and zoom", "Moves and scales a video, photo or solid in the frame, for reframing (keeping a subject in a vertical crop, a picture-in-picture). With zoom, it animates over the clip between the full frame and this scale and framing: pushing in on a moment, or following the action in a screen recording. A title's place is set with set_title_style.",
             json!({"clip_id": st("A clip's id."), "scale": num("1 fits the frame; 2 is twice as big (0.05...10). With zoom, how far in it goes (default 2)."),
                    "x": num("Offset of its centre across, as a fraction of the frame's width (0 is centred, 0.5 is the right edge)."),
                    "y": num("Offset down, as a fraction of the frame's height (0 is centred, positive is lower)."),
                    "focus_x": num("Instead of x: the point to frame, across the picture (0 left edge, 0.5 centre, 1 right edge). Scaled up, the picture is placed so that point is centred, as near as its edges allow."),
                    "focus_y": num("Instead of y: the point to frame, down the picture (0 top, 0.5 centre, 1 bottom)."),
                    "zoom": {"type": "string", "enum": ["in", "in_out", "out", "off"], "description": "Animate: in (full frame to this framing), in_out (in, hold, back out at the end), out (from this framing back to the full frame), or off (stay at this framing)."},
                    "zoom_seconds": num("How long each move takes (default a quarter of the clip, 0.5 to 2 seconds)."),
                    "zoom_start": num("Seconds into the clip when the move starts: for in and in_out, when it starts moving in (default 0); for out, when it starts moving out (default so it ends with the clip)."),
                    "zoom_smooth": boolean("Eased in and out (the default), or false for an even pace."),
                    "reset": boolean("Back to fitted and centred, with no zoom.")}),
             &["clip_id"], rw),
        tool("set_title_style", "Title style", "A title's words and look. Leave out what shouldn't change.",
             json!({"clip_id": st("A title clip's id."), "text": st("The words."),
                    "font": st(&format!("A font family installed {here}, or \"System\".")),
                    "size": num("Points, for a 1080-pixel-tall frame (12...600; default 110)."), "bold": {"type": "boolean"},
                    "color": st("Hex, like #FFFFFF."), "x": num("Its centre across, 0 (left) to 1 (right)."), "y": num("Its centre down, 0 (top) to 1 (bottom).")}),
             &["clip_id"], rw),
        tool("freeze_frame", "Freeze frame", "Holds one frame of a video clip: the clip is cut there, the held frame goes in, and what follows on its tracks moves along to make room.",
             json!({"clip_id": st("A video clip's id."), "at": num("Timeline time inside the clip (default: its middle)."), "seconds": num("How long to hold (default 2).")}), &["clip_id"], rw),
        tool("reverse_clip", "Reverse", "Plays a clip (and its linked sound) backwards; again plays it forwards.", json!({"clip_id": st("A clip's id.")}), &["clip_id"], rw),
        tool("detach_audio", "Detach audio", "Unlinks a video from its sound, so each can be moved, trimmed or deleted on its own.", json!({"clip_id": st("The video's or its sound's id.")}), &["clip_id"], rw),
        tool("duplicate_clip", "Duplicate clip", "Copies a clip (and anything linked to it) to another time.",
             json!({"clip_id": st("A clip's id."), "start": num("Where the copy starts (default: straight after the clip).")}), &["clip_id"], rw),
        tool("set_track", "Set track", "A track's switches and level.",
             json!({"track": st("V1, V2… or A1, A2…"), "hidden": boolean("Video tracks."), "muted": boolean("Audio tracks."),
                    "solo": boolean("Audio tracks."), "locked": {"type": "boolean"}, "gain_db": num("Audio tracks, -60...12.")}),
             &["track"], rw),
        tool("add_solid", "Add solid", "Adds a solid colour (a background, a flash, a colour card).",
             json!({"color": st("Hex, like #000000 (default black)."), "start": num("Default 0."), "duration": num("Default 3."), "track": st("A video track (default: one that's free there).")}), &[], rw),
        tool("set_solid_color", "Solid colour", "Changes a solid's colour.", json!({"clip_id": st("A solid's id."), "color": st("Hex, like #1A1A1A.")}), &["clip_id", "color"], rw),
    ]
}

/// Tool names, in order.
pub fn names() -> Vec<String> {
    definitions().iter().filter_map(|d| d["name"].as_str().map(String::from)).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn has_all_43_tools() {
        let n = super::names();
        assert_eq!(n.len(), 43);
        assert_eq!(n.first().map(String::as_str), Some("get_project"));
        assert_eq!(n.last().map(String::as_str), Some("set_solid_color"));
    }
}
