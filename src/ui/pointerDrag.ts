// Dragging media from the library to the timeline with pointer events instead of HTML5
// drag-and-drop. Tauri must keep its native file-drop handler on (that's how dropped files
// arrive with real paths), and on Windows WebView2 then disables HTML5 drag-and-drop inside
// the page, so in-app drags are done by hand: the same way on macOS and Windows.
//
// Targets mark themselves with `data-media-drop-target` and receive CustomEvents:
//   promptedit:media-drag  { x, y, payloads }   while over them
//   promptedit:media-leave {}                   when the pointer leaves them
//   promptedit:media-drop  { x, y, payloads }   on release over them
// (x, y are client coordinates.)

import type { Payload } from "../model";

export interface MediaDragDetail { x: number; y: number; payloads: Payload[] }

const THRESHOLD = 4;

export function beginMediaDrag(e: React.PointerEvent, payloads: () => Payload[], label: () => string) {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let started = false;
  let ghost: HTMLDivElement | undefined;
  let over: HTMLElement | null = null;
  let items: Payload[] = [];

  const targetAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-media-drop-target]") ?? null;

  const send = (el: HTMLElement | null, type: string, detail: Partial<MediaDragDetail> = {}) =>
    el?.dispatchEvent(new CustomEvent(type, { detail }));

  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      started = true;
      items = payloads();
      if (!items.length) return cleanup();
      ghost = document.createElement("div");
      ghost.className = "pe-drag-ghost";
      ghost.textContent = label();
      document.body.appendChild(ghost);
      document.body.style.cursor = "copy";
    }
    if (ghost) ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`;
    // The ghost must not be what elementFromPoint finds.
    const now = targetAt(ev.clientX, ev.clientY);
    if (now !== over) {
      send(over, "promptedit:media-leave");
      over = now;
    }
    send(over, "promptedit:media-drag", { x: ev.clientX, y: ev.clientY, payloads: items });
  };

  const up = (ev: PointerEvent) => {
    if (started && over) send(over, "promptedit:media-drop", { x: ev.clientX, y: ev.clientY, payloads: items });
    if (started) {
      // The click that ends a drag shouldn't also pick or open what's under it.
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    }
    cleanup();
  };

  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !started) return;
    ev.preventDefault();
    ev.stopPropagation();
    send(over, "promptedit:media-leave");
    cleanup();
  };

  function swallow(ev: MouseEvent) {
    ev.stopPropagation();
    ev.preventDefault();
  }

  function cleanup() {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    ghost?.remove();
    document.body.style.cursor = "";
  }

  function cancel() {
    send(over, "promptedit:media-leave");
    cleanup();
  }

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
