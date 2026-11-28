import { describe, expect, it } from "vitest";
import { changeLines, checkDue, CHECK_INTERVAL_MS, compareVersions, downloadProgressText, formatBytes, isSkipped } from "./notes";

describe("changeLines", () => {
  it("lists a change a line, bullets and blank lines taken off", () => {
    expect(changeLines("• Faster export\n- Captions in Thai\n\n  * Fixed a crash on open  \r\nPlain line")).toEqual([
      "Faster export", "Captions in Thai", "Fixed a crash on open", "Plain line",
    ]);
  });
  it("drops Markdown headings but keeps text that starts with a dash or stars", () => {
    expect(changeLines("## What's new\n-5% smaller downloads\n**Bold** change\n•No space")).toEqual([
      "-5% smaller downloads", "**Bold** change", "No space",
    ]);
  });
  it("has nothing for empty notes", () => {
    expect(changeLines("")).toEqual([]);
    expect(changeLines(undefined)).toEqual([]);
    expect(changeLines(" \n • \n")).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("orders by number, not text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.11", "1.0.12")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });
  it("allows a tag's v and missing parts", () => {
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
  it("puts a pre-release before its release", () => {
    expect(compareVersions("1.2.0-beta.2", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0-beta.10", "1.2.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0-alpha", "1.2.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.2.0-beta", "1.2.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("1.2.0-1", "1.2.0-alpha")).toBeLessThan(0);
  });
  it("ignores build metadata", () => {
    expect(compareVersions("1.2.0+42", "1.2.0+7")).toBe(0);
  });
});

describe("isSkipped", () => {
  it("passes by the skipped version and older, not newer ones", () => {
    expect(isSkipped("0.2.0", "0.2.0")).toBe(true);
    expect(isSkipped("0.1.9", "0.2.0")).toBe(true);
    expect(isSkipped("0.2.1", "0.2.0")).toBe(false);
    expect(isSkipped("0.2.0", null)).toBe(false);
  });
});

describe("checkDue", () => {
  const now = 1_800_000_000_000;
  it("checks the first time and once a day after", () => {
    expect(checkDue(null, now)).toBe(true);
    expect(checkDue(now - CHECK_INTERVAL_MS + 1000, now)).toBe(false);
    expect(checkDue(now - CHECK_INTERVAL_MS, now)).toBe(true);
  });
  it("checks when the clock went back", () => {
    expect(checkDue(now + 60_000, now)).toBe(true);
  });
});

describe("download sizes", () => {
  it("reads like Finder", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1500)).toBe("1.5 KB");
    expect(formatBytes(84_000_000)).toBe("84 MB");
    expect(formatBytes(1_230_000_000)).toBe("1.2 GB");
  });
  it("says how far a download has got", () => {
    expect(downloadProgressText(12_300_000, 84_000_000)).toBe("12 MB of 84 MB");
    expect(downloadProgressText(3_400_000, 84_000_000)).toBe("3.4 MB of 84 MB");
    expect(downloadProgressText(90_000_000, 84_000_000)).toBe("84 MB of 84 MB");
    expect(downloadProgressText(3_400_000, null)).toBe("3.4 MB");
  });
});
