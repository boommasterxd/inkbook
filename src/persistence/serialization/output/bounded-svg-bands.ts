import { deriveRenderBands } from "../../../domain/commands/render-bands";
import {
  FILE_SCHEMA_LIMITS,
  type InkElementV1,
  type InkSnapshotV1,
} from "../../../domain/schema/public";
import type { StaticSvgBands } from "../../documents/svg-envelope";
import { serializeBackgroundPaths } from "./background";
import { EncodedByteBudget, encodedByteLength } from "./encoded-byte-budget";
import { ChunkedOutputLimitError } from "./chunked-output-assembler";
import { serializeElementPaths } from "./path-markup";

/** Stop public synchronous exports before generated paths exceed file capacity. */
export function boundedSvgBands(snapshot: InkSnapshotV1, lockedHeight: number): StaticSvgBands {
  const bands = deriveRenderBands(snapshot.elements);
  const budget = new EncodedByteBudget(FILE_SCHEMA_LIMITS.totalInputBytes);
  const paths = (element: InkElementV1): string[] => {
    const fragments = serializeElementPaths(element);
    for (const fragment of fragments)
      if (!budget.tryReserve(encodedByteLength(fragment))) throw new ChunkedOutputLimitError();
    return fragments;
  };
  return {
    background: serializeBackgroundPaths(snapshot.page.background, lockedHeight),
    images: bands.image.flatMap(paths),
    highlights: bands.highlight.flatMap(paths),
    content: bands.content.flatMap(paths),
  };
}
