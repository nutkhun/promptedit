//! The JSON agents get back (docs/spec/03-mcp-magic.md §1.7): clips, the project and library
//! items, in Editroom's shapes and key names. Tool results are pretty-printed with sorted keys, as
//! one `text` item.

use promptedit_core::{Clip, ClipKind, MediaAsset, MediaKind, Project, Rgba, TrackKind, ZoomMode};
use promptedit_core::Id;
use serde::Serialize;
use serde_json::{Map, Value, json};

/// A number as Swift's JSONSerialization writes it: whole numbers without a fraction.
pub fn num(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e15 {
        Value::from(v as i64)
    } else if v.is_finite() {
        Value::from(v)
    } else {
        Value::Null
    }
}

/// Three decimal places, written as such ("5.417", not "5.4169999999999998").
pub fn round3(v: f64) -> Value {
    num((v * 1000.0).round() / 1000.0)
}

/// Pretty JSON with sorted keys, spaced like Apple's (`"key" : value`), as Editroom's tools write it.
pub fn pretty(v: &Value) -> String {
    struct Swiftish<'a> {
        inner: serde_json::ser::PrettyFormatter<'a>,
    }
    impl serde_json::ser::Formatter for Swiftish<'_> {
        fn begin_array<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            self.inner.begin_array(w)
        }
        fn end_array<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            self.inner.end_array(w)
        }
        fn begin_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
            self.inner.begin_array_value(w, first)
        }
        fn end_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            self.inner.end_array_value(w)
        }
        fn begin_object<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            self.inner.begin_object(w)
        }
        fn end_object<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            self.inner.end_object(w)
        }
        fn begin_object_key<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
            self.inner.begin_object_key(w, first)
        }
        fn begin_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            w.write_all(b" : ")
        }
        fn end_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            self.inner.end_object_value(w)
        }
    }
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, Swiftish { inner: serde_json::ser::PrettyFormatter::new() });
    // serde_json's map is a BTreeMap, so keys come out sorted.
    let _ = v.serialize(&mut ser);
    String::from_utf8(out).unwrap_or_default()
}

pub fn hex(c: Rgba) -> String {
    let b = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02X}{:02X}{:02X}", b(c.r), b(c.g), b(c.b))
}

pub fn id(i: Id) -> Value {
    Value::from(i.to_string())
}

pub fn track_name(id: Id, p: &Project) -> String {
    if let Some(i) = p.track_index(id, TrackKind::Video) {
        return format!("V{}", i + 1);
    }
    if let Some(i) = p.track_index(id, TrackKind::Audio) {
        return format!("A{}", i + 1);
    }
    "?".into()
}

fn kind_name(k: ClipKind) -> &'static str {
    match k {
        ClipKind::Video => "video",
        ClipKind::Audio => "audio",
        ClipKind::Image => "image",
        ClipKind::Solid => "solid",
        ClipKind::Text => "text",
    }
}

pub fn media_kind_name(k: MediaKind) -> &'static str {
    match k {
        MediaKind::Video => "video",
        MediaKind::Audio => "audio",
        MediaKind::Image => "image",
    }
}

/// A built-in look's name, or a .cube file's name without its folder and extension.
pub fn look_label(look: &str) -> String {
    if crate::mcp::tools::LOOKS.contains(&look) || look == "Faded" {
        return look.to_string();
    }
    std::path::Path::new(look).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| look.to_string())
}

