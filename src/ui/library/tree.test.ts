import { describe, expect, it } from "vitest";
import { contains, MediaTree, nameOf, parentOf } from "./tree";

const asset = (id: string, path: string) => ({ id, path });

const project = {
  folders: [{ id: "F1", path: "/m/Shoot" }, { id: "F2", path: "/m/Audio" }],
  assets: [
    asset("a", "/m/Shoot/a.mov"),
    asset("b", "/m/Shoot/Drone/b.mov"),
    asset("c", "/m/Shoot/Drone/Low/c.mov"),
    asset("d", "/m/Shoot/clip 10.mov"),
    asset("e", "/m/Shoot/Clip 2/e.mov"),
    asset("s", "/m/Audio/song.mp3"),
    asset("x", "/elsewhere/x.mov"),
  ],
};

describe("MediaTree", () => {
  const t = new MediaTree(project as never);

  it("puts linked folders at the top, in name order, beside loose items", () => {
    expect(t.foldersIn(null)).toEqual(["/m/Audio", "/m/Shoot"]);
    expect(t.assetsIn(null, project.assets).map((a) => a.id)).toEqual(["x"]);
  });

  it("works out the folders inside from where files are", () => {
    expect(t.foldersIn("/m/Shoot")).toEqual(["/m/Shoot/Clip 2", "/m/Shoot/Drone"]);
    expect(t.foldersIn("/m/Shoot/Drone")).toEqual(["/m/Shoot/Drone/Low"]);
    expect(t.assetsIn("/m/Shoot", project.assets).map((a) => a.id)).toEqual(["a", "d"]);
    expect(t.assetsUnder("/m/Shoot/Drone", project.assets).map((a) => a.id)).toEqual(["b", "c"]);
    expect(t.countUnder("/m/Shoot")).toBe(5);
    expect(t.folderOf({ id: "c" })).toBe("/m/Shoot/Drone/Low");
    expect(t.folderOf({ id: "x" })).toBeNull();
  });

  it("names folders, the way down, and the way back", () => {
    expect(t.label("/m/Shoot/Drone/Low")).toBe("Shoot / Drone / Low");
    expect(t.trail("/m/Shoot/Drone/Low")).toEqual(["/m/Shoot", "/m/Shoot/Drone", "/m/Shoot/Drone/Low"]);
    expect(t.up("/m/Shoot/Drone")).toBe("/m/Shoot");
    expect(t.up("/m/Shoot")).toBeNull();
    expect(t.exists("/m/Shoot/Drone")).toBe(true);
    expect(t.exists("/m/Shoot/Gone")).toBe(false);
    expect(t.nearest("/m/Shoot/Gone/Deeper")).toBe("/m/Shoot");
    expect(t.nearest("/nowhere")).toBeNull();
  });

  it("handles Windows paths", () => {
    const w = new MediaTree({
      folders: [{ id: "F", path: "C:\\Media\\Shoot" }],
      assets: [asset("a", "C:\\Media\\Shoot\\Day 1\\a.mov"), asset("b", "C:\\Media\\Shoot\\b.mov")],
    } as never);
    expect(w.foldersIn("C:\\Media\\Shoot")).toEqual(["C:\\Media\\Shoot\\Day 1"]);
    expect(w.trail("C:\\Media\\Shoot\\Day 1")).toEqual(["C:\\Media\\Shoot", "C:\\Media\\Shoot\\Day 1"]);
    expect(contains("C:\\Media\\Shoot", "C:\\Media\\Shoot\\b.mov")).toBe(true);
    expect(contains("C:\\Media\\Sho", "C:\\Media\\Shoot\\b.mov")).toBe(false);
    expect(parentOf("C:\\Media\\Shoot\\b.mov")).toBe("C:\\Media\\Shoot");
    expect(nameOf("C:\\Media\\Shoot\\")).toBe("Shoot");
  });
});
