import { deriveRenderBands } from "../../../src/domain/commands/render-bands";
import {
  calculateElementBounds,
  deriveLegacyLockedHeight,
  derivePreviousBackgroundAlignedLockedHeight,
} from "../../../src/domain/geometry/public";
import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { serializeSvgEnvelope } from "../../../src/persistence/documents/svg-envelope";
import { serializeSvgNumber } from "../../../src/persistence/documents/svg-number";
import {
  serializeBackgroundPaths,
  serializeLegacyCenteredBackgroundPaths,
  serializePreviousInsetBackgroundPaths,
  serializePreviousTopAnchoredBackgroundPaths,
} from "../../../src/persistence/serialization/background";
import { canonicalSnapshot } from "../../../src/persistence/serialization/canonical-snapshot";
import { serializeElementPaths } from "../../../src/persistence/serialization/path-markup";

export function serializeLegacyLockedHeightDocument(snapshot: InkSnapshotV1): string {
  const canonical = canonicalSnapshot(snapshot);
  const maximumBottom = maximumElementBottom(canonical);
  const lockedHeight = Number(
    serializeSvgNumber(deriveLegacyLockedHeight(canonical.page, maximumBottom)),
  );
  return serializeDocument(
    canonical,
    lockedHeight,
    serializeBackgroundPaths(canonical.page.background, lockedHeight),
  );
}

export function serializeLegacyCenteredBackgroundDocument(snapshot: InkSnapshotV1): string {
  const canonical = canonicalSnapshot(snapshot);
  const lockedHeight = previousBackgroundHeight(canonical);
  return serializeDocument(
    canonical,
    lockedHeight,
    serializeLegacyCenteredBackgroundPaths(canonical.page.background, lockedHeight),
  );
}

export function serializePreviousTopAnchoredBackgroundDocument(snapshot: InkSnapshotV1): string {
  const canonical = canonicalSnapshot(snapshot);
  const lockedHeight = previousBackgroundHeight(canonical);
  return serializeDocument(
    canonical,
    lockedHeight,
    serializePreviousTopAnchoredBackgroundPaths(canonical.page.background, lockedHeight),
  );
}

export function serializePreviousInsetBackgroundDocument(snapshot: InkSnapshotV1): string {
  const canonical = canonicalSnapshot(snapshot);
  const lockedHeight = previousBackgroundHeight(canonical);
  return serializeDocument(
    canonical,
    lockedHeight,
    serializePreviousInsetBackgroundPaths(canonical.page.background, lockedHeight),
  );
}

function previousBackgroundHeight(snapshot: InkSnapshotV1): number {
  return Number(
    serializeSvgNumber(
      derivePreviousBackgroundAlignedLockedHeight(snapshot.page, maximumElementBottom(snapshot)),
    ),
  );
}

function serializeDocument(
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  background: readonly string[],
): string {
  const bands = deriveRenderBands(snapshot.elements);
  return serializeSvgEnvelope(snapshot, lockedHeight, {
    background,
    highlights: bands.highlight.flatMap(serializeElementPaths),
    content: bands.content.flatMap(serializeElementPaths),
  });
}

function maximumElementBottom(snapshot: InkSnapshotV1): number | null {
  return snapshot.elements.reduce<number | null>(
    (maximum, element) => Math.max(maximum ?? 0, calculateElementBounds(element).maxY),
    null,
  );
}
