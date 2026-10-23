import { describe, expect, it } from "vitest";
import { ChunkedInkbookInputParser } from "../../../../../src/persistence/serialization/input/chunked-input-codec";
import { canonicalSnapshot } from "../../../../../src/persistence/serialization/metadata/canonical-snapshot";
import { canonicalMetadataSha256 } from "../../../../../src/persistence/serialization/metadata/canonical-metadata";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/document-codec";
import { decodeCompactSnapshotSteps } from "../../../../../src/persistence/serialization/metadata/compact-snapshot";
import { FILE_SCHEMA_LIMITS } from "../../../../../src/domain/schema/public";
import { rewriteDocumentMetadata } from "../../../../fixtures/persistence/metadata-rewrite";
import { createAllElementSnapshot } from "../fixtures";

describe("compact document metadata", () => {
  it("loads both encodings without a rewrite and publishes compact samples directly as typed buffers", async () => {
    const snapshot = createAllElementSnapshot();
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.message);
    const legacy = rewriteDocumentMetadata(
      serialized.value.svg,
      () => JSON.stringify(canonicalSnapshot(snapshot)),
      true,
    ).replace('data-encoding="json-varint-v1"', 'data-encoding="json"');
    const compact = await parse(serialized.value.svg);
    const old = await parse(legacy);

    expect(compact.ok).toBe(true);
    expect(old.ok).toBe(true);
    if (!compact.ok || !old.ok) throw new Error("Expected both encodings to load.");
    expect(compact.value.requiresCanonicalRewrite).toBe(false);
    expect(old.value.requiresCanonicalRewrite).toBe(false);
    expect(canonicalSnapshot(compact.value.snapshot)).toEqual(snapshot);
    expect(canonicalSnapshot(old.value.snapshot)).toEqual(snapshot);
    const stroke = compact.value.snapshot.elements.find((element) => element.kind === "stroke");
    expect(stroke?.kind === "stroke" && stroke.points).toBeInstanceOf(Float64Array);
    expect(canonicalMetadataSha256(compact.value.snapshot)).toBe(serialized.value.snapshotHash);
  });

  it.each(["gYAB", "AQAAAAA=", "AQ==", [0, 0, 0]])(
    "rejects malformed compact stroke samples %j through the real document parser",
    async (points) => {
      const serialized = serializeInkbookDocument(createAllElementSnapshot());
      if (!serialized.ok) throw new Error(serialized.error.message);
      const invalid = rewriteDocumentMetadata(
        serialized.value.svg,
        (text) => {
          const disk = JSON.parse(text) as { elements: Array<{ kind: string; points?: unknown }> };
          const stroke = disk.elements.find((element) => element.kind === "stroke");
          if (stroke === undefined) throw new Error("Expected fixture stroke.");
          stroke.points = points;
          return JSON.stringify(disk);
        },
        true,
      );

      expect(await parse(invalid)).toMatchObject({
        ok: false,
        error: { code: "snapshot-invalid" },
      });
    },
  );

  it("rejects unknown encodings before publishing a snapshot", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    if (!serialized.ok) throw new Error(serialized.error.message);

    expect(
      await parse(serialized.value.svg.replace("json-varint-v1", "json-varint-v2")),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-svg" },
    });
  });
});

describe("compact snapshot resource preflight", () => {
  it("preserves invalid root values for the semantic schema validator", () => {
    for (const value of [null, [], 0, {}, { elements: null }]) {
      expect(complete(decodeCompactSnapshotSteps(value))).toBeUndefined();
    }
  });

  it("rejects an oversized element list before decoding its contents", () => {
    const value = { elements: new Array(FILE_SCHEMA_LIMITS.elements + 1).fill(null) };
    expect(() => complete(decodeCompactSnapshotSteps(value))).toThrow(RangeError);
  });

  it("rejects an oversized stroke list while retaining bounded sample ownership", () => {
    const value = {
      elements: Array.from({ length: FILE_SCHEMA_LIMITS.strokes + 1 }, () => ({
        kind: "stroke",
        points: "AQAAAA==",
      })),
    };
    expect(() => complete(decodeCompactSnapshotSteps(value))).toThrow(RangeError);
    expect(value.elements[FILE_SCHEMA_LIMITS.strokes]!.points).toBe("AQAAAA==");
  });
});

async function parse(input: string) {
  const parser = new ChunkedInkbookInputParser({ staticValidation: "safe" });
  const write = await parser.write(new TextEncoder().encode(input));
  return write.ok ? parser.finish() : write;
}

function complete(steps: Generator<void>): void {
  let step = steps.next();
  while (!step.done) step = steps.next();
}
