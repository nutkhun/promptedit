//! Hearing a file with whisper.cpp (spec 02-engine §18 "Port"): token timestamps, words made from
//! tokens (see `words`), the language detected once and then kept for the rest of the file.

use super::audio::{self, Reader};
use super::models::ModelId;
use super::voice::Voice;
use super::words::{self, Piece};
use crate::mcp::providers::{Transcript, Word};
use std::ffi::{c_int, c_void};
use std::path::Path;
use whisper_rs::{DtwMode, DtwModelPreset, DtwParameters, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperSysContext, WhisperSysState};

/// A loaded model.
pub struct Engine {
    ctx: WhisperContext,
    pub model: ModelId,
}

/// whisper.cpp logs every step to stderr; this sends it to the (absent) `log` backend instead.
pub fn quiet() {
    static QUIET: std::sync::Once = std::sync::Once::new();
    QUIET.call_once(whisper_rs::install_logging_hooks);
}

impl Engine {
    pub fn load(path: &Path, model: ModelId) -> Result<Engine, String> {
        quiet();
        let mut params = WhisperContextParameters::default();
        // DTW word timing: token timestamps alone run a few hundred milliseconds early (they put
        // "Hello" at 0.0 s for a clip whose speech starts at 1.0 s). Each model has its own
        // alignment heads. Where DTW can't run, `t_dtw` comes back -1 and token times are used.
        let preset = match model {
            ModelId::Fast => DtwModelPreset::Base,
            ModelId::Balanced => DtwModelPreset::Small,
            ModelId::Best => DtwModelPreset::LargeV3Turbo,
        };
        params.dtw_parameters(DtwParameters { mode: DtwMode::ModelPreset { model_preset: preset }, ..Default::default() });
        let path = path.to_str().ok_or("The speech model's folder has a name whisper can't open.")?;
        let ctx = WhisperContext::new_with_params(path, params).map_err(|e| format!("Couldn't load the speech model ({e}). Try downloading it again."))?;
        Ok(Engine { ctx, model })
    }

