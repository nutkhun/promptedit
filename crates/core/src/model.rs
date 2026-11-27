//! The project, as Editroom stores it (Editroom/Model/Project.swift and friends).
//!
//! Field names, defaults and optionality match the Swift types so PromptEdit reads and writes
//! `.editroom` files. Swift's synthesised `Codable` requires every non-optional key; we are
//! more lenient on read (missing keys take the Swift default) and identical on write.

use crate::id::{Id, uuid_keyed_map};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Rgba {
    pub const WHITE: Rgba = Rgba { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
    pub const BLACK: Rgba = Rgba { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Track {
    pub id: Id,
    pub kind: TrackKind,
    pub hidden: bool,
    pub muted: bool,
    #[serde(rename = "gainDB")]
    pub gain_db: f64,
    /// Audio only: while any track is soloed, only soloed tracks are heard.
    pub solo: bool,
    /// A locked track's clips can't be selected, moved, trimmed or cut.
    pub locked: bool,
    /// Audio only: turned down while the named track has sound (music under a voice).
    #[serde(rename = "duckUnder", skip_serializing_if = "Option::is_none")]
    pub duck_under: Option<Id>,
    #[serde(rename = "duckDB")]
    pub duck_db: f64,
}

impl Track {
    pub fn new(kind: TrackKind) -> Self {
        Track {
            id: Id::new(),
            kind,
            hidden: false,
            muted: false,
            gain_db: 0.0,
            solo: false,
            locked: false,
            duck_under: None,
            duck_db: -12.0,
        }
    }
}

impl Default for Track {
    fn default() -> Self {
        Track::new(TrackKind::Video)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipKind {
    Video,
    Audio,
    Image,
    Solid,
    Text,
}

impl ClipKind {
    pub fn track_kind(self) -> TrackKind {
        if self == ClipKind::Audio { TrackKind::Audio } else { TrackKind::Video }
    }
    pub fn uses_source(self) -> bool {
        matches!(self, ClipKind::Video | ClipKind::Audio)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TextStyle {
    pub string: String,
    /// Font family; empty means the system font.
    pub font_name: String,
    pub bold: bool,
    /// Point size relative to a 1080px tall frame.
    pub size: f64,
    pub color: Rgba,
    pub x: f64,
    pub y: f64,
}

impl Default for TextStyle {
    fn default() -> Self {
        TextStyle {
            string: "Text".into(),
            font_name: String::new(),
            bold: true,
            size: 110.0,
            color: Rgba::WHITE,
            x: 0.5,
            y: 0.5,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FadeCurve {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    Smooth,
}

impl FadeCurve {
    pub const ALL: [FadeCurve; 4] = [FadeCurve::Linear, FadeCurve::EaseIn, FadeCurve::EaseOut, FadeCurve::Smooth];

    pub fn label(self) -> &'static str {
        match self {
            FadeCurve::Linear => "Linear",
            FadeCurve::EaseIn => "Exponential",
            FadeCurve::EaseOut => "Logarithmic",
            FadeCurve::Smooth => "S-Curve",
        }
    }

    /// Maps fade progress (0 = silent/transparent, 1 = full) through the curve.
    pub fn apply(self, x: f64) -> f64 {
        let x = x.clamp(0.0, 1.0);
        match self {
            FadeCurve::Linear => x,
            FadeCurve::EaseIn => x * x * x,
            FadeCurve::EaseOut => 1.0 - (1.0 - x).powi(3),
            FadeCurve::Smooth => x * x * (3.0 - 2.0 * x),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    #[default]
    Dissolve,
    DipToBlack,
    Wipe,
}

impl TransitionKind {
    pub fn label(self) -> &'static str {
        match self {
            TransitionKind::Dissolve => "Dissolve",
            TransitionKind::DipToBlack => "Dip to Black",
            TransitionKind::Wipe => "Wipe",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Transition {
    pub kind: TransitionKind,
    /// Seconds; may be shortened to what the clips allow.
    pub duration: f64,
}

impl Default for Transition {
    fn default() -> Self {
        Transition { kind: TransitionKind::Dissolve, duration: 0.5 }
    }
}

/// The footage a reversed clip was made from.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseSource {
    #[serde(rename = "assetID")]
    pub asset_id: Id,
    pub source_start: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum ZoomMode {
    /// From the full frame to the zoomed framing.
    #[default]
    #[serde(rename = "in")]
    ZoomIn,
    /// In, hold, and back out.
    #[serde(rename = "inOut")]
    InOut,
    /// From the zoomed framing back to the full frame.
    #[serde(rename = "out")]
    ZoomOut,
}

/// A zoom over a clip, set on its Scale (Editroom/Model/ZoomMove.swift).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ZoomMove {
    pub mode: ZoomMode,
    /// Seconds from the clip's start: the move in runs `p1..p2`, the move out `p3..p4`.
    pub p1: f64,
    pub p2: f64,
    pub p3: f64,
    pub p4: f64,
    /// Eased at both ends of each move; otherwise at an even pace.
    #[serde(default = "yes")]
    pub smooth: bool,
}

fn yes() -> bool {
    true
}

/// Scale and position of a clip within the frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClipTransform {
    /// 1 is fitted to the frame.
    pub scale: f64,
    /// Offset of the clip's centre from the frame's centre, as a fraction of the frame's width
    /// and height. Positive y is down.
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<ZoomMove>,
}

impl Default for ClipTransform {
    fn default() -> Self {
        ClipTransform { scale: 1.0, x: 0.0, y: 0.0, zoom: None }
    }
}

impl ClipTransform {
    pub const SCALE_RANGE: (f64, f64) = (0.05, 10.0);
    pub fn is_identity(&self) -> bool {
        *self == ClipTransform::default()
    }
}

/// A clip's speed changing over its footage (Editroom/Model/SpeedRamp.swift). Times are in
/// the clip's source (seconds of footage).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedRamp {
    pub in_from: f64,
    pub in_to: f64,
    pub out_from: f64,
    pub out_to: f64,
    pub start_speed: f64,
    pub end_speed: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WheelPoint {
    pub x: f64,
    pub y: f64,
}

/// Per-clip colour correction (Editroom/Model/ColorGrade.swift).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ColorGrade {
    /// A built-in look's name, or the path of a .cube file. None for none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub look: Option<String>,
    pub look_intensity: f64,
    /// Stops, -2..2.
    pub exposure: f64,
    /// -50..50.
    pub contrast: f64,
    /// -100..100.
    pub saturation: f64,
    /// -50..50, negative is cooler.
    pub temperature: f64,
    /// -50..50, positive is toward magenta.
    pub tint: f64,
    pub shadows: WheelPoint,
    pub midtones: WheelPoint,
    pub highlights: WheelPoint,
}

impl Default for ColorGrade {
    fn default() -> Self {
        ColorGrade {
            look: None,
            look_intensity: 1.0,
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            tint: 0.0,
            shadows: WheelPoint::default(),
            midtones: WheelPoint::default(),
            highlights: WheelPoint::default(),
        }
    }
}

impl ColorGrade {
    /// No look and every adjustment at zero (look strength doesn't count without a look).
    pub fn is_neutral(&self) -> bool {
        let mut g = self.clone();
        if g.look.is_none() {
            g.look_intensity = 1.0;
        }
        g == ColorGrade::default()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Clip {
    pub id: Id,
    #[serde(rename = "trackID")]
    pub track_id: Id,
    pub kind: ClipKind,
    #[serde(rename = "assetID", skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<Id>,
    pub start: f64,
    pub duration: f64,
    pub source_start: f64,
    pub speed: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade_in_curve: Option<FadeCurve>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade_out_curve: Option<FadeCurve>,
    #[serde(rename = "gainDB")]
    pub gain_db: f64,
    #[serde(rename = "linkID", skip_serializing_if = "Option::is_none")]
    pub link_id: Option<Id>,
    pub color: Rgba,
    pub text: TextStyle,
    /// Colour correction for visual clips; None means untouched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grade: Option<ColorGrade>,
    /// Size and placement for video, image and solid clips; None means fitted to the frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<ClipTransform>,
    /// A transition into this clip from the clip that ends where it starts, on the same track.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_in: Option<Transition>,
    /// A freeze frame: shows the single frame at `source_start` for its whole length.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freeze: Option<bool>,
    /// Set on a reversed clip (older projects): where its footage came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reversed_from: Option<ReverseSource>,
    /// Plays its source backwards. Source time `s` is time `length - s` in the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reversed: Option<bool>,
    /// The speed changing across the clip; None plays at `speed` throughout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ramp: Option<SpeedRamp>,
    /// A sound clip whose speech shows on the caption track.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captioned: Option<bool>,
}

impl Default for Clip {
    fn default() -> Self {
        Clip {
            id: Id::new(),
            track_id: Id::default(),
            kind: ClipKind::Video,
            asset_id: None,
            start: 0.0,
            duration: 0.0,
            source_start: 0.0,
            speed: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            fade_in_curve: None,
            fade_out_curve: None,
            gain_db: 0.0,
            link_id: None,
            color: Rgba { r: 0.16, g: 0.16, b: 0.2, a: 1.0 },
            text: TextStyle::default(),
            grade: None,
            transform: None,
            transition_in: None,
            freeze: None,
            reversed_from: None,
            reversed: None,
            ramp: None,
            captioned: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: Id,
    pub path: String,
    /// `path` as seen from the project file's folder, written on save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    /// Set when the original had to be converted to something the engine can decode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playable_path: Option<String>,
    pub name: String,
    pub kind: MediaKind,
    pub duration: f64,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub has_audio: bool,
    /// A macOS security-scoped bookmark (base64), kept as-is so Editroom can still use it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerTint {
    White,
    #[default]
    Yellow,
    Green,
    Blue,
    Purple,
    Red,
}

impl MarkerTint {
    pub fn hex(self) -> u32 {
        match self {
            MarkerTint::White => 0xEDEDEA,
            MarkerTint::Yellow => 0xF2B33D,
            MarkerTint::Green => 0x6CC08B,
            MarkerTint::Blue => 0x5B9BF0,
            MarkerTint::Purple => 0xB07CF0,
            MarkerTint::Red => 0xF0503C,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    #[serde(default = "Id::new")]
    pub id: Id,
    pub time: f64,
    pub name: String,
    #[serde(default)]
    pub tint: MarkerTint,
}

/// A prompt sent with Magic. `date` is seconds since 2001-01-01 (Swift's reference date).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MagicHistoryEntry {
    pub text: String,
    /// The Magic tab it was sent from (claude, chatgpt, local).
    pub tab: String,
    pub date: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CaptionStyle {
    /// Point size relative to a 1080px frame's shorter side.
    pub size: f64,
    /// Where the captions sit, as a fraction down the frame (their middle).
    pub y: f64,
    /// The word being said lights up.
    pub highlight: bool,
    pub text_color: Rgba,
    pub highlight_color: Rgba,
    /// A dark edge around the letters.
    pub outline: bool,
    pub outline_color: Rgba,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        CaptionStyle {
            size: 64.0,
            y: 0.78,
            highlight: true,
            text_color: Rgba::WHITE,
            highlight_color: Rgba { r: 1.0, g: 0.84, b: 0.25, a: 1.0 },
            outline: true,
            outline_color: Rgba::BLACK,
        }
    }
}

impl CaptionStyle {
    pub const SIZE_RANGE: (f64, f64) = (28.0, 140.0);
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptionTrack {
    pub hidden: bool,
    pub style: CaptionStyle,
}

/// A change to one word of a file's transcript: new text, or "" to leave it out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CaptionFix {
    /// The word's start in the file, which identifies it.
    pub start: f64,
    pub text: String,
    /// Joined to the word before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged: Option<bool>,
}

/// A folder on disk brought in whole, which the Media panel mirrors.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFolder {
    #[serde(default = "Id::new")]
    pub id: Id,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark: Option<String>,
}

/// Placeholder track ids used while a drag targets a track that doesn't exist yet.
pub mod track_token {
    use crate::id::Id;
    pub const NEW_VIDEO: Id = Id::from_u128(0xA1);
    pub const NEW_AUDIO: Id = Id::from_u128(0xA2);
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Project {
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub settings_locked: bool,
    /// Index 0 is the bottom-most video track (V1).
    pub video_tracks: Vec<Track>,
    /// Index 0 is the top-most audio track (A1).
    pub audio_tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub assets: Vec<MediaAsset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markers: Option<Vec<Marker>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_point: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_point: Option<f64>,
    /// Prompts sent with Magic in this project, newest first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magic_history: Option<Vec<MagicHistoryEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captions: Option<CaptionTrack>,
    /// Words fixed or left out on captions, by file.
    #[serde(with = "uuid_keyed_map", skip_serializing_if = "Option::is_none")]
    pub caption_fixes: Option<BTreeMap<Id, Vec<CaptionFix>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<MediaFolder>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_media: Option<Vec<String>>,
}

impl Default for Project {
    fn default() -> Self {
        Project {
            width: 1920,
            height: 1080,
            fps: 30.0,
            settings_locked: false,
            video_tracks: vec![Track::new(TrackKind::Video), Track::new(TrackKind::Video)],
            audio_tracks: vec![Track::new(TrackKind::Audio), Track::new(TrackKind::Audio)],
            clips: vec![],
            assets: vec![],
            export_name: None,
            export_dir: None,
            markers: None,
            in_point: None,
            out_point: None,
            magic_history: None,
            captions: None,
            caption_fixes: None,
            folders: None,
            hidden_media: None,
        }
    }
}

/// The file on disk: `{"version": 1, "project": {…}}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedDocument {
    #[serde(default = "one")]
    pub version: i64,
    pub project: Project,
}

fn one() -> i64 {
    1
}

impl SavedDocument {
    pub fn new(project: Project) -> Self {
        SavedDocument { version: 1, project }
    }
    pub fn from_json(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }
    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("project always serialises")
    }
}