pub fn clip(c: &Clip, p: &Project) -> Value {
    let mut d = Map::new();
    d.insert("id".into(), id(c.id));
    d.insert("name".into(), p.name_of(c).into());
    d.insert("kind".into(), kind_name(c.kind).into());
    d.insert("track".into(), track_name(c.track_id, p).into());
    d.insert("start".into(), round3(c.start));
    d.insert("end".into(), round3(c.end()));
    d.insert("duration".into(), round3(c.duration));
    if c.kind.uses_source() {
        d.insert("source_start".into(), round3(c.source_start));
        d.insert("asset_id".into(), c.asset_id.map(|a| a.to_string()).unwrap_or_default().into());
    }
    if c.speed != 1.0 {
        d.insert("speed".into(), num(c.speed));
    }
    if c.is_ramped()
        && let Some(r) = c.ramp
    {
        // In seconds of the file (as set_speed_ramp takes them): `speed` from `from` to `to`,
        // easing from `start_speed` before and to `end_speed` after.
        d.insert(
            "speed_ramp".into(),
            json!({"from": num(r.in_to), "to": num(r.out_from), "ease_in": num(r.in_to - r.in_from),
                   "ease_out": num(r.out_to - r.out_from), "start_speed": num(r.start_speed), "end_speed": num(r.end_speed)}),
        );
    }
    if c.is_reversed() {
        d.insert("reversed".into(), true.into());
    }
    if c.is_freeze() {
        d.insert("freeze_frame".into(), true.into());
    }
    if let Some(link) = c.link_id
        && let Some(other) = p.clips.iter().find(|o| o.link_id == Some(link) && o.id != c.id)
    {
        d.insert("linked_to".into(), id(other.id));
    }
    if c.kind == ClipKind::Audio || c.gain_db != 0.0 {
        d.insert("gain_db".into(), round3(c.gain_db));
    }
    if c.fade_in > 0.0 {
        d.insert("fade_in".into(), round3(c.fade_in));
    }
    if c.fade_out > 0.0 {
        d.insert("fade_out".into(), round3(c.fade_out));
    }
    if let Some(t) = c.transition_in {
        let kind = match t.kind {
            promptedit_core::TransitionKind::Dissolve => "dissolve",
            promptedit_core::TransitionKind::DipToBlack => "dipToBlack",
            promptedit_core::TransitionKind::Wipe => "wipe",
        };
        d.insert("transition_in".into(), json!({"kind": kind, "duration": num(t.duration)}));
    }
    if c.kind == ClipKind::Text {
        d.insert("text".into(), c.text.string.clone().into());
        let font = if c.text.font_name.is_empty() { "System".to_string() } else { c.text.font_name.clone() };
        d.insert(
            "style".into(),
            json!({"font": font, "size": round3(c.text.size), "bold": c.text.bold, "color": hex(c.text.color),
                   "x": round3(c.text.x), "y": round3(c.text.y)}),
        );
    }
    if c.kind == ClipKind::Solid {
        d.insert("color".into(), hex(c.color).into());
    }
    if let Some(tf) = c.transform
        && !tf.is_identity()
    {
        let mut t = Map::new();
        t.insert("scale".into(), round3(tf.scale));
        t.insert("x".into(), round3(tf.x));
        t.insert("y".into(), round3(tf.y));
        // An animated zoom: seconds into the clip that it moves in and out.
        if let Some(z) = tf.zoom {
            let mode = match z.mode {
                ZoomMode::ZoomIn => "in",
                ZoomMode::ZoomOut => "out",
                ZoomMode::InOut => "in_out",
            };
            let mut zd = Map::new();
            zd.insert("mode".into(), mode.into());
            zd.insert("smooth".into(), z.smooth.into());
            if z.mode != ZoomMode::ZoomOut {
                zd.insert("in".into(), json!([round3(z.p1), round3(z.p2)]));
            }
            if z.mode != ZoomMode::ZoomIn {
                zd.insert("out".into(), json!([round3(z.p3), round3(z.p4)]));
            }
            t.insert("zoom".into(), Value::Object(zd));
        }
        d.insert("transform".into(), Value::Object(t));
    }
    if let Some(g) = &c.grade {
        let mut gd = Map::new();
        if let Some(look) = &g.look {
            let label = look_label(look);
            if *look != label {
                gd.insert("look_file".into(), look.clone().into());
            }
            gd.insert("look".into(), label.into());
        }
        if g.look_intensity != 1.0 {
            gd.insert("look_intensity".into(), num(g.look_intensity));
        }
        for (k, v) in [("exposure", g.exposure), ("contrast", g.contrast), ("saturation", g.saturation), ("temperature", g.temperature), ("tint", g.tint)] {
            if v != 0.0 {
                gd.insert(k.into(), round3(v));
            }
        }
        d.insert("grade".into(), Value::Object(gd));
    }
    Value::Object(d)
}

