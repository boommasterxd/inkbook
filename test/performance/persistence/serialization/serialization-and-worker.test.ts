import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { CanonicalMetadataCache } from "../../../../src/persistence/serialization/metadata/canonical-metadata-cache";
import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import {
  MAX_ELEMENT_CELLS,
  spatialCellMembershipCount,
} from "../../../../src/domain/spatial/index";
import {
  deriveDocumentIntegrityManifest,
  deriveDocumentIntegrityManifestFromContentDigest,
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import { createProductionDocumentRuntime } from "../../../../src/persistence/worker/runtime/production-document-runtime";
import { serializeCanonicalElementMetadata } from "../../../../src/persistence/serialization/metadata/canonical-element-fragments";
import type { DocumentRuntimeRequest } from "../../../../src/persistence/worker/runtime/public";
import { STANDARD_POINTS, createStandardPersistenceFixture, replaceFirstStroke } from "../fixtures";
import {
  observeIntegrityWork,
  type IntegrityWork,
} from "../../../fixtures/persistence/integrity-work-observer";
const MIB = 1024 * 1024;
const snapshot = createStandardPersistenceFixture();

describe("persistence serialization performance", () => {
  it("keeps the normative fixture deterministic and within file-size budgets", async ({
    annotate,
  }) => {
    const baseline = requireSerialized(serializeFixture());
    expect(requireSerialized(serializeFixture())).toEqual(baseline);

    expect(baseline.metadataBytes).toBeLessThanOrEqual(32 * MIB);
    expect(baseline.totalBytes).toBeLessThanOrEqual(48 * MIB);
    expect(baseline.svg).not.toContain("\n");
    await annotate(
      `standard SVG: total=${baseline.totalBytes} bytes, metadata=${baseline.metadataBytes} bytes, ` +
        `static=${staticMarkupBytes(baseline.svg)} bytes, ` +
        `bytesPerStrokePoint=${(baseline.totalBytes / STANDARD_POINTS).toFixed(3)}`,
      "performance",
    );
  }, 120_000);

  it("exports one million pressure samples within bounded compact output and cache capacity", async ({
    annotate,
  }) => {
    const amplified = amplifyNearLimitSnapshot(snapshot);
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.reset(amplified).ok).toBe(true);
    let checkpoints = 0;
    const result = await serializer.serializeChunked({
      checkpoint: async () => {
        checkpoints += 1;
      },
      sliceByteLimit: 64 * 1024,
    });

    expect(
      amplified.elements.reduce(
        (count, element) => count + (element.kind === "stroke" ? element.points.length / 3 : 0),
        0,
      ),
    ).toBe(1_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.totalBytes).toBeLessThanOrEqual(64 * MIB);
    expect(new TextEncoder().encode(result.value.svg).byteLength).toBe(result.value.totalBytes);
    expect(serializer.instrumentation.fragmentBuilds).toBe(amplified.elements.length);
    expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * MIB);
    expect(serializer.instrumentation.shapeCacheBytes).toBeLessThanOrEqual(32 * MIB);
    expect(checkpoints).toBeGreaterThan(0);
    await assertEvictedContourReuse(serializer, amplified);
    await annotate(
      `compact million-sample export: output=${result.value.totalBytes} bytes, ` +
        `fragmentsBuilt=${serializer.instrumentation.fragmentBuilds}/${amplified.elements.length}, ` +
        `checkpoints=${checkpoints}`,
      "performance",
    );
  }, 120_000);
});

