import { deriveRenderBands } from "../../../domain/commands/render-bands";
import type {
  InkElementV1,
  InkSnapshotV1,
  SnapshotValidationDerivations,
} from "../../../domain/schema/public";
import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";
import type { StaticSvgBands } from "../../documents/svg-envelope";
import { serializeBackgroundPaths } from "./background";
import { EncodedByteBudget, encodedByteLength } from "./encoded-byte-budget";
import { ChunkedOutputLimitError } from "./chunked-output-assembler";
import { serializeAutoElementPaths, serializeElementPaths } from "./path-markup";
import { AutoPaintServerRegistry } from "./auto-contrast-servers";

/** Stop public synchronous exports before tile expansion can exceed the file capacity. */
export function boundedSvgBands(
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  derivations: SnapshotValidationDerivations,
): StaticSvgBands {
  const bands = deriveRenderBands(snapshot.elements);
  const auto = snapshot.version >= 5 && bands.image.length > 0;
  const autoPaints = auto ? new AutoPaintServerRegistry() : undefined;
  const bounds = !auto
    ? undefined
    : new Map(derivations.elements.map((derived) => [derived.elementId, derived.bounds]));
  const budget = new EncodedByteBudget(FILE_SCHEMA_LIMITS.totalInputBytes);
  let serverBytes = 0;
  const paths = (element: InkElementV1) => {
    if (!auto) return serializeElementPaths(element);
    const chunks: string[] = [];
    const fragments = serializeAutoElementPaths(element, bounds?.get(element.id), autoPaints);
    for (const fragment of fragments) {
      const currentServerBytes = autoPaints?.contentByteLength ?? 0;
      if (!budget.tryReserve(encodedByteLength(fragment) + currentServerBytes - serverBytes))
        throw new ChunkedOutputLimitError();
      serverBytes = currentServerBytes;
      chunks.push(fragment);
    }
    return chunks;
  };
  return {
    autoPaints,
    underlayImages: bands.image.filter((element) => element.kind === "image"),
    background: serializeBackgroundPaths(snapshot.page.background, lockedHeight),
    images: bands.image.flatMap(paths),
    highlights: bands.highlight.flatMap(paths),
    content: bands.content.flatMap(paths),
  };
}
