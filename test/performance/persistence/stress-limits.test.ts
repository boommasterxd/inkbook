import { describe, expect, it } from "vitest";

import { deriveRenderBands } from "../../../src/domain/commands/render-bands";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { FILE_SCHEMA_LIMITS, validateInkSnapshotV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { createStressLimitFixture, STRESS_POINTS, STRESS_STROKES } from "./fixtures";

const EXPECTED_METADATA_BYTES = 23_776_562;
const EXPECTED_STATIC_MARKUP_BYTES = 41_996_104;
const EXPECTED_TOTAL_BYTES = 65_772_730;
const EXPECTED_BYTES_PER_STROKE_POINT = 32.886_365;
const EXPECTED_HASH = "e64374f68bc396504b7ad86b554d43352ba8838b2265e39025d7d8c44c648d37";

describe("combined persistence stress limits", () => {
  it("validates exactly 15,000 strokes and 2,000,000 points at the schema limits", async ({
    annotate,
  }) => {
    const snapshot = createStressLimitFixture();
    const metadataBytes = byteLength(JSON.stringify(snapshot));
    const validation = validateInkSnapshotV1(snapshot, {
      metadataBytes,
      totalInputBytes: metadataBytes,
    });

    if (!validation.ok) throw new Error(validation.error.message);
    expect(validation.ok).toBe(true);
    expect(validation.statistics).toMatchObject({
      elements: STRESS_STROKES,
      strokePoints: FILE_SCHEMA_LIMITS.strokePoints,
      strokes: FILE_SCHEMA_LIMITS.strokes,
    });
    expect(STRESS_STROKES).toBe(FILE_SCHEMA_LIMITS.strokes);
    expect(STRESS_POINTS).toBe(FILE_SCHEMA_LIMITS.strokePoints);
    expect(snapshot.elements).toHaveLength(STRESS_STROKES);
    expect(metadataBytes).toBeLessThanOrEqual(FILE_SCHEMA_LIMITS.metadataBytes);
    await annotate(
      `stress validation: ` +
        `strokes=${STRESS_STROKES}, points=${STRESS_POINTS}, inputBytes=${metadataBytes}`,
      "performance",
    );
  }, 120_000);

  it("prepares the complete stress fixture for indexed and banded rendering", async ({
    annotate,
  }) => {
    const snapshot = createStressLimitFixture();
    const preparation = (() => {
      const bands = deriveRenderBands(snapshot.elements);
      const store = new ElementStore(snapshot.elements);
      const firstPath = buildElementPathParts(snapshot.elements[0]!);
      const lastPath = buildElementPathParts(snapshot.elements[STRESS_STROKES - 1]!);
      return { bands, firstPath, lastPath, store };
    })();

    expect(preparation.store.size).toBe(STRESS_STROKES);
    expect(preparation.bands.highlight).toHaveLength(STRESS_STROKES / 2);
    expect(preparation.bands.content).toHaveLength(STRESS_STROKES / 2);
    expect(preparation.firstPath).toHaveLength(1);
    expect(preparation.lastPath).toHaveLength(1);
    await annotate(
      `stress render preparation: ` +
        `indexed=${preparation.store.size}, ` +
        `highlight=${preparation.bands.highlight.length}, ` +
        `content=${preparation.bands.content.length}`,
      "performance",
    );
  }, 120_000);

  it("serializes the exact combined stress limits within file-size ceilings", async ({
    annotate,
  }) => {
    const snapshot = createStressLimitFixture();
    const serialized = serializeInkbookDocument(snapshot);

    if (!serialized.ok) {
      throw new Error(
        `${serialized.error.code}: ${serialized.error.validationError?.path ?? "output"}: ` +
          serialized.error.message,
      );
    }
    expect(serialized.ok).toBe(true);
    const { hash, metadataBytes, svg, totalBytes } = serialized.value;
    const staticMarkupBytes = byteLength(svg.replace(/<metadata[^>]*>[\s\S]*?<\/metadata>/u, ""));
    const bytesPerStrokePoint = totalBytes / STRESS_POINTS;
    expect(metadataBytes).toBe(EXPECTED_METADATA_BYTES);
    expect(staticMarkupBytes).toBe(EXPECTED_STATIC_MARKUP_BYTES);
    expect(totalBytes).toBe(EXPECTED_TOTAL_BYTES);
    expect(bytesPerStrokePoint).toBe(EXPECTED_BYTES_PER_STROKE_POINT);
    expect(hash).toBe(EXPECTED_HASH);
    expect(metadataBytes).toBeLessThanOrEqual(FILE_SCHEMA_LIMITS.metadataBytes);
    expect(totalBytes).toBeLessThanOrEqual(FILE_SCHEMA_LIMITS.totalInputBytes);
    await annotate(
      `stress serialization: ` +
        `total=${totalBytes} bytes, metadata=${metadataBytes} bytes, ` +
        `static=${staticMarkupBytes} bytes, ` +
        `bytesPerStrokePoint=${bytesPerStrokePoint.toFixed(7)}, hash=${hash}`,
      "performance",
    );
  }, 120_000);
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
