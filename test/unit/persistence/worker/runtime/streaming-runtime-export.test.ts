import { describe, expect, it } from "vitest";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";

import { derivePageExtent } from "../../../../../src/domain/geometry/public";
import { FILE_SCHEMA_LIMITS, type InkSnapshotV1 } from "../../../../../src/domain/schema/public";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "../../../../../src/persistence/documents/svg-output-limits";
import {
  backgroundFitsStaticLimit,
  backgroundPathDataByteLength,
  serializeBackgroundPaths,
} from "../../../../../src/persistence/serialization/background";
import {
  canonicalMetadataSha256,
  canonicalMetadataSha256Async,
  metadataPrefix,
} from "../../../../../src/persistence/serialization/canonical-metadata";
import { EncodedByteBudget } from "../../../../../src/persistence/serialization/encoded-byte-budget";
import {
  buildElementFragments,
  type ElementFragments,
} from "../../../../../src/persistence/serialization/element-fragments";
import { serializedPathDataByteLength } from "../../../../../src/persistence/serialization/path-markup";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { serializeRuntimeSnapshotToUtf8 } from "../../../../../src/persistence/serialization/streaming-runtime-export";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../src/persistence/worker/runtime/public";
import { createProductionDocumentRuntime } from "../../../../../src/persistence/worker/runtime/production-document-runtime";
import { rectangle, rectangleDocument, snapshot } from "./fixtures";

const executor = { sessionId: "session-a", workerEpoch: 3 } as const;
const textEncoder = new TextEncoder();

function dottedRectangleDocument(y: number): InkSnapshotV1 {
  const element = rectangle();
  return {
    ...snapshot(),
    elements: [
      {
        ...element,
        pivot: { x: element.pivot.x, y: y + element.height / 2 },
        y,
      },
    ],
    page: { ...snapshot().page, background: { type: "dots", spacing: 25 } },
  };
}

describe("production streaming runtime export limits", () => {
  it("measures generated background path data without retaining another copy", () => {
    const background = { type: "dots" as const, spacing: 25 as const };
    const lockedHeight = 2_048.6;
    const markup = serializeBackgroundPaths(background, lockedHeight).join("");

    expect(backgroundPathDataByteLength(background, lockedHeight)).toBe(
      serializedPathDataByteLength(markup),
    );
  });

  it("preserves the exact combined path-data byte boundary", () => {
    const atLimit = new EncodedByteBudget(MAXIMUM_TOTAL_PATH_DATA_BYTES);
    const overLimit = new EncodedByteBudget(MAXIMUM_TOTAL_PATH_DATA_BYTES);

    expect(atLimit.tryReserve(MAXIMUM_TOTAL_PATH_DATA_BYTES)).toBe(true);
    expect(atLimit.usedBytes).toBe(MAXIMUM_TOTAL_PATH_DATA_BYTES);
    expect(overLimit.tryReserve(MAXIMUM_TOTAL_PATH_DATA_BYTES + 1)).toBe(false);
    expect(overLimit.usedBytes).toBe(0);
  });

  it("rejects a 550,000-unit dotted document before adopting invalid output", async () => {
    const document = dottedRectangleDocument(550_000);
    const extent = derivePageExtent(document.page, 550_100);
    expect(
      backgroundFitsStaticLimit(
        document.page.background,
        extent.lockedHeight,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      ),
    ).toBe(true);
    expect(
      backgroundPathDataByteLength(document.page.background, extent.lockedHeight),
    ).toBeGreaterThan(MAXIMUM_TOTAL_PATH_DATA_BYTES);
    const runtime = createProductionDocumentRuntime(executor, {
      workScheduler: createTestWorkScheduler(),
    });

    const result = await runtime.execute({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: document,
      type: "export-full",
    });

    expect(result).toMatchObject({
      error: { code: "static-output-limit-exceeded", retryable: true },
      type: "export-failure",
    });
    expect(runtime.instrumentation.unacknowledgedExports).toBe(0);
    runtime.terminate();
  });

  it.each([
    { expectedBuilds: 15, oversizedField: "metadata" as const },
    { expectedBuilds: 16, oversizedField: "svg" as const },
  ])(
    "rejects near-limit $oversizedField fragments before constructing the complete document",
    async ({ expectedBuilds, oversizedField }) => {
      const document = rectangleDocument(20);
      const payload = "x".repeat(4 * 1024 * 1024);
      let fragmentBuilds = 0;
      let checkpoints = 0;

      const result = await serializeRuntimeSnapshotToUtf8(
        document,
        {
          checkpoint: async () => {
            checkpoints += 1;
          },
        },
        (element) => {
          fragmentBuilds += 1;
          return oversizedFragment(element, payload, oversizedField);
        },
      );

      expect(result).toMatchObject({
        error: { code: "static-output-limit-exceeded" },
        ok: false,
      });
      expect(fragmentBuilds).toBe(expectedBuilds);
      expect(fragmentBuilds).toBeLessThan(document.elements.length);
      expect(checkpoints).toBe(expectedBuilds - 1);
    },
  );
});

