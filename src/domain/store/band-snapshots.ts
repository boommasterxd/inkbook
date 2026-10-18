import type { RenderBand } from "../commands/render-bands";

export type StoreBands = Record<RenderBand, readonly string[]>;
const retainedSnapshots = new WeakSet<readonly string[]>();

/** Only Store-owned arrays cross this ownership boundary. Writers must use mutableBand. */
export function retainBandSnapshot(ids: readonly string[]): readonly string[] {
  if (!retainedSnapshots.has(ids)) {
    Object.freeze(ids);
    retainedSnapshots.add(ids);
  }
  return ids;
}

/** Synchronous Store writers copy a retained snapshot before changing its order. */
export function mutableBand(bands: StoreBands, band: RenderBand): string[] {
  const ids = bands[band];
  if (retainedSnapshots.has(ids) || Object.isFrozen(ids)) {
    const copy = [...ids];
    bands[band] = copy;
    return copy;
  }
  return ids as string[];
}
