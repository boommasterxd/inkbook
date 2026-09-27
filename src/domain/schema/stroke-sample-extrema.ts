import type { PointV1 } from "./types";

export interface StrokeSampleExtrema {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

// Weak keys follow exclusively owned sample lifetimes; no document or sample buffer is retained.
const extremaBySamples = new WeakMap<object, StrokeSampleExtrema>();

export function retainValidatedSampleExtrema(samples: object, extrema: StrokeSampleExtrema): void {
  extremaBySamples.set(samples, Object.freeze(extrema));
}

export function copyValidatedSampleExtrema(source: object, target: object): void {
  const extrema = extremaBySamples.get(source);
  if (extrema !== undefined) extremaBySamples.set(target, extrema);
}

export function sampleOffsetWithinRange(
  samples: object,
  offset: PointV1 | undefined,
  maximum: number,
): boolean {
  const bounds = extremaBySamples.get(samples);
  if (bounds === undefined) return false;
  const x = offset?.x ?? 0;
  const y = offset?.y ?? 0;
  return (
    bounds.minX + x >= -maximum &&
    bounds.maxX + x <= maximum &&
    bounds.minY + y >= -maximum &&
    bounds.maxY + y <= maximum
  );
}

export function validatedSampleExtrema(samples: object): StrokeSampleExtrema | undefined {
  return extremaBySamples.get(samples);
}
