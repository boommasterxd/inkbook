import { afterAll, describe, expect, it } from "vitest";

import { deriveRenderBands } from "../../../src/domain/commands/render-bands";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { FILE_SCHEMA_LIMITS, validateInkSnapshotV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { createStressLimitFixture, STRESS_POINTS, STRESS_STROKES } from "./fixtures";

const EXPECTED_METADATA_BYTES = 19_911_562;
// This fixture has collinear smoothed samples: at most 200 markup bytes per
// compact centerline plus 8 KiB for the fixed envelope and background.
const MAXIMUM_STATIC_MARKUP_BYTES = STRESS_STROKES * 200 + 8192;
const MAXIMUM_BYTES_PER_STROKE_POINT = 14;
let sourceSnapshot: ReturnType<typeof createStressLimitFixture> | undefined;

afterAll(() => {
  sourceSnapshot = undefined;
});

// Only source data is shared; validation, store preparation and export own fresh state.
function stressSnapshot() {
  sourceSnapshot ??= createStressLimitFixture();
  return sourceSnapshot;
}

describe("combined persistence stress limits", () => {
  it("validates exactly 15,000 strokes and 2,000,000 points at the schema limits", async ({
    annotate,
  }) => {
    const snapshot = stressSnapshot();
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
    const snapshot = stressSnapshot();
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
    const snapshot = stressSnapshot();
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
    expect(staticMarkupBytes).toBeLessThanOrEqual(MAXIMUM_STATIC_MARKUP_BYTES);
    expect(totalBytes).toBe(byteLength(svg));
    expect(bytesPerStrokePoint).toBeLessThanOrEqual(MAXIMUM_BYTES_PER_STROKE_POINT);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(svg));
    const expectedHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(hash).toBe(expectedHash);
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
