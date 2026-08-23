import { roundCanonical } from "./primitives";

export interface CenteredGuideAxis {
  readonly end: number;
  readonly intervalCount: number;
  readonly start: number;
}

export function centeredGuideAxis(
  availableStart: number,
  availableLength: number,
  spacing: number,
): CenteredGuideAxis {
  const boundedLength = Math.max(0, availableLength);
  const intervalCount = Math.max(0, Math.floor(boundedLength / spacing));
  const coveredLength = intervalCount * spacing;
  const start = roundCanonical(availableStart + (boundedLength - coveredLength) / 2);
  return {
    end: roundCanonical(start + coveredLength),
    intervalCount,
    start,
  };
}