describe("runtime canonical metadata hashing", () => {
  it("matches the canonical v1 hash through the asynchronous platform digest", async () => {
    const document = rectangleDocument(4);
    const fragments = document.elements.map((element) => buildElementFragments(element));
    let digestedBytes = 0;

    const actual = await canonicalMetadataSha256Async(
      metadataPrefix(document.revision, document.page),
      fragments.map(({ canonicalMetadataUtf8 }) => canonicalMetadataUtf8),
      canonicalMetadataByteLength(document, fragments),
      {
        digest: async (bytes) => {
          digestedBytes = bytes.byteLength;
          return crypto.subtle.digest("SHA-256", bytes);
        },
        sliceByteLimit: 31,
      },
    );

    expect(actual).toBe(canonicalMetadataSha256(document));
    expect(digestedBytes).toBe(canonicalMetadataByteLength(document, fragments));
  });

  it.each([
    ["unavailable", null],
    ["rejected", async () => Promise.reject(new Error("Digest unavailable."))],
  ] as const)("preserves the canonical hash when WebCrypto is %s", async (_name, digest) => {
    const document = rectangleDocument(2);
    const fragments = document.elements.map((element) => buildElementFragments(element));

    await expect(
      canonicalMetadataSha256Async(
        metadataPrefix(document.revision, document.page),
        fragments.map(({ canonicalMetadataUtf8 }) => canonicalMetadataUtf8),
        canonicalMetadataByteLength(document, fragments),
        { digest },
      ),
    ).resolves.toBe(canonicalMetadataSha256(document));
  });

  it("aborts during bounded canonical metadata assembly before digesting", async () => {
    const document = rectangleDocument(20);
    const fragments = document.elements.map((element) => buildElementFragments(element));
    const controller = new AbortController();
    let digestInvoked = false;

    await expect(
      canonicalMetadataSha256Async(
        metadataPrefix(document.revision, document.page),
        fragments.map(({ canonicalMetadataUtf8 }) => canonicalMetadataUtf8),
        canonicalMetadataByteLength(document, fragments),
        {
          checkpoint: async () => {
            controller.abort();
          },
          digest: async () => {
            digestInvoked = true;
            return new ArrayBuffer(32);
          },
          signal: controller.signal,
          sliceByteLimit: 32,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(digestInvoked).toBe(false);
  });
});

describe("scheduled streaming runtime fragment reuse", () => {
  it.each([
    ["production", productionRuntime],
    ["fallback", fallbackRuntime],
  ] as const)("reuses bounded fragments in the scheduled %s export path", async (_name, create) => {
    const runtime = create();
    const document = rectangleDocument(4);
    const first = await runtime.execute({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: document,
      type: "export-full",
    });
    expect(first.type).toBe("export-success");
    if (first.type !== "export-success") throw new Error("Expected export success.");
    const expected = serializeInkbookDocument(document);
    if (!expected.ok) throw new Error(expected.error.code);
    expect(first.outputHash).toBe(expected.value.hash);
    const afterFull = runtime.instrumentation;
    expect(afterFull).toMatchObject({ cacheElements: 4, fragmentBuilds: 4 });
    runtime.acknowledgeExport(first, true);

    const order = document.elements.map(({ id }) => id).reverse();
    const ordered = await runtime.execute({
      ...executor,
      baseModelRevision: 0,
      exportGeneration: 2,
      modelRevision: 1,
      orderChanges: { content: order },
      type: "export-incremental",
    });

    expect(ordered.type).toBe("export-success");
    expect(runtime.instrumentation).toMatchObject({
      cacheElements: 4,
      fragmentBuilds: afterFull.fragmentBuilds,
    });
    if (ordered.type === "export-success") runtime.acknowledgeExport(ordered, true);
    runtime.terminate();
  });
});

function productionRuntime(): DocumentWorkerRuntime {
  return createProductionDocumentRuntime(executor, { workScheduler: createTestWorkScheduler() });
}

function fallbackRuntime(): DocumentWorkerRuntime {
  return new DocumentWorkerRuntime(
    executor,
    new GestureAwareSliceScheduler({
      isInputActive: () => false,
      workScheduler: createTestWorkScheduler(),
    }),
  );
}

function canonicalMetadataByteLength(
  document: InkSnapshotV1,
  fragments: readonly ElementFragments[],
): number {
  const prefixBytes = textEncoder.encode(
    metadataPrefix(document.revision, document.page),
  ).byteLength;
  const separators = Math.max(0, fragments.length - 1);
  return (
    prefixBytes +
    fragments.reduce((total, fragment) => total + fragment.canonicalMetadataBytes, 0) +
    separators +
    2
  );
}

function oversizedFragment(
  element: InkSnapshotV1["elements"][number],
  payload: string,
  oversizedField: "metadata" | "svg",
): ElementFragments {
  const metadata = oversizedField === "metadata" ? payload : "{}";
  const svg = oversizedField === "svg" ? payload : "";
  return {
    bottom: 180,
    bytes: metadata.length + svg.length,
    canonicalMetadata: metadata,
    canonicalMetadataBytes: metadata.length,
    canonicalMetadataUtf8: textEncoder.encode(metadata),
    element,
    metadata,
    metadataBytes: metadata.length,
    metadataUtf8: textEncoder.encode(metadata),
    pathDataBytes: 0,
    retainedBytes: metadata.length + svg.length,
    svg,
    svgUtf8: textEncoder.encode(svg),
  };
}
