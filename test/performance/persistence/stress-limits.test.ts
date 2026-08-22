import { describe, expect, it } from "vitest";

import { deriveRenderBands } from "../../../src/domain/commands/render-bands";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { FILE_SCHEMA_LIMITS, validateInkSnapshotV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { createStressLimitFixture, STRESS_POINTS, STRESS_STROKES } from "./fixtures";
import { measure } from "./metrics";

const EXPECTED_METADATA_BYTES = 23_776_586;
const EXPECTED_STATIC_MARKUP_BYTES = 41_996_051;
const EXPECTED_TOTAL_BYTES = 65_772_701;
const EXPECTED_BYTES_PER_STROKE_POINT = 32.886_350_5;
const EXPECTED_HASH = "5f04599b5111ba29f944bddbc74de4d40b5e48bdd958bf78cd6acddda8285900";

describe("combined persistence stress limits", () => {
  it("validates exactly 15,000 strokes and 2,000,000 points at the schema limits", async ({
    annotate,
  }) => {
    const snapshot = createStressLimitFixture();
    const metadataBytes = byteLength(JSON.stringify(snapshot));
    const validation = measure(() =>
      validateInkSnapshotV1(snapshot, { metadataBytes, totalInputBytes: metadataBytes }),
    );

    if (!validation.value.ok) throw new Error(validation.value.error.message);
    expect(validation.value.ok).toBe(true);
    expect(validation.value.statistics).toMatchObject({
      elements: STRESS_STROKES,
      strokePoints: FILE_SCHEMA_LIMITS.strokePoints,
      strokes: FILE_SCHEMA_LIMITS.strokes,
    });
    expect(STRESS_STROKES).toBe(FILE_SCHEMA_LIMITS.strokes);
    expect(STRESS_POINTS).toBe(FILE_SCHEMA_LIMITS.strokePoints);
    expect(snapshot.elements).toHaveLength(STRESS_STROKES);
    expect(metadataBytes).toBeLessThanOrEqual(FILE_SCHEMA_LIMITS.metadataBytes);
    await annotate(
      `stress validation: duration=${validation.durationMs.toFixed(3)} ms, ` +
        `strokes=${STRESS_STROKES}, points=${STRESS_POINTS}, inputBytes=${metadataBytes}`,
      "performance",
    );
  }, 120_000);

  it("prepares the complete stress fixture for indexed and banded rendering", async ({
    annotate,
  }) => {
    const snapshot = createStressLimitFixture();
    const preparation = measure(() => {
      const bands = deriveRenderBands(snapshot.elements);
      const store = new ElementStore(snapshot.elements);
      const firstPath = buildElementPathParts(snapshot.elements[0]!);
      const lastPath = buildElementPathParts(snapshot.elements[STRESS_STROKES - 1]!);
      return { bands, firstPath, lastPath, store };
    });

    expect(preparation.value.store.size).toBe(STRESS_STROKES);
    expect(preparation.value.bands.highlight).toHaveLength(STRESS_STROKES / 2);
    expect(preparation.value.bands.content).toHaveLength(STRESS_STROKES / 2);
    expect(preparation.value.firstPath).toHaveLength(1);
    expect(preparation.value.lastPath).toHaveLength(1);
    await annotate(
      `stress render preparation: duration=${preparation.durationMs.toFixed(3)} ms, ` +
        `indexed=${preparation.value.store.size}, ` +
        `highlight=${preparation.value.bands.highlight.length}, ` +
        `content=${preparation.value.bands.content.length}`,
      "performance",
    );
  }, 120_000);

  it("serializes the exact combined stress limits within file-size ceilings", async ({
    annotate,
  }) => {
    const snapshot = createStressLimitFixture();
    const serialized = measure(() => serializeInkbookDocument(snapshot));

    if (!serialized.value.ok) {
      throw new Error(
        `${serialized.value.error.code}: ${serialized.value.error.validationError?.path ?? "output"}: ` +
          serialized.value.error.message,
      );
    }
    expect(serialized.value.ok).toBe(true);
    const { hash, metadataBytes, svg, totalBytes } = serialized.value.value;
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
      `stress serialization: duration=${serialized.durationMs.toFixed(3)} ms, ` +
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
