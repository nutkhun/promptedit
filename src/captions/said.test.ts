import { describe, expect, it } from "vitest";
import type { Transcript } from "./layout";
import { quotedPhrases, says, snippet, tokens, withoutQuotes } from "./said";

const t = (s: string): Transcript => ({ words: s.split(" ").map((text, i) => ({ start: i, end: i + 0.5, text })), language: "en" });
const trip = t("okay guys, we're on the way to the birthday party now and then we eat cake");

describe("what's said", () => {
  it("tokens: lower case, punctuation aside, apostrophes kept", () => {
    expect(tokens("Okay, GUYS! We're here…")).toEqual(["okay", "guys", "we're", "here"]);
    expect(tokens("สวัสดี ครับ")).toEqual(["สวัสดี", "ครับ"]);
  });

  it("says: the words in order, the last one begun while typing", () => {
    expect(says(trip, "birthday party")).toBe(true);
    expect(says(trip, "Birthday, party!")).toBe(true);
    expect(says(trip, "party birthday")).toBe(false);
    expect(says(trip, "birthday par")).toBe(false);
    expect(says(trip, "birthday par", true)).toBe(true);
    expect(says(trip, "birth party", true)).toBe(false);
    expect(says(trip, "")).toBe(false);
  });

  it("snippet: three words before, four after, ellipses where there's more", () => {
    expect(snippet(trip, "birthday")).toEqual({ before: "…way to the", match: "birthday", after: "party now and then…" });
    expect(snippet(trip, "okay gu", true)).toEqual({ before: "", match: "okay guys,", after: "we're on the way…" });
    expect(snippet(trip, "eat cake")).toEqual({ before: "…and then we", match: "eat cake", after: "" });
    expect(snippet(trip, "pizza")).toBeUndefined();
  });

  it("quoted phrases, straight or curly, the closing quote optional", () => {
    expect(quotedPhrases(`"birthday cake" beach “okay gu`)).toEqual(["birthday cake", "okay gu"]);
    expect(withoutQuotes(`"birthday cake" beach`)).toBe("beach");
    expect(quotedPhrases(`""`)).toEqual([]);
  });
});
