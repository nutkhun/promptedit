import { useRef } from "react";
import { gesture, type Gesture, type GestureSpec } from "./live";

/**
 * A gesture that stays the same object across renders (a drag outlives many re-renders as the
 * project updates) while always using the latest render's spec.
 */
export function useGesture<T, O = void>(spec: GestureSpec<T, O>): Gesture<T> {
  const latest = useRef(spec);
  latest.current = spec;
  const g = useRef<Gesture<T> | null>(null);
  if (!g.current) g.current = gesture(() => latest.current);
  return g.current;
}
