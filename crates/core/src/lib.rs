//! PromptEdit's core: the project model (compatible with Editroom's files), edit operations,
//! undo and timecode. No UI and no media I/O, so it is tested on any OS.

pub mod edit;
pub mod folders;
pub mod history;
pub mod id;
pub mod model;
pub mod paths;
pub mod project;
pub mod timecode;
pub mod timing;

pub use id::Id;
pub use model::*;
pub use project::{Ids, TransitionEdge, TransitionPlan, TransitionSpan, db_to_linear, format_db};
