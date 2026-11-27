//! The brief a Magic AI run gets on stdin (Editroom's `MagicAgent.brief` and `pointing`), verbatim
//! but for the app's name.

use super::mentions::{self, Mention, Pointers};
use promptedit_core::{Clip, ClipKind, Project};

fn here() -> &'static str {
    crate::mcp::on_this()
}

pub fn brief(request: &str, p: &Project, pointers: Option<&Pointers>) -> String {
    let ask = request.trim();
    let on_timeline: Vec<&Clip> = p.clips.iter().filter(|c| c.kind != ClipKind::Audio).collect();
    let has_edit = !on_timeline.is_empty();
    let mut lines: Vec<String> = vec![];
    lines.push(format!(
        "You're the editor in PromptEdit, the video editor open {}. Use only the promptedit tools, and don't stop to ask anything: nobody can answer until you've finished. If what they wrote isn't about the video (a question, a chat), just answer it in a sentence or two: don't look at the media or change anything.",
        here()
    ));
    if ask.is_empty() {
        lines.push(if has_edit {
            "They didn't ask for anything in particular: make the edit on the timeline better, the way a skilled editor would.".into()
        } else {
            "They didn't ask for anything in particular: make the best short video you can from the library, the way a skilled editor would cut it to share.".into()
        });
    } else {
        lines.push(format!("What they asked for: \"{ask}\""));
    }
    if let Some(ptr) = pointers
        && let Some(said) = pointing(ptr, ask, p)
    {
        lines.push(said);
    }
    if has_edit {
        lines.push(format!(
            "The timeline already has an edit ({} clips, about {:.0} seconds). Work on that edit: change it to do what they asked, and keep what already works. Don't delete it and start again unless they asked for something new.",
            on_timeline.len(),
            p.duration()
        ));
    } else {
        lines.push("The timeline is empty: build the video from the library.".into());
    }
    lines.push(format!(
        "Use what's in the library (list_media) and PromptEdit's own titles, transitions, colour and sound levels. The one thing you can add is music or sound you find online, with download_media (see below). If what they asked for needs something else the library doesn't have (a logo, more footage), do the best you can without it, and say what was missing at the end.

Finding music or sound: only when they ask for it, or the edit clearly needs music and the library has none. Search the web for tracks that are royalty-free and need no attribution (for example CC0, or a site licence that says no credit is required), and read the licence to make sure. Choose one that suits the footage's mood and pace. Then download_media the direct link to the audio file (not the web page), with the page you found it on and what the licence says, and use it like any other music. Never take music from a place that doesn't clearly allow it. At the end, name the track, where it's from and its licence.

Your edits go into a draft that the person sees all at once, played onto their timeline, when you finish. So take the time to get it right; if a step goes wrong, history undoes it.

How to work:
1. get_project and list_media.
2. list_media says what each clip \"shows\" (seen {here}): a quick guide to find shots by what's in them, and search_media finds shots by what they show or what's said in them, with times. Look at the footage with look_at_media to see what's in each shot, then save what you saw with note_media. A clip whose list_media \"notes\" already say what's in it needn't be looked at again unless you need an exact frame. If people talk in it (list_media says \"speech\"), get_transcript gives what's said with times: cut pauses, retakes and filler between sentences, keep sentences whole, and put other shots over the talking where it helps. For captions or subtitles, use set_captions, never add_title: it captions what's said, timed to the speech, and keeps up with every later edit; its edit option fixes a misheard word or takes a caption out. analyze_media finds a clip's best moments, or a song's tempo and bar starts.
3. Choose. Leave out shots that are blurry, dark, shaky, accidental, near-duplicates of a better one, or screenshots. Find an order that tells something: an opening that sets the scene, a build, the best moments, and a shot that feels like an ending. Prefer moments where something happens, faces and expressions, and variety of framing.
4. Cut. Shots on V1 back to back with no gaps, using source_start and duration (or trim_clip) to keep just the best part of each. With music: the song on A1 from 0, cut on bar starts or beats, shorter shots where the music is busy and longer where it's calm, end on a bar start, and turn the clips' own sound down to about -20 dB unless someone is talking and it matters. Without music: keep the clips' sound and cut where the action or sound makes a natural break. If most of the footage is vertical and the timeline is empty, set_sequence to 1080 by 1920 first.
5. To make an edit shorter or keep people watching: open on the strongest moment, cut the slow starts and ends of shots, drop weak or repeated shots, and close every gap (delete_clips with ripple, or move clips).
6. Speed: set_speed speeds a clip up (4 to 20 times for a timelapse) or slows it down. Turn a sped-up clip's own sound right down (set_audio gain_db -60) unless they asked to keep it. set_speed_ramp eases the speed within a clip: a slow-motion moment on the best part of an action (look at the frames to find it), fast-normal-fast on travel shots, or ramping up into a cut and down out of it on the next shot. Use ramps when asked, or sparingly where they make the moment. set_transform's zoom pushes in on a moment or follows the action in a screen recording (focus_x and focus_y say where to look): use it when asked, or sparingly. For a long video like a vlog, keep what people say whole, and use short titles to mark each part.
7. Finish. Colour only when they asked for it, or when the footage clearly needs it (look at the frames): shots from different cameras or light that don't match, or shots too dark or washed out. Then one look from list_looks, or small set_grade fixes, on every shot so it feels like one film. Otherwise leave colour as it is, and on an existing edit don't change colour unless they asked. set_transform reframes a shot (to keep a subject in a vertical frame); set_title_style sets a title's font, size, colour and place. Markers (set_marker), the in/out range, freeze frames, reversing, detaching sound, track switches and solids only when they ask for them. Titles and text only when they asked for them, or the kind of video needs them (a vlog's parts); most videos don't. Fade music out over the last 2 seconds. A dissolve or dip to black only where it helps, never on every cut.
8. Check a few moments with get_frame and fix what's wrong.

When you're done, write one or two short sentences for the person: what you made or changed, and anything you couldn't do and why. Plain words, no lists, no ids.",
        here = here()
    ));
    lines.join("\n\n")
}