    /// Every word said in `file` (`duration` seconds long, for progress). `language` is `auto` or a
    /// code. `progress` gets 0…1; `cancelled` is asked now and then and stops the work.
    pub fn transcribe(
        &self,
        file: &Path,
        duration: f64,
        language: &str,
        progress: &mut dyn FnMut(f64),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Transcript, String> {
        self.transcribe_in_pieces(file, duration, language, progress, cancelled, audio::CHUNK)
    }

    /// `transcribe`, hearing `chunk` samples at a time (shorter in tests, to try the joins).
    pub(super) fn transcribe_in_pieces(
        &self,
        file: &Path,
        duration: f64,
        language: &str,
        progress: &mut dyn FnMut(f64),
        cancelled: &dyn Fn() -> bool,
        chunk: usize,
    ) -> Result<Transcript, String> {
        let mut reader = Reader::open(file)?;
        let mut state = self.ctx.create_state().map_err(|e| format!("Couldn't start the speech model: {e}"))?;
        let total = (duration * audio::RATE as f64).max(1.0);
        let mut offset = 0usize; // samples heard so far
        let mut lang: Option<String> = (language != "auto").then(|| language.to_string());
        let mut out: Vec<Word> = vec![];
        while let Some(mut piece) = reader.next_piece(chunk)? {
            if cancelled() {
                return Err(CANCELLED.into());
            }
            let len = piece.len();
            // whisper wants at least a second; silence after the end changes nothing.
            if piece.len() < audio::RATE + audio::RATE / 10 {
                piece.resize(audio::RATE + audio::RATE / 10, 0.0);
            }
            // The last words heard carry on as context, as whisper does within a piece.
            let prompt = out.iter().rev().take(32).rev().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            let base = offset as f64 / audio::RATE as f64;
            let voice = Voice::new(&piece[..len], base);
            let mut on_progress = |p: f64| progress(((offset as f64 + p * len as f64) / total).clamp(0.0, 1.0));
            let mut hooks = Hooks { progress: &mut on_progress, cancelled };
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
            params.set_n_threads(threads());
            params.set_language(Some(lang.as_deref().unwrap_or("auto")));
            params.set_translate(false);
            params.set_token_timestamps(true);
            params.set_suppress_blank(true);
            params.set_suppress_nst(true);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_special(false);
            params.set_print_timestamps(false);
            if !prompt.is_empty() {
                params.set_initial_prompt(&prompt);
            }
            // SAFETY: `hooks` outlives `full` below, which is the only time whisper calls these, and
            // the callbacks only touch `hooks`.
            unsafe {
                params.set_progress_callback(Some(on_whisper_progress));
                params.set_progress_callback_user_data(&mut hooks as *mut Hooks as *mut c_void);
                params.set_abort_callback(Some(on_whisper_abort));
                params.set_abort_callback_user_data(&mut hooks as *mut Hooks as *mut c_void);
            }
            let result = state.full(params, &piece);
            if cancelled() {
                return Err(CANCELLED.into());
            }
            result.map_err(|e| format!("The speech model couldn't hear this file ({e})."))?;
            let heard = self.words_of(&state, base, lang.as_deref(), &voice);
            if lang.is_none() && !heard.is_empty() {
                lang = whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(String::from);
            }
            out.extend(heard);
            offset += len;
            progress((offset as f64 / total).min(1.0));
        }
        Ok(Transcript { words: words::tidy(out), language: lang.unwrap_or_default() })
    }

    /// The words of the last `full` run, `base` seconds into the file, whose sound is `voice`.
    fn words_of(&self, state: &whisper_rs::WhisperState, base: f64, lang: Option<&str>, voice: &Voice) -> Vec<Word> {
        if voice.is_silent() {
            return vec![];
        }
        let lang = lang.map(String::from).or_else(|| whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(String::from)).unwrap_or_default();
        let unspaced = words::is_unspaced(&lang);
        let eot = self.ctx.token_eot();
        let mut out = vec![];
        // Where the last word ended (DTW times say where words end, not where they start).
        let mut from = base;
        for segment in state.as_iter() {
            if segment.to_str_lossy().map(|t| words::is_annotation(&t)).unwrap_or(true) {
                continue;
            }
            let mut pieces = vec![];
            let mut anchors = vec![];
            for i in 0..segment.n_tokens() {
                let Some(token) = segment.get_token(i) else { continue };
                let data = token.token_data();
                // End of text, start of transcript, language, timestamps and the like.
                if data.id >= eot {
                    continue;
                }
                let Ok(bytes) = token.to_bytes() else { continue };
                // Times are in hundredths of a second.
                pieces.push(Piece { bytes: bytes.to_vec(), start: base + data.t0 as f64 / 100.0, end: base + data.t1 as f64 / 100.0 });
                anchors.push(if data.t_dtw >= 0 { base + data.t_dtw as f64 / 100.0 } else { -1.0 });
            }
            let dtw = !anchors.is_empty() && anchors.iter().all(|&a| a >= 0.0);
            if dtw {
                from = words::spans_from_dtw(&mut pieces, &anchors, from);
            }
            let mut heard = words::words_from_pieces(&pieces, unspaced);
            if dtw {
                // Heard over silence: whisper making it up.
                if let (Some(a), Some(b)) = (heard.first(), heard.last())
                    && !voice.heard(a.start, b.end)
                {
                    continue;
                }
                voice.trim(&mut heard);
            }
            if let Some(last) = heard.last() {
                from = from.max(last.end);
            }
            out.extend(heard);
        }
        out
    }
}

pub const CANCELLED: &str = "Cancelled.";

/// Leaves a core for the rest of the app (playback, the UI) on small machines.
fn threads() -> c_int {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    n.saturating_sub(1).clamp(1, 8) as c_int
}

struct Hooks<'a> {
    progress: &'a mut dyn FnMut(f64),
    cancelled: &'a dyn Fn() -> bool,
}

unsafe extern "C" fn on_whisper_progress(_: *mut WhisperSysContext, _: *mut WhisperSysState, percent: c_int, data: *mut c_void) {
    // SAFETY: `data` is the `Hooks` set in `transcribe`, alive while whisper runs.
    let hooks = unsafe { &mut *(data as *mut Hooks) };
    (hooks.progress)(percent as f64 / 100.0);
}

unsafe extern "C" fn on_whisper_abort(data: *mut c_void) -> bool {
    // SAFETY: as above.
    let hooks = unsafe { &*(data as *const Hooks) };
    (hooks.cancelled)()
}
