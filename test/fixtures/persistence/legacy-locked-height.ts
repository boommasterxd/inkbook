import { deriveRenderBands } from "../../../src/domain/commands/render-bands";
import {
  calculateElementBounds,
  deriveLegacyLockedHeight,
} from "../../../src/domain/geometry/public";
import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { serializeSvgEnvelope } from "../../../src/persistence/documents/svg-envelope";
import { serializeSvgNumber } from "../../../src/persistence/documents/svg-number";
import { serializeBackgroundPaths } from "../../../src/persistence/serialization/background";
import { canonicalSnapshot } from "../../../src/persistence/serialization/canonical-snapshot";
import { serializeElementPaths } from "../../../src/persistence/serialization/path-markup";

export function serializeLegacyLockedHeightDocument(snapshot: InkSnapshotV1): string {
  const canonical = canonicalSnapshot(snapshot);
  const maximumBottom = canonical.elements.reduce<number | null>(
    (maximum, element) => Math.max(maximum ?? 0, calculateElementBounds(element).maxY),
    null,
  );
  const lockedHeight = Number(
    serializeSvgNumber(deriveLegacyLockedHeight(canonical.page, maximumBottom)),
  );
  const bands = deriveRenderBands(canonical.elements);
  return serializeSvgEnvelope(canonical, lockedHeight, {
    background: serializeBackgroundPaths(canonical.page.background, lockedHeight),
    highlights: bands.highlight.flatMap(serializeElementPaths),
    content: bands.content.flatMap(serializeElementPaths),
  });
}
