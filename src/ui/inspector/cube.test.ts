import { describe, expect, it } from "vitest";
import { isReadableCube, lookLabel } from "./cube";

const cube = (size: number, rows = size ** 3) =>
  [`# made by a test`, `TITLE "t"`, `LUT_3D_SIZE ${size}`, ...Array.from({ length: rows }, () => "0.1 0.2 0.3")].join("\n");

describe("isReadableCube", () => {
  it("accepts a 3D LUT with size³ rows", () => {
    expect(isReadableCube(cube(2))).toBe(true);
    expect(isReadableCube(cube(17).replace(/\n/g, "\r\n"))).toBe(true);
  });
  it("rejects a wrong row count, a 1D LUT, or no size", () => {
    expect(isReadableCube(cube(2, 7))).toBe(false);
    expect(isReadableCube("LUT_1D_SIZE 4\n0 0 0\n1 1 1")).toBe(false);
    expect(isReadableCube("0 0 0\n1 1 1")).toBe(false);
    expect(isReadableCube(cube(1))).toBe(false);
  });
});

describe("lookLabel", () => {
  it("names built-in looks and .cube files", () => {
    expect(lookLabel(undefined)).toBe("None");
    expect(lookLabel("Teal and orange")).toBe("Teal and orange");
    expect(lookLabel("Faded")).toBe("Faded");
    expect(lookLabel("/Users/me/LUTs/Kodak 2383.cube")).toBe("Kodak 2383");
    expect(lookLabel("C:\\LUTs\\film.cube")).toBe("film");
  });
});
