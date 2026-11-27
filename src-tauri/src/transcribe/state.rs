//! The states the UI sees (docs/spec/05-captions-contract.md), serialised exactly as the contract's
//! TypeScript unions: `{ "state": "working", "progress": 0.4 }`.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TranscriptState {
    None,
    Queued,
    /// Waiting for the speech model, which the person hasn't downloaded yet.
    NeedsModel,
    Working { progress: f64 },
    Ready { words: usize },
    Failed { message: String },
}

impl TranscriptState {
    /// Queued, waiting for the model, or being heard now.
    pub fn is_pending(&self) -> bool {
        matches!(self, TranscriptState::Queued | TranscriptState::NeedsModel | TranscriptState::Working { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ModelState {
    Missing,
    Downloading { progress: f64 },
    Ready,
    Failed { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serialises_like_the_contract() {
        let v = |s: &TranscriptState| serde_json::to_value(s).unwrap();
        assert_eq!(v(&TranscriptState::None), json!({"state": "none"}));
        assert_eq!(v(&TranscriptState::NeedsModel), json!({"state": "needsModel"}));
        assert_eq!(v(&TranscriptState::Working { progress: 0.5 }), json!({"state": "working", "progress": 0.5}));
        assert_eq!(v(&TranscriptState::Ready { words: 3 }), json!({"state": "ready", "words": 3}));
        assert_eq!(v(&TranscriptState::Failed { message: "x".into() }), json!({"state": "failed", "message": "x"}));
        let m = serde_json::to_value(ModelState::Downloading { progress: 0.25 }).unwrap();
        assert_eq!(m, json!({"state": "downloading", "progress": 0.25}));
        assert_eq!(serde_json::to_value(ModelState::Missing).unwrap(), json!({"state": "missing"}));
    }
}