/// Where they were pointing when they asked, and what each @ in the request means. Only when the
/// timeline has clips or the request has mentions.
pub fn pointing(ptr: &Pointers, request: &str, p: &Project) -> Option<String> {
    let labels = mentions::clip_labels(p);
    let marks = mentions::marker_labels(p);
    let found = mentions::find(request, &p.assets, &labels, &marks);
    if p.clips.is_empty() && found.is_empty() {
        return None;
    }
    let t = |s: f64| format!("{s:.2}s");
    let clip = |c: &Clip| format!("\"{}\" on {} {}-{} (id {})", p.name_of(c), crate::mcp::json::track_name(c.track_id, p), t(c.start), t(c.end()), c.id);
    let by_track = |a: &&Clip, b: &&Clip| mentions::track_order(p, a.track_id).cmp(&mentions::track_order(p, b.track_id));
    let mut where_ = vec![];
    if !p.clips.is_empty() {
        let mut under: Vec<&Clip> =
            p.clips.iter().filter(|c| c.start <= ptr.playhead + 1e-6 && ptr.playhead < c.end() - 1e-6 && c.kind != ClipKind::Audio).collect();
        under.sort_by(by_track);
        let over = if under.is_empty() { String::new() } else { ", over ".to_string() + &under.iter().map(|c| clip(c)).collect::<Vec<_>>().join("; ") };
        where_.push(format!("- Playhead: {}{over}", t(ptr.playhead)));
        let sel: Vec<&Clip> = ptr.selected.iter().filter_map(|id| p.clip(*id)).collect();
        where_.push(format!(
            "- Selected: {}",
            if sel.is_empty() {
                "nothing".to_string()
            } else {
                format!("{} clip{}: {}", sel.len(), if sel.len() == 1 { "" } else { "s" }, sel.iter().map(|c| clip(c)).collect::<Vec<_>>().join("; "))
            }
        ));
        where_.push(format!("- In/out range: {}", ptr.range.map(|(a, b)| format!("{} to {}", t(a), t(b))).unwrap_or_else(|| "none".into())));
    }
    let mut meant: Vec<String> = vec![];
    let mut seen = std::collections::HashSet::new();
    for (_, m) in &found {
        if !seen.insert(*m) {
            continue;
        }
        match m {
            Mention::Playhead => meant.push("@playhead means the playhead above.".into()),
            Mention::Selected => meant.push(if ptr.selected.is_empty() {
                "@selected: nothing was selected, so do the best you can from the rest of what they said.".into()
            } else {
                "@selected means exactly the selected clips above, no others.".into()
            }),
            Mention::Range => meant.push(if ptr.range.is_none() {
                "@in-out: no in/out range was set, so do the best you can from the rest of what they said.".into()
            } else {
                "@in-out means the in/out range above.".into()
            }),
            Mention::Media(id) => {
                if let Some(a) = p.asset(Some(*id)) {
                    meant.push(format!("@{} means the library file {} (asset_id {}).", a.name, a.name, a.id));
                }
            }
            Mention::Clip(id) => {
                if let (Some(c), Some(l)) = (p.clip(*id), labels.iter().find(|l| l.id == *id)) {
                    meant.push(format!("@clip:{} means exactly one clip on the timeline: {}.", l.name, clip(c)));
                }
            }
            Mention::Marker(id) => {
                if let Some(l) = marks.iter().find(|l| l.id == *id) {
                    meant.push(format!("@{n} (or @marker:{n}) means the marker \"{n}\" at {} on the timeline.", t(l.time), n = l.name));
                }
            }
        }
    }
    let mut out = String::new();
    if !where_.is_empty() {
        out = format!("Where they were in the editor when they asked:\n{}\n", where_.join("\n"));
    }
    if !meant.is_empty() {
        meant.sort();
        out += &format!("They pointed with @: {} Act on exactly what they pointed at.\n", meant.join(" "));
    }
    // Times they typed, in timeline seconds, with what's there.
    let mut timed = vec![];
    let request = mentions::markers_as_times(request, p);
    let span = mentions::span(&request, p.fps);
    if let Some((a, b, text)) = &span {
        let mut over: Vec<&Clip> = p.clips.iter().filter(|c| c.kind != ClipKind::Audio && c.start < b - 1e-6 && c.end() > a + 1e-6).collect();
        over.sort_by(|x, y| (x.start, mentions::track_order(p, x.track_id)).partial_cmp(&(y.start, mentions::track_order(p, y.track_id))).unwrap());
        let o = if over.is_empty() { String::new() } else { ", over ".to_string() + &over.iter().map(|c| clip(c)).collect::<Vec<_>>().join("; ") };
        timed.push(format!("\"{text}\" is {} to {} on the timeline{o}.", t(*a), t(*b)));
    }
    for typed in mentions::times(&request, p.fps).into_iter().filter(|x| !x.unit_only) {
        if span.as_ref().is_some_and(|s| s.2.contains(&typed.text)) {
            continue;
        }
        let mut under: Vec<&Clip> =
            p.clips.iter().filter(|c| c.kind != ClipKind::Audio && c.start <= typed.seconds + 1e-6 && typed.seconds < c.end() - 1e-6).collect();
        under.sort_by(by_track);
        let o = if under.is_empty() { String::new() } else { ", over ".to_string() + &under.iter().map(|c| clip(c)).collect::<Vec<_>>().join("; ") };
        timed.push(format!("\"{}\" is {} (if it's a place on the timeline{o}; it may be a length instead).", typed.text, t(typed.seconds)));
    }
    if !timed.is_empty() {
        out += &format!("Times in their request: {}\n", timed.join(" "));
    }
    if !where_.is_empty() {
        out += "Use the playhead, selection and range only when their words point at them (\"here\", \"this clip\", \"these\", \"this spot\", \"from here on\", or an @). Otherwise the request is about the whole edit, whatever happens to be selected.";
    }
    Some(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_names_promptedit() {
        let b = brief("", &Project::default(), None);
        assert!(b.starts_with("You're the editor in PromptEdit"));
        assert!(b.contains("The timeline is empty: build the video from the library."));
        assert!(!b.contains("Editroom"));
        let b = brief("make it pop", &Project::default(), Some(&Pointers::default()));
        assert!(b.contains("What they asked for: \"make it pop\""));
    }
}
