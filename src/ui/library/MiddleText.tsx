// Text truncated in the middle ("helic…ter-2"), as macOS does for file names (`.truncationMode(.middle)`).
// CSS only ellipsises the end, so the visible string is fitted by measuring with the element's font.

import { useLayoutEffect, useRef, useState } from "react";

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 6;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

export function fitMiddle(text: string, width: number, font: string): string {
  if (width <= 0 || measure(text, font) <= width) return text;
  let lo = 0, hi = text.length;
  // Largest number of kept characters that fits with an ellipsis between the two halves.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const head = Math.ceil(mid / 2), tail = mid - head;
    const s = text.slice(0, head) + "…" + (tail ? text.slice(-tail) : "");
    if (measure(s, font) <= width) lo = mid; else hi = mid - 1;
  }
  const head = Math.ceil(lo / 2), tail = lo - head;
  return text.slice(0, head) + "…" + (tail ? text.slice(-tail) : "");
}

export function MiddleText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      setShown(fitMiddle(text, el.clientWidth, `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return <div ref={ref} className={className} style={{ whiteSpace: "nowrap", overflow: "hidden" }}>{shown}</div>;
}
