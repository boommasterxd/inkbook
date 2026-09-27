import type { MutableSceneInstrumentation } from "./types";

interface VisibilityMarkers {
  readonly visible: Uint32Array<ArrayBuffer>;
  readonly bands: Uint8Array<ArrayBuffer>;
  readonly ranks: Float64Array<ArrayBuffer>;
}

/** Grows per-ID markers together so a recycled slot is valid in every buffer. */
export function growVisibilityMarkers(
  required: number,
  previous: VisibilityMarkers,
  instrumentation: MutableSceneInstrumentation,
): VisibilityMarkers {
  let capacity = Math.max(16, previous.visible.length || 1);
  while (capacity < required) capacity *= 2;
  const visible = new Uint32Array(capacity);
  const bands = new Uint8Array(capacity);
  const ranks = new Float64Array(capacity);
  visible.set(previous.visible);
  bands.set(previous.bands);
  ranks.set(previous.ranks);
  instrumentation.collectionAllocations += 1;
  return { visible, bands, ranks };
}

export function growVisibilityCapacity(
  required: number,
  current: number,
  instrumentation: MutableSceneInstrumentation,
): number {
  if (required <= current) return current;
  let capacity = Math.max(16, current || 1);
  while (capacity < required) capacity *= 2;
  instrumentation.collectionAllocations += 1;
  return capacity;
}
