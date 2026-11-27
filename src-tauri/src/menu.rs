//! The native menu bar (docs/spec/04-ui.md §4.2).
//!
//! The menus are described once, in the UI (`src/ui/shell/menuModel.ts`): which items there are, their
//! titles, shortcuts, enabled and ticked states. On macOS the UI sends that description here and it
//! becomes the app's menu bar; clicks come back as a `menu` event carrying the item's id. The UI sends a
//! new description whenever what's possible changes (a selection, Undo becoming available…).
//!
//! On Windows the window has its own title bar (no system frame, to keep Editroom's one-row unified
//! look), and a native Win32 menu would add a second row under it, so the UI draws the same menus in the
//! title bar instead and `set_app_menu` does nothing there.

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// One entry of the menu description sent by the UI.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Node {
    Item {
        id: String,
        text: String,
        #[serde(default = "yes")]
        enabled: bool,
        /// Some(..) makes a check item (View › Snapping…).
        #[serde(default)]
        checked: Option<bool>,
        /// Tauri accelerator ("CmdOrCtrl+Shift+S"). Only modifier combos: bare keys stay with the
        /// window's key handler so text fields can type them.
        #[serde(default)]
        accelerator: Option<String>,
    },
    Separator,
    Submenu {
        text: String,
        #[serde(default = "yes")]
        enabled: bool,
        items: Vec<Node>,
    },
    /// macOS standard items: Cut/Copy/Paste must be these for text fields to work.
    Predefined {
        which: String,
        #[serde(default)]
        text: Option<String>,
    },
}

fn yes() -> bool {
    true
}

fn build_item<R: Runtime>(app: &AppHandle<R>, node: &Node) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    Ok(match node {
        Node::Item { id, text, enabled, checked, accelerator } => match checked {
            Some(on) => Box::new(CheckMenuItem::with_id(app, id.as_str(), text, *enabled, *on, accelerator.as_deref())?),
            None => Box::new(MenuItem::with_id(app, id.as_str(), text, *enabled, accelerator.as_deref())?),
        },
        Node::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        Node::Submenu { text, enabled, items } => {
            let sub = Submenu::new(app, text, *enabled)?;
            for n in items {
                sub.append(build_item(app, n)?.as_ref())?;
            }
            Box::new(sub)
        }
        Node::Predefined { which, text } => {
            let t = text.as_deref();
            Box::new(match which.as_str() {
                "cut" => PredefinedMenuItem::cut(app, t)?,
                "copy" => PredefinedMenuItem::copy(app, t)?,
                "paste" => PredefinedMenuItem::paste(app, t)?,
                "selectAll" => PredefinedMenuItem::select_all(app, t)?,
                "hide" => PredefinedMenuItem::hide(app, t)?,
                "hideOthers" => PredefinedMenuItem::hide_others(app, t)?,
                "showAll" => PredefinedMenuItem::show_all(app, t)?,
                "quit" => PredefinedMenuItem::quit(app, t)?,
                "minimize" => PredefinedMenuItem::minimize(app, t)?,
                "zoom" => PredefinedMenuItem::maximize(app, t)?,
                "fullscreen" => PredefinedMenuItem::fullscreen(app, t)?,
                "closeWindow" => PredefinedMenuItem::close_window(app, t)?,
                _ => PredefinedMenuItem::separator(app)?,
            })
        }
    })
}

/// Builds a whole menu bar from the description: top-level nodes must be submenus.
pub fn build<R: Runtime>(app: &AppHandle<R>, top: &[Node]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for n in top {
        menu.append(build_item(app, n)?.as_ref())?;
    }
    Ok(menu)
}

/// Replaces the app's menu bar (macOS). Returns whether a native menu is in use on this platform.
#[tauri::command]
pub fn set_app_menu<R: Runtime>(app: AppHandle<R>, menus: Vec<Node>) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Ok(false);
    }
    let menu = build(&app, &menus).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Menu clicks go to the UI, which knows what each id does.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let _ = app.emit("menu", event.id().0.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ui_description() {
        let json = serde_json::json!([
            { "kind": "submenu", "text": "File", "items": [
                { "kind": "item", "id": "action.new", "text": "New", "enabled": true, "accelerator": "CmdOrCtrl+N" },
                { "kind": "separator" },
                { "kind": "item", "id": "view.snap", "text": "Snapping", "checked": true },
                { "kind": "predefined", "which": "copy" },
                { "kind": "submenu", "text": "Open Recent", "items": [] }
            ]}
        ]);
        let nodes: Vec<Node> = serde_json::from_value(json).unwrap();
        let Node::Submenu { items, .. } = &nodes[0] else { panic!("not a submenu") };
        assert_eq!(items.len(), 5);
        assert!(matches!(&items[2], Node::Item { checked: Some(true), enabled: true, .. }));
    }
}