describe("receiver integrity work bounds", () => {
  it("bounds receiver integrity work between checkpoints without changing its result", async () => {
    const sliceBytes = 64 * 1024;
    // UUIDs are ASCII; the ordered-ID pass includes its domain prefix and one NUL per ID.
    const orderedIdBytes =
      "inkbook-ordered-ids-v1".length +
      snapshot.elements.reduce((bytes, element) => bytes + 1 + element.id.length, 0);
    const nonStrokeBytes = snapshot.elements.reduce(
      (bytes, element) =>
        bytes +
        (element.kind === "stroke"
          ? 0
          : new TextEncoder().encode(serializeCanonicalElementMetadata(element)).byteLength),
      0,
    );
    const observer = observeIntegrityWork(snapshot);
    try {
      const expected = deriveDocumentIntegrityManifest(observer.snapshot);
      const reference = observer.take();
      expect(reference.canonicalElements).toBe(snapshot.elements.length);
      expect(reference.elementReads).toBe(2 * snapshot.elements.length);
      expect(reference.encodedBytes).toBe(reference.hashedBytes);
      const slices: IntegrityWork[] = [];
      vi.stubGlobal("crypto", undefined);
      const digest = await new CanonicalMetadataCache().digest(observer.snapshot, async () => {
        slices.push(observer.take());
      });
      const result = deriveDocumentIntegrityManifestFromContentDigest(observer.snapshot, digest);
      const finalSlice = observer.take();
      expect(result).toEqual(expected);
      expect(slices.length).toBeGreaterThan(1);
      for (const slice of slices) assertIntegritySlice(slice, sliceBytes);
      // The ordered-ID digest is currently synchronous and belongs to the final slice.
      expect(finalSlice.encodedBytes).toBeLessThan(sliceBytes + orderedIdBytes);
      expect(finalSlice.hashedBytes).toBe(finalSlice.encodedBytes);
      expect(finalSlice.copiedBytes).toBe(0);
      expect(finalSlice.sampleBytes).toBe(0);
      expect(finalSlice.elementReads).toBe(finalSlice.canonicalElements + snapshot.elements.length);
      expect(finalSlice.canonicalElements).toBeLessThanOrEqual(Math.ceil(sliceBytes / 38));
      const total = [...slices, finalSlice].reduce(
        (sum, slice) => ({
          canonicalElements: sum.canonicalElements + slice.canonicalElements,
          copiedBytes: sum.copiedBytes + slice.copiedBytes,
          elementReads: sum.elementReads + slice.elementReads,
          encodedBytes: sum.encodedBytes + slice.encodedBytes,
          hashedBytes: sum.hashedBytes + slice.hashedBytes,
          sampleBytes: sum.sampleBytes + slice.sampleBytes,
        }),
        {
          canonicalElements: 0,
          copiedBytes: 0,
          elementReads: 0,
          encodedBytes: 0,
          hashedBytes: 0,
          sampleBytes: 0,
        },
      );
      assertIntegrityTotals(
        total,
        reference,
        snapshot.elements.length,
        orderedIdBytes,
        nonStrokeBytes,
      );
    } finally {
      observer.restore();
      vi.unstubAllGlobals();
    }
  }, 120_000);
});

async function assertEvictedContourReuse(
  serializer: IncrementalDocumentSerializer,
  fixture: ReturnType<typeof createStandardPersistenceFixture>,
): Promise<void> {
  expect(serializer.instrumentation.cacheElements).toBe(fixture.elements.length);
  expect(serializer.instrumentation.shapeCacheElements).toBeLessThan(10_000);
  const firstStroke = fixture.elements.find((element) => element.kind === "stroke")!;
  const before = serializer.instrumentation;
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  try {
    const prepared = await serializer.prepareScenePath(firstStroke.id, {
      signal: new AbortController().signal,
      checkpoint: () => undefined,
    });
    expect(prepared).toBeDefined();
    const bytes = decode.mock.calls.map(([input]) => input?.byteLength ?? 0);
    expect(bytes.reduce((sum, count) => sum + count, 0)).toBe(
      prepared!.reduce((sum, part) => sum + part.d.length, 0),
    );
    expect(Math.max(...bytes)).toBeLessThanOrEqual(64 * 1024);
    expect(serializer.instrumentation.shapeBuilds).toBe(before.shapeBuilds);
    expect(serializer.instrumentation.shapeCacheBytes).toBe(before.shapeCacheBytes);
    expect(serializer.instrumentation.cacheBytes).toBe(before.cacheBytes);
  } finally {
    decode.mockRestore();
  }
}

