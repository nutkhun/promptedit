//! Software updates (docs/spec/04-ui.md §6.1): `tauri-plugin-updater` checks GitHub Releases
//! (`plugins.updater.endpoints` in tauri.conf.json) and the UI (src/ui/updates) drives every step.
//!
//! The updater only starts in a build that knows the public half of the update signing key. That key
//! isn't in the repository: release builds get it from CI (scripts/updater-config.mjs writes it into
//! `plugins.updater.pubkey`), so a local or unconfigured build has an empty pubkey and doesn't check
//! at all — the UI then says "This build doesn't check for updates." rather than failing every check.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{App, Runtime};

static ENABLED: AtomicBool = AtomicBool::new(false);

/// The configured public key, if there is one.
fn configured_pubkey<R: Runtime>(app: &App<R>) -> Option<String> {
    let key = app.config().plugins.0.get("updater")?.get("pubkey")?.as_str()?.trim().to_string();
    (!key.is_empty()).then_some(key)
}

/// Test and helper launches (`--open`, `--magic-local`, …) never check: an update alert would stop them.
fn helper_launch() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("--"))
}

/// Registers the updater plugin when this build can verify updates. Called from the app's setup.
pub fn setup<R: Runtime>(app: &App<R>) {
    if configured_pubkey(app).is_none() {
        return;
    }
    match app.handle().plugin(tauri_plugin_updater::Builder::new().build()) {
        Ok(()) => ENABLED.store(!helper_launch(), Ordering::Relaxed),
        Err(e) => eprintln!("The updater didn't start: {e}"),
    }
}

/// Whether this build checks for updates (the UI asks once at launch).
#[tauri::command]
pub fn updates_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}
