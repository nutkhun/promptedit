// Shortcut table and dispatch rules (docs/spec/04-ui.md §4.1; Editroom SelfTest "Shortcuts").

import { beforeEach, describe, expect, it } from "vitest";
import { accelerator, displayCombo, sameCombo, shortcuts, typesText, useShortcuts } from "./commands";

describe("shortcuts", () => {
  beforeEach(() => shortcuts.resetAll());

  it("has Editroom's defaults", () => {
    expect(shortcuts.actionFor({ key: "space" })).toBe("playPause");
    expect(shortcuts.actionFor({ key: "s", shift: true })).toBe("audioScrubbing");
    expect(shortcuts.actionFor({ key: "s", command: true })).toBe("save");
    expect(shortcuts.actionFor({ key: "delete", shift: true })).toBe("rippleDelete");
  });

  it("moves a key to its new action and takes it from the old one", () => {
    expect(shortcuts.set("snapping", { key: "p" })).toBeUndefined();
    expect(shortcuts.actionFor({ key: "p" })).toBe("snapping");
    expect(shortcuts.actionFor({ key: "s" })).toBeUndefined();
    // ⇧S to Loop takes it from Audio Scrubbing.
    expect(shortcuts.set("loop", { key: "s", shift: true })).toBe("audioScrubbing");
    expect(shortcuts.combos("audioScrubbing")).toEqual([]);
    expect(shortcuts.isChanged("audioScrubbing")).toBe(true);
  });

  it("restores defaults", () => {
    shortcuts.set("loop", { key: "s", shift: true });
    shortcuts.reset("audioScrubbing");
    expect(shortcuts.actionFor({ key: "s", shift: true })).toBe("loop");
    shortcuts.resetAll();
    expect(useShortcuts.getState().changed).toEqual({});
    expect(shortcuts.actionFor({ key: "s", shift: true })).toBe("audioScrubbing");
  });

  it("never gives plain multi-character keys to menus, but keeps ⌘ combos", () => {
    expect(shortcuts.menuCombo("delete")).toBeUndefined();
    expect(shortcuts.menuCombo("rippleDelete")).toBeUndefined();
    expect(sameCombo(shortcuts.menuCombo("save")!, { key: "s", command: true })).toBe(true);
  });

  it("formats keys per platform", () => {
    expect(displayCombo({ key: "s", command: true, shift: true }, true)).toBe("⇧⌘S");
    expect(displayCombo({ key: "s", command: true, shift: true }, false)).toBe("Ctrl+Shift+S");
    expect(displayCombo({ key: "delete" }, true)).toBe("⌫");
    expect(displayCombo({ key: "forwardDelete" }, false)).toBe("Del");
    expect(accelerator({ key: "=", command: true })).toBe("CmdOrCtrl+Equal");
    expect(typesText({ key: "s", shift: true })).toBe(true);
    expect(typesText({ key: "s", command: true })).toBe(false);
  });
});
