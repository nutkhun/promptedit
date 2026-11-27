// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `PromptEdit --mcp`: the stdio bridge for AI apps (no window); exits when stdin closes.
    if std::env::args().any(|a| a == "--mcp") {
        std::process::exit(promptedit_lib::mcp::bridge::run());
    }
    promptedit_lib::run()
}