describe("document worker export work bounds", () => {
  it("rebuilds only changed fragments and reuses all fragments for order-only exports", async () => {
    const runtime = createProductionDocumentRuntime(
      { sessionId: "performance", workerEpoch: 1 },
      { workScheduler: createTestWorkScheduler() },
    );
    try {
      await fullExport(runtime, 1);
      await incrementalExport(runtime, 2, snapshot.revision, snapshot.revision + 1);
      await orderOnlyExport(
        runtime,
        3,
        snapshot.revision + 1,
        snapshot.revision + 2,
        snapshot.elements.map(({ id }) => id).reverse(),
      );
      await orderOnlyExport(
        runtime,
        4,
        snapshot.revision + 2,
        snapshot.revision + 3,
        snapshot.elements.map(({ id }) => id),
      );
    } finally {
      runtime.terminate();
    }
  }, 120_000);
});

function serializeFixture() {
  return serializeInkbookDocument(snapshot, { hash: () => "fixture-hash" });
}

function requireSerialized(result: ReturnType<typeof serializeInkbookDocument>) {
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.validationError?.path ?? "output"}: ${result.error.message}`,
    );
  }
  return result.value;
}

async function fullExport(runtime: DocumentWorkerRuntime, exportGeneration: number): Promise<void> {
  return executeExport(runtime, {
    baseModelRevision: null,
    exportGeneration,
    modelRevision: snapshot.revision,
    sessionId: "performance",
    snapshot,
    type: "export-full",
    workerEpoch: 1,
  });
}

async function incrementalExport(
  runtime: DocumentWorkerRuntime,
  exportGeneration: number,
  baseModelRevision: number,
  modelRevision: number,
): Promise<void> {
  const changed = replaceFirstStroke(snapshot, modelRevision);
  const bounds = calculateElementBounds(changed);
  const spatialMemberships = spatialCellMembershipCount(bounds);
  const spatialOverflow = spatialMemberships > MAX_ELEMENT_CELLS;
  return executeExport(runtime, {
    baseModelRevision,
    changedElementDerivations: [
      {
        bounds,
        elementId: changed.id,
        spatialMemberships: spatialOverflow ? 0 : spatialMemberships,
        spatialOverflow,
      },
    ],
    changedElements: [changed],
    exportGeneration,
    modelRevision,
    sessionId: "performance",
    type: "export-incremental",
    workerEpoch: 1,
  });
}

async function orderOnlyExport(
  runtime: DocumentWorkerRuntime,
  exportGeneration: number,
  baseModelRevision: number,
  modelRevision: number,
  content: readonly string[],
): Promise<void> {
  return executeExport(runtime, {
    baseModelRevision,
    exportGeneration,
    modelRevision,
    orderChanges: { content },
    sessionId: "performance",
    type: "export-incremental",
    workerEpoch: 1,
  });
}

type ExportRequest = Extract<
  DocumentRuntimeRequest,
  { type: "export-full" | "export-incremental" }
>;

async function executeExport(
  runtime: DocumentWorkerRuntime,
  request: ExportRequest,
): Promise<void> {
  const before = runtime.instrumentation;
  const result = await runtime.execute(request);
  const exported = requireExportSuccess(result);
  expect(exported.modelRevision).toBe(request.modelRevision);
  const identity = exportIdentity(exported);
  await acknowledgeAndPrewarm(runtime, identity);
  if (request.type === "export-incremental") {
    const changedCount = request.changedElements?.length ?? 0;
    expect(runtime.instrumentation.fragmentBuilds - before.fragmentBuilds).toBe(changedCount);
    expect(runtime.instrumentation.derivedBoundsReuses - before.derivedBoundsReuses).toBe(
      changedCount,
    );
  }
}

function requireExportSuccess(result: Awaited<ReturnType<DocumentWorkerRuntime["execute"]>>) {
  if (result.type !== "export-success") {
    throw new Error(
      result.type === "export-failure"
        ? `${result.error.code}: export failed`
        : `Unexpected worker result: ${result.type}`,
    );
  }
  return result;
}

async function acknowledgeAndPrewarm(
  runtime: DocumentWorkerRuntime,
  identity: Parameters<DocumentWorkerRuntime["acknowledgeExport"]>[0],
): Promise<void> {
  const prewarm = vi.spyOn(IncrementalDocumentSerializer.prototype, "prewarmElementAtSliced");
  try {
    runtime.acknowledgeExport(identity, true);
    runtime.requestPrewarm();
    await Promise.resolve();
    expect(prewarm).not.toHaveBeenCalled();
    expect(runtime.instrumentation.prewarmVisitedElements).toBe(0);
    expect(runtime.instrumentation.prewarmedBytes).toBe(0);
  } finally {
    prewarm.mockRestore();
  }
  expect(runtime.instrumentation.cacheElements).toBe(snapshot.elements.length);
  expect(runtime.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * MIB);
}

function exportIdentity(
  result: ReturnType<typeof requireExportSuccess>,
): Parameters<DocumentWorkerRuntime["acknowledgeExport"]>[0] {
  return {
    exportGeneration: result.exportGeneration,
    modelRevision: result.modelRevision,
    sessionId: result.sessionId,
    workerEpoch: result.workerEpoch,
  };
}

function staticMarkupBytes(svg: string): number {
  const withoutMetadata = svg.replace(/<metadata[^>]*>[\s\S]*?<\/metadata>/u, "");
  return new TextEncoder().encode(withoutMetadata).byteLength;
}

function amplifyNearLimitSnapshot(
  source: ReturnType<typeof createStandardPersistenceFixture>,
): ReturnType<typeof createStandardPersistenceFixture> {
  return {
    ...source,
    elements: source.elements.map((element) => {
      if (element.kind !== "stroke") return element;
      const points = new Array<number>(element.points.length * 2);
      for (let index = 0; index < element.points.length; index += 3) {
        const target = index * 2;
        points[target] = element.points[index]!;
        points[target + 1] = element.points[index + 1]!;
        points[target + 2] = element.points[index + 2]!;
        points[target + 3] = element.points[index]!;
        // Distinct turns amplify actual output geometry rather than redundant metadata.
        points[target + 4] = element.points[index + 1]! + (index % 6 === 0 ? 1 : -1);
        points[target + 5] = element.points[index + 2]!;
      }
      return { ...element, points };
    }),
  };
}

function assertIntegritySlice(work: IntegrityWork, sliceBytes: number): void {
  // Canonical fragments and fallback hash blocks each checkpoint independently.
  expect(work.encodedBytes).toBeLessThanOrEqual(sliceBytes);
  expect(work.hashedBytes).toBeLessThanOrEqual(sliceBytes);
  // Sample chunks copy at most 256 bytes before resumable 64 KiB final assembly.
  expect(work.copiedBytes).toBeLessThanOrEqual(sliceBytes + 256);
  expect(work.sampleBytes).toBeLessThanOrEqual(sliceBytes);
  // Compact sample text allows several small records within the cache's bounded
  // 64-fragment group; the independently observed byte budget still applies.
  expect(work.elementReads).toBeLessThanOrEqual(64);
  expect(work.canonicalElements).toBeLessThanOrEqual(64);
}

function assertIntegrityTotals(
  actual: IntegrityWork,
  reference: IntegrityWork,
  elementCount: number,
  orderedIdBytes: number,
  nonStrokeBytes: number,
) {
  // Direct sample ASCII replaces native text encoding; separator/suffix bytes remain cached.
  expect(actual).toEqual({
    ...reference,
    copiedBytes: actual.copiedBytes,
    sampleBytes: actual.sampleBytes,
    encodedBytes: reference.encodedBytes - (elementCount - 1 + 2) - actual.sampleBytes,
  });
  const metadataBytes = reference.hashedBytes - orderedIdBytes;
  // One complete assembly, one non-stroke join, and at most two copies of each sample byte.
  expect(actual.copiedBytes).toBeGreaterThanOrEqual(
    metadataBytes + nonStrokeBytes + actual.sampleBytes,
  );
  expect(actual.copiedBytes).toBeLessThanOrEqual(
    metadataBytes + nonStrokeBytes + actual.sampleBytes * 2,
  );
  expect(actual.sampleBytes).toBeGreaterThan(0);
}