pub fn clips(ids: &[Id], p: &Project) -> Value {
    Value::Array(ids.iter().filter_map(|i| p.clip(*i)).map(|c| clip(c, p)).collect())
}

/// Sound clips whose speech shows on the caption track (`Project.captionedClips`).
pub fn captioned_clips(p: &Project) -> Vec<&Clip> {
    if p.captions.is_none() {
        return vec![];
    }
    p.clips.iter().filter(|c| c.captioned == Some(true) && c.kind == ClipKind::Audio && c.plays_source() && !c.plays_backwards()).collect()
}

pub fn project(p: &Project, title: &str, playhead: f64) -> Value {
    let mut tracks: Vec<Value> = p
        .video_tracks
        .iter()
        .enumerate()
        .rev()
        .map(|(i, t)| json!({"name": format!("V{}", i + 1), "kind": "video", "hidden": t.hidden, "locked": t.locked}))
        .collect();
    tracks.extend(p.audio_tracks.iter().enumerate().map(|(i, t)| {
        json!({"name": format!("A{}", i + 1), "kind": "audio", "muted": t.muted, "solo": t.solo, "locked": t.locked, "gain_db": num(t.gain_db)})
    }));
    let mut sorted: Vec<&Clip> = p.clips.iter().collect();
    sorted.sort_by(|a, b| {
        (track_name(a.track_id, p), a.start).partial_cmp(&(track_name(b.track_id, p), b.start)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let markers: Vec<Value> = p
        .marker_list()
        .iter()
        .map(|m| json!({"id": id(m.id), "time": round3(m.time), "name": m.name, "color": tint_name(m.tint)}))
        .collect();
    json!({
        "name": title,
        "sequence": {"width": p.width, "height": p.height, "fps": num(p.fps), "duration": round3(p.duration())},
        "playhead": round3(playhead),
        "tracks": tracks,
        "clips": sorted.iter().map(|c| clip(c, p)).collect::<Vec<_>>(),
        "markers": markers,
        "in_out": p.play_range().map(|(a, b)| json!({"in": round3(a), "out": round3(b)})).unwrap_or(Value::Null),
        "captions": p.captions.as_ref().map(|c| json!({
            "hidden": c.hidden, "size": num(c.style.size), "position": num(c.style.y), "highlight": c.style.highlight,
            "clip_ids": captioned_clips(p).iter().map(|c| id(c.id)).collect::<Vec<_>>(),
        })).unwrap_or(Value::Null),
    })
}

pub fn tint_name(t: promptedit_core::MarkerTint) -> &'static str {
    use promptedit_core::MarkerTint::*;
    match t {
        White => "white",
        Yellow => "yellow",
        Green => "green",
        Blue => "blue",
        Purple => "purple",
        Red => "red",
    }
}

pub fn asset(a: &MediaAsset) -> Value {
    let mut d = Map::new();
    d.insert("id".into(), id(a.id));
    d.insert("name".into(), a.name.clone().into());
    d.insert("kind".into(), media_kind_name(a.kind).into());
    d.insert("path".into(), a.path.clone().into());
    if a.kind != MediaKind::Image {
        d.insert("duration".into(), round3(a.duration));
    }
    if a.kind != MediaKind::Audio {
        d.insert("width".into(), a.width.into());
        d.insert("height".into(), a.height.into());
    }
    if a.kind == MediaKind::Video {
        d.insert("fps".into(), round3(a.fps));
        d.insert("has_audio".into(), a.has_audio.into());
    }
    Value::Object(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_like_swift() {
        assert_eq!(round3(5.416_999_99).to_string(), "5.417");
        assert_eq!(round3(30.0).to_string(), "30");
        assert_eq!(num(29.97).to_string(), "29.97");
        assert_eq!(pretty(&json!({"b": 1, "a": [1]})), "{\n  \"a\" : [\n    1\n  ],\n  \"b\" : 1\n}");
    }
}
