import { beforeAll, describe, expect, it } from "vitest";
// The backend's alias table (served by `scene_aliases` in the app), so these cases test the real one.
import aliases from "../src-tauri/src/scenes/aliases.json";
import { matchingTags, sameStem, setAliases, shows, singular, useScenes, type SceneTags } from "./scenes";
import { looksForPictures, matches, parseSearch, showsMatch } from "./ui/library/search";
import type { MediaAsset } from "./model";

const tags = (...names: string[]): SceneTags => ({ tags: names.map((name) => ({ name, confidence: 0.9, times: [1] })) });

beforeAll(() => setAliases(aliases as Record<string, string[]>));

describe("scene tag words (Editroom SceneTags.shows)", () => {
  it("matches like Editroom's self-test", () => {
    expect(shows(tags("rollercoaster"), "ride")).toBe(true);
    expect(shows(tags("amusement park"), "rides")).toBe(true);
    expect(shows(tags("celebration"), "party")).toBe(true);
    expect(shows(tags("cityscape"), "city")).toBe(true);
    expect(shows(tags("dog"), "puppy")).toBe(true);
    expect(shows(tags("dog"), "ride")).toBe(false);
    expect(shows(tags("rollercoaster"), "laughing")).toBe(false);
    for (const t of ["car", "airplane", "bus", "helicopter"]) expect(shows(tags(t), "vehicle")).toBe(true);
    expect(shows(tags("boat"), "vehicles")).toBe(true);
    expect(shows(tags("laughter"), "laughing")).toBe(true);
    expect(shows(tags("smile"), "smiling")).toBe(true);
    expect(shows(tags("parking"), "park")).toBe(false);
    const pool = tags("swimming pool", "chair");
    expect(shows(pool, "pool") && shows(pool, "chairs")).toBe(true);
    expect(shows(pool, "po", true)).toBe(true);
    expect(shows(pool, "po")).toBe(false);
    expect(shows(tags("portal"), "door")).toBe(true);
    expect(shows(tags("adult"), "wom", true)).toBe(true);
    expect(shows(tags("night sky"), "Night")).toBe(true);
    expect(matchingTags(tags("swimming pool", "water body"), "water").map((t) => t.name)).toEqual(["water body"]);
    expect(sameStem("laughing", "laughter")).toBe(true);
    expect([singular("glass"), singular("dogs"), singular("bus")]).toEqual(["glass", "dog", "bus"]);
  });
});

describe("Media search by name or what's in the picture", () => {
  const asset = (id: string, name: string, kind: MediaAsset["kind"] = "video") =>
    ({ id, name, kind, path: `/m/${name}.mp4`, duration: 5, width: 1920, height: 1080, fps: 30, hasAudio: true } as MediaAsset);
  const beach = asset("a", "IMG_0001"), dog = asset("b", "Rex at home"), song = asset("c", "Song", "audio");

  it("plain words match names or tags, the last word as it's typed", () => {
    useScenes.setState({ tags: { a: tags("beach", "water body"), b: tags("dog", "animal") } });
    expect(matches(beach, parseSearch("beach"))).toBe(true);
    expect(matches(beach, parseSearch("bea"))).toBe(true);
    expect(matches(dog, parseSearch("beach"))).toBe(false);
    expect(matches(dog, parseSearch("rex puppy"))).toBe(true);
    expect(matches(dog, parseSearch("rex"))).toBe(true);
    expect(matches(song, parseSearch("beach"))).toBe(false);
    // What matched, for words not in the name.
    expect(showsMatch(beach, parseSearch("water"))).toEqual(["water body"]);
    expect(showsMatch(dog, parseSearch("rex"))).toBeUndefined();
    expect(showsMatch(dog, parseSearch("rex puppy"))).toEqual(["dog"]);
  });

  it("offers to look at pictures only for words no picture is named", () => {
    expect(looksForPictures([beach, dog, song], parseSearch("sunset"))).toBe(true);
    expect(looksForPictures([beach, dog, song], parseSearch("rex"))).toBe(false);
    expect(looksForPictures([song], parseSearch("sunset"))).toBe(false);
    expect(looksForPictures([beach], parseSearch("\"what they say\""))).toBe(false);
  });
});
