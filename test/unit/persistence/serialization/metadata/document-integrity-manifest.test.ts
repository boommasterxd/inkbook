import { CanonicalMetadataCache } from "../../../../../src/persistence/serialization/metadata/canonical-metadata-cache";
import { describe, expect, it } from "vitest";

import type { InkSnapshotV1 } from "../../../../../src/domain/schema/public";
import {
  deriveDocumentIntegrityManifest,
  deriveDocumentIntegrityManifestFromContentDigest,
  sameDocumentIntegrityManifest,
} from "../../../../../src/persistence/serialization/public";
import { isDocumentIntegrityManifest } from "../../../../../src/persistence/serialization/metadata/document-integrity-manifest";
import { rectangle, snapshot } from "../../worker/runtime/fixtures";

const SECOND_ID = "00000000-0000-4000-8000-000000000002";

describe("document integrity manifest", () => {
  it("is deterministic for equivalent snapshot and runtime stroke representations", () => {
    const stroke = strokeSnapshot();
    const runtime = {
      ...stroke,
      elements: [{ ...stroke.elements[0]!, points: new Float64Array([1, 2, 0.5, 3, 4, 1]) }],
    } as unknown as InkSnapshotV1;

    const first = deriveDocumentIntegrityManifest(stroke);
    const second = deriveDocumentIntegrityManifest(runtime);

    expect(second).toEqual(first);
    expect(sameDocumentIntegrityManifest(first, second)).toBe(true);
    expect(isDocumentIntegrityManifest(first)).toBe(true);
  });

  it("changes for revision, order, page, ID, and element content divergence", () => {
    const base = twoElementSnapshot();
    const manifest = deriveDocumentIntegrityManifest(base);
    const variants: InkSnapshotV1[] = [
      { ...base, revision: 1 },
      { ...base, elements: [...base.elements].reverse() },
      { ...base, page: { ...base.page, activeBufferLines: 4 } },
      { ...base, elements: [{ ...base.elements[0]!, id: SECOND_ID }, base.elements[1]!] },
      { ...base, elements: [{ ...rectangle(), x: 101 }, base.elements[1]!] },
    ];

    for (const variant of variants) {
      expect(
        sameDocumentIntegrityManifest(manifest, deriveDocumentIntegrityManifest(variant)),
      ).toBe(false);
    }
  });

  it("keeps cooperative and precomputed-content derivation byte-exact", async () => {
    const value = twoElementSnapshot();
    const expected = deriveDocumentIntegrityManifest(value);
    let checkpoints = 0;

    const digest = await new CanonicalMetadataCache().digest(value, async () => {
      checkpoints += 1;
    });
    expect(deriveDocumentIntegrityManifestFromContentDigest(value, digest)).toEqual(expected);
    expect(deriveDocumentIntegrityManifestFromContentDigest(value, expected.contentDigest)).toEqual(
      expected,
    );
    expect(checkpoints).toBeGreaterThan(0);
  });

  it("checkpoints inside one long stroke without copying its complete runtime point buffer", async () => {
    const value = strokeSnapshot();
    const first = value.elements[0]!;
    if (first.kind !== "stroke") throw new Error("Expected stroke.");
    const points = new Float64Array(30_000).fill(0.5);
    value.elements = [{ ...first, points } as unknown as typeof first];
    const expected = deriveDocumentIntegrityManifest(value);
    let checkpoints = 0;
    const abort = new AbortController();
    await expect(
      new CanonicalMetadataCache().digest(value, async () => {
        checkpoints += 1;
      }),
    ).resolves.toEqual(expected.contentDigest);
    expect(checkpoints).toBeGreaterThan(1);
    await expect(
      new CanonicalMetadataCache().digest(
        value,
        async () => {
          abort.abort();
        },
        abort.signal,
      ),
    ).rejects.toThrow();
  });

  it("rejects incomplete and malformed wire representations", () => {
    const valid = deriveDocumentIntegrityManifest(snapshot());
    expect(isDocumentIntegrityManifest({ ...valid, contentDigest: "not-a-digest" })).toBe(false);
    expect(isDocumentIntegrityManifest({ ...valid, elementCount: -1 })).toBe(false);
    expect(isDocumentIntegrityManifest(undefined)).toBe(false);
    expect(() => deriveDocumentIntegrityManifestFromContentDigest(snapshot(), "invalid")).toThrow(
      TypeError,
    );
  });
});

function twoElementSnapshot(): InkSnapshotV1 {
  return {
    ...snapshot(),
    elements: [rectangle(), { ...rectangle(300), id: SECOND_ID }],
  };
}

function strokeSnapshot(): InkSnapshotV1 {
  return {
    ...snapshot(),
    elements: [
      {
        createdAt: 1,
        id: "00000000-0000-4000-8000-000000000003",
        kind: "stroke",
        pivot: { x: 2, y: 3 },
        points: [1, 2, 0.5, 3, 4, 1],
        rotation: 0,
        style: {
          color: { type: "theme-text" },
          opacity: 1,
          pressureEnabled: false,
          smoothing: 0.5,
          width: 2,
        },
        tool: "pen",
      },
    ],
  };
}
