// The grade maths against values worked out independently from Editroom's ColorGrade.swift formulas
// (GradeRecipe.apply, LookMath, WheelPoint.offset, GradeBaker), so a port slip shows up here.

import { describe, expect, test } from "vitest";
import type { ColorGrade } from "../model";
import { applyRecipe, bakeCube, builtInLook, CUBE_SIZE, gradeColor, isNeutral, lookLabel, parseCube, sampleCube, wheelOffset, type RGB } from "./grade";

const grade = (g: Partial<ColorGrade>): ColorGrade => ({
  lookIntensity: 1, exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
  shadows: { x: 0, y: 0 }, midtones: { x: 0, y: 0 }, highlights: { x: 0, y: 0 }, ...g,
});
const near = (a: RGB, b: RGB, eps = 1e-9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));
const look = (name: string, c: RGB) => applyRecipe(builtInLook(name)!, c);

describe("GradeRecipe", () => {
  test("Warm film on mid grey, step by step", () => {
    // temperature 18 → ±0.0432; lift (0.02, 0, −0.02); contrast k = 1.096; fade 0.03; saturation × 0.92
    // r: 0.5432 → 0.5632 → 0.5692672 → 0.58218918; luma after fade 0.52443336 → 0.52443336 + 0.05775582·0.92
    near(look("Warm film", [0.5, 0.5, 0.5]), [0.577568718194688, 0.515754668914688, 0.453940619634688]);
  });
  test("Warm film on black is not clamped until the bake", () => {
    near(look("Warm film", [0, 0, 0]), [0.046008718194688, -0.015805331085312, -0.077619380365312]);
  });
  test("Mono: contrast 14 then saturation −100", () => {
    // (1,0,0): k = 1.168 → (1.084, −0.084, −0.084); luma = 0.2126·1.084 − 0.7874·0.084 = 0.1643168
    near(look("Mono", [1, 0, 0]), [0.1643168, 0.1643168, 0.1643168]);
  });
  test("user grade with every control and the three wheels", () => {
    const g = grade({
      exposure: 0.5, contrast: -20, saturation: 30, temperature: -10, tint: 15,
      shadows: { x: 0.5, y: -0.5 }, midtones: { x: -0.3, y: 0.2 }, highlights: { x: 0, y: 1 },
    });
    near(gradeColor(g, [0.3, 0.5, 0.7]), [0.3289254831933043, 0.7559399124510734, 0.8449352091042419]);
  });
});

describe("wheels", () => {
  test("red at 0°, green at 120°, blue at 240°, radius 0.22", () => {
    near(wheelOffset({ x: 1, y: 0 }), [0.22, -0.11, -0.11]);
    near(wheelOffset({ x: 0.5, y: -0.5 }), [0.11, -0.15026279441628823, 0.040262794416288286]);
    near(wheelOffset({ x: 3, y: 4 }), wheelOffset({ x: 0.6, y: 0.8 })); // clamped to the unit circle
    expect(wheelOffset({ x: 0, y: 0 })).toEqual([0, 0, 0]);
  });
});

describe("LookMath", () => {
  test("Golden hour", () => near(look("Golden hour", [0.5, 0.5, 0.5]), [0.5203783750395656, 0.5107573301313657, 0.49034582153136563]));
  test("Film print (skin and blue bands)", () => {
    near(look("Film print", [0.8, 0.6, 0.45]), [0.8671406669431857, 0.7123130363063236, 0.5421414301449462]);
    near(look("Film print", [0.2, 0.35, 0.7]), [0.2525259240922158, 0.3948368225153487, 0.6994795597452981]);
  });
  test("Bleach bypass", () => near(look("Bleach bypass", [0.8, 0.3, 0.2]), [0.5852863804395916, 0.3024670438024828, 0.25651916945195713]));
  test("Pastel", () => near(look("Pastel", [0.1, 0.5, 0.9]), [0.3882207529038185, 0.6041908969818117, 0.8390361075564647]));
  test("the retired Faded look still renders", () => expect(builtInLook("Faded")).toBeDefined());
});

describe("bake", () => {
  const at = (cube: Float32Array, r: number, g: number, b: number) => {
    const i = ((b * CUBE_SIZE + g) * CUBE_SIZE + r) * 4;
    return [cube[i], cube[i + 1], cube[i + 2], cube[i + 3]];
  };
  test("neutral grades bake to nothing; intensity alone doesn't count", () => {
    expect(bakeCube(grade({}))).toBeUndefined();
    expect(isNeutral(grade({ lookIntensity: 0.3 }))).toBe(true);
    expect(isNeutral(grade({ look: "Mono" }))).toBe(false);
  });
  test("red fastest, clamped, alpha 1", () => {
    const cube = bakeCube(grade({ look: "Mono" }))!;
    expect(cube.length).toBe(32 ** 3 * 4);
    const red = at(cube, 31, 0, 0);
    expect(red[0]).toBeCloseTo(0.1643168, 6);
    expect(red[3]).toBe(1);
    // Exposure +1 doubles, then clamps at 1.
    const ex = bakeCube(grade({ exposure: 1 }))!;
    expect(at(ex, 10, 20, 31)[0]).toBeCloseTo((10 / 31) * 2, 6);
    expect(at(ex, 10, 20, 31)[2]).toBe(1);
  });
  test("look intensity blends linearly toward the look, before the user grade", () => {
    // Warm film at black at 50 %: (0.04600872, −0.01580533, −0.07761938) / 2, then clamped.
    const cube = bakeCube(grade({ look: "Warm film", lookIntensity: 0.5 }))!;
    const black = at(cube, 0, 0, 0);
    expect(black[0]).toBeCloseTo(0.023004359, 7);
    expect(black[1]).toBe(0);
    expect(black[2]).toBe(0);
  });
});

describe(".cube files", () => {
  const invert = `# comment\nTITLE "x"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n`;
  test("parses Editroom's way (space separated, red fastest) and samples trilinearly", () => {
    const lut = parseCube(invert)!;
    expect(lut.size).toBe(2);
    near(sampleCube(lut, [0.25, 0.5, 1]), [0.75, 0.5, 0]);
    near(sampleCube(lut, [-1, 2, 0.5]), [1, 0, 0.5]); // inputs clamped
  });
  test("rejects wrong counts and tab-separated data", () => {
    expect(parseCube("LUT_3D_SIZE 2\n0 0 0\n")).toBeUndefined();
    expect(parseCube(invert.replace(/ /g, "\t"))).toBeUndefined();
  });
  test("a .cube look at 50 % is sampled at the bake lattice", () => {
    const lut = parseCube(invert)!;
    const cube = bakeCube(grade({ look: "/luts/invert.cube", lookIntensity: 0.5 }), lut)!;
    for (let i = 0; i < cube.length; i += 4) expect(cube[i]).toBeCloseTo(0.5, 6);
  });
  test("labels", () => {
    expect(lookLabel(undefined)).toBe("None");
    expect(lookLabel("Mono")).toBe("Mono");
    expect(lookLabel("/Users/me/LUTs/Kodak 2383.cube")).toBe("Kodak 2383");
    expect(lookLabel("C:\\LUTs\\Teal.cube")).toBe("Teal");
  });
});
