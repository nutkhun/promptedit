// Scale, position and the zoom move of pictures (docs/spec/04-ui.md §1.5 Transform; docs/spec/01-model.md
// §2.9–2.10, §3.20). Live edits on every selected transformable clip; identity clears the transform.

import { useRef } from "react";
import type { Clip, ClipTransform, Id, ZoomMove } from "../../model";
import { store, useStore } from "../../store";
import { clamp, zoomAmount, zoomedOffset } from "../../timing";
import { InspectorSection, ParamRow, RampButton } from "../controls";
import { clipsNow, IDENTITY, isIdentity, transformEdits, update } from "./edits";
import { setZoomMoveMode, zoomMoveMode } from "./prefs";
import { zoomedTime, zoomStarter } from "./shapes";
import { useGesture } from "./useGesture";
import { percentTenths, tenths } from "./values";
import { ZoomGraph } from "./ZoomGraph";

const fills = (t: ClipTransform) => t.scale > 1.001;

/** Puts the playhead where a zooming clip is all the way in (unless it's there already, or playing). */
function showZoomed(id: Id) {
  const s = store();
  const c = s.project.clips.find((x) => x.id === id);
  const z = c?.transform?.zoom;
  if (!c || !z || s.playing) return;
  const u = s.playhead - c.start;
  if (u >= 0 && u < c.duration && zoomAmount(z, u) > 0.999) return;
  s.seek(c.start + zoomedTime(z, c.duration));
}

export function TransformSection({ clips }: { clips: Clip[] }) {
  const w = useStore((s) => s.project.width), h = useStore((s) => s.project.height);
  const fps = useStore((s) => s.project.fps);
  const edit = useStore((s) => s.edit);
  const ids = clips.map((c) => c.id);
  const single = clips.length === 1 ? clips[0] : undefined;
  const tf = clips[0].transform ?? IDENTITY;
  const zoomPlayhead = useRef<number | undefined>(undefined);

  const onBegin = () => { if (single) showZoomed(single.id); };
  const capture = () => clipsNow(ids);
  const scale = useGesture<number, Clip[]>({
    capture,
    onBegin,
    make: (v, origin) => transformEdits(origin, (t) => {
      t.scale = clamp(Math.round(v * 10) / 1000, 0.05, 10);
      if (fills(t)) [t.x, t.y] = zoomedOffset(t);
      return t;
    }),
  });

  // Bigger than the frame: X and Y say where it frames (right and down positive), only as far as the
  // picture reaches; the picture itself moves the other way. Otherwise: where the picture sits.
  const m = Math.max(0, tf.scale - 1) / 2;
  const reach = (1 + tf.scale) / 2;
  const [ax, ay] = zoomedOffset(tf);
  const xRow = useGesture<number, Clip[]>({
    capture,
    onBegin,
    make: (v, origin) => transformEdits(origin, (t) => {
      t.x = fills(tf) ? -clamp(Math.round(v * 10) / 10 / w, -m, m) : Math.round(v * 10) / 10 / w;
      return t;
    }),
  });
  const yRow = useGesture<number, Clip[]>({
    capture,
    onBegin,
    make: (v, origin) => transformEdits(origin, (t) => {
      t.y = fills(tf) ? -clamp(Math.round(v * 10) / 10 / h, -m, m) : Math.round(v * 10) / 10 / h;
      return t;
    }),
  });

  const zoomDrag = useGesture<{ zoom: ZoomMove; scale: number; focus?: number }, Clip[]>({
    capture,
    make: ({ zoom, scale: s }, origin) => transformEdits(origin, (t) => {
      t.zoom = zoom;
      t.scale = s;
      [t.x, t.y] = zoomedOffset(t);
      return t;
    }),
    after: ({ focus }) => {
      if (focus === undefined || !single || store().playing) return;
      zoomPlayhead.current ??= store().playhead;
      store().seek(single.start + focus);
    },
    onBegin: () => { zoomPlayhead.current = undefined; },
    onEnd: () => {
      if (zoomPlayhead.current !== undefined) store().seek(zoomPlayhead.current);
      zoomPlayhead.current = undefined;
    },
  });

  const reset = () => void edit(update(ids, { transform: IDENTITY }));

  /** Zoom on: a starter move to this scale (200% if it's at 100%). Off: the move goes. */
  const toggleZoom = async () => {
    if (!single) return;
    const t: ClipTransform = { ...(single.transform ?? IDENTITY) };
    if (t.zoom) {
      delete t.zoom;
      await edit(update([single.id], { transform: t }));
      return;
    }
    if (t.scale <= 1.01) t.scale = 2;
    t.zoom = zoomStarter(zoomMoveMode(), single.duration);
    await edit(update([single.id], { transform: t }));
    showZoomed(single.id);
  };

  const setZoom = (z: ZoomMove) => {
    if (!single) return;
    setZoomMoveMode(z.mode);
    const t = single.transform ?? IDENTITY;
    void edit(update([single.id], { transform: { ...t, zoom: z } }));
  };

  const identity = isIdentity(clips[0].transform);
  return (
    <InspectorSection title="Transform" collapsedByDefault marked={!identity}
      action={identity ? undefined : { label: "Reset", onClick: reset }}>
      <ParamRow
        icon="arrow.up.left.and.arrow.down.right"
        label="Scale"
        value={tf.scale * 100}
        range={[5, 1000]}
        log
        step={1}
        format={percentTenths}
        live={scale}
        inside={single && (
          <RampButton
            on={!!tf.zoom}
            onClick={() => void toggleZoom()}
            title={tf.zoom ? "Remove the zoom" : "Zoom: move between the full frame and this scale over the clip"}
          />
        )}
      />
      {single && tf.zoom && (
        <ZoomGraph
          key={single.id}
          clip={single}
          zoom={tf.zoom}
          scale={tf.scale}
          fps={fps}
          onEditing={(began) => (began ? zoomDrag.begin() : zoomDrag.end())}
          onChange={(zoom, s, focus) => zoomDrag.change({ zoom, scale: s, focus })}
          onSet={setZoom}
        />
      )}
      {fills(tf) ? (
        <>
          <ParamRow icon="arrow.left.and.right" label="X" value={-ax * w} range={[-m * w, Math.max(m * w, 0.001)]}
            step={1} format={tenths} live={xRow} />
          <ParamRow icon="arrow.up.and.down" label="Y" value={-ay * h} range={[-m * h, Math.max(m * h, 0.001)]}
            step={1} format={tenths} live={yRow} />
        </>
      ) : (
        <>
          <ParamRow icon="arrow.left.and.right" label="X" value={tf.x * w} range={[-reach * w, reach * w]}
            step={1} format={tenths} live={xRow} />
          <ParamRow icon="arrow.up.and.down" label="Y" value={tf.y * h} range={[-reach * h, reach * h]}
            step={1} format={tenths} live={yRow} />
        </>
      )}
    </InspectorSection>
  );
}
