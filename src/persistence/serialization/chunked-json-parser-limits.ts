import type { ChunkedJsonLimits } from "./chunked-json-limits";

export function validateChunkedJsonLimits(limits: ChunkedJsonLimits): ChunkedJsonLimits {
  return {
    maximumDepth: nonNegativeSafeInteger(limits.maximumDepth, "maximumDepth"),
    maximumContainerEntries: nonNegativeSafeInteger(
      limits.maximumContainerEntries,
      "maximumContainerEntries",
    ),
    maximumNodes: positiveSafeInteger(limits.maximumNodes, "maximumNodes"),
    maximumOutputCharacters: nonNegativeSafeInteger(
      limits.maximumOutputCharacters,
      "maximumOutputCharacters",
    ),
    maximumStringScratchCharacters: positiveSafeInteger(
      limits.maximumStringScratchCharacters,
      "maximumStringScratchCharacters",
    ),
  };
}

export function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}
