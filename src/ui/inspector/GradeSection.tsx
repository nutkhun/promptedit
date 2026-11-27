// Colour grade of visual clips (docs/spec/04-ui.md §1.5 Grade; docs/spec/01-model.md §2.12, §3.20):
// three tint wheels, the sliders, and a look (built in or a .cube LUT) with its intensity. Live
// edits on every selected visual clip (each keeps its own other settings); neutral clears the
// grade. Look choice and Reset are one step each.

import type { Clip, ColorGrade, WheelPoint } from "../../model";
import { DEFAULT_GRADE } from "../../model";
import { store } from "../../store";
import { ColourWheel, InspectorSection, MenuField, ParamRow, RowIcon, type MenuItem } from "../controls";
import { BUILT_IN_LOOKS, checkCube, chooseCubeFile, fileName, lookLabel } from "./cube";
import { clipsNow, gradeEdits, isNeutral } from "./edits";
import { applyAsOneStep } from "./live";
import { useGesture } from "./useGesture";
import { percent, signed2, whole } from "./values";

type Wheel = "shadows" | "midtones" | "highlights";
type Slider = "exposure" | "contrast" | "saturation" | "temperature" | "tint" | "lookIntensity";

export function GradeSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id);
  const grade = clips[0].grade ?? DEFAULT_GRADE;
  const capture = () => clipsNow(ids);
  const once = (body: (g: ColorGrade) => ColorGrade) => void applyAsOneStep(gradeEdits(clipsNow(ids), body));

  // Hooks: called the same number of times, in the same order, on every render.
  const wheel = (key: Wheel) =>
    useGesture<WheelPoint, Clip[]>({ capture, make: (pt, origin) => gradeEdits(origin, (g) => ({ ...g, [key]: pt })) });
  const slider = (key: Slider, round: (v: number) => number) =>
    useGesture<number, Clip[]>({ capture, make: (v, origin) => gradeEdits(origin, (g) => ({ ...g, [key]: round(v) })) });

  const shadows = wheel("shadows"), midtones = wheel("midtones"), highlights = wheel("highlights");
  const exposure = slider("exposure", (v) => Math.round(v * 100) / 100);
  const contrast = slider("contrast", Math.round);
  const saturation = slider("saturation", Math.round);
  const temperature = slider("temperature", Math.round);
  const tint = slider("tint", Math.round);
  const intensity = slider("lookIntensity", (v) => Math.round(v) / 100);

  const setLook = (look: string | undefined) =>
    // Removing the look puts its intensity back to 100% for next time.
    once((g) => (look ? { ...g, look } : { ...g, look: undefined, lookIntensity: 1 }));
  const loadCube = async () => {
    const path = await chooseCubeFile();
    if (!path) return;
    if (!(await checkCube(path))) {
      store().set({ error: `“${fileName(path)}” isn't a 3D .cube LUT this app can read.` });
      return;
    }
    setLook(path);
  };
  const looks: MenuItem[] = [
    { label: "None", onSelect: () => setLook(undefined) },
    "divider",
    ...BUILT_IN_LOOKS.map((name): MenuItem => ({ label: name, onSelect: () => setLook(name) })),
    "divider",
    { label: "Load .cube…", onSelect: () => void loadCube() },
  ];

  const neutral = isNeutral(clips[0].grade);
  return (
    <InspectorSection title="Grade" collapsedByDefault marked={!neutral}
      action={neutral ? undefined : { label: "Reset", onClick: () => once(() => ({ ...DEFAULT_GRADE })) }}>
      <div style={{ display: "flex", alignItems: "flex-start", padding: "4px 0" }}>
        <ColourWheel title="Shadows" point={grade.shadows} live={shadows} />
        <ColourWheel title="Midtones" point={grade.midtones} live={midtones} />
        <ColourWheel title="Highlights" point={grade.highlights} live={highlights} />
      </div>
      <ParamRow icon="sun.max" label="Exposure" value={grade.exposure} range={[-2, 2]} format={signed2} live={exposure} />
      <ParamRow icon="circle.lefthalf.filled" label="Contrast" value={grade.contrast} range={[-50, 50]} format={whole} live={contrast} />
      <ParamRow icon="drop" label="Saturate" value={grade.saturation} range={[-100, 100]} format={whole} live={saturation} />
      <ParamRow icon="thermometer.medium" label="Temp" value={grade.temperature} range={[-50, 50]} format={whole} live={temperature} />
      <ParamRow icon="eyedropper" label="Tint" value={grade.tint} range={[-50, 50]} format={whole} live={tint} />
      <div className="ctl-row" data-param="Look">
        <RowIcon symbol="camera.filters" />
        <span className="ctl-row-label">Look</span>
        <MenuField label={lookLabel(grade.look)} items={looks} height={26} title={grade.look ?? undefined} />
      </div>
      {grade.look && (
        <ParamRow icon="circle.dotted" label="Intensity" value={grade.lookIntensity * 100} range={[0, 100]} format={percent} live={intensity} />
      )}
    </InspectorSection>
  );
}
