import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../src/domain/geometry/public";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../../../src/domain/spatial/index";
import { yieldToMainThread } from "../../../src/persistence/scheduling/main-thread-yield";
import {
  deriveDocumentIntegrityManifest,
  deriveDocumentIntegrityManifestAsync,
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { createProductionDocumentRuntime } from "../../../src/persistence/worker/runtime/production-document-runtime";
import type { DocumentRuntimeRequest } from "../../../src/persistence/worker/runtime/public";
import { STANDARD_POINTS, createStandardPersistenceFixture, replaceFirstStroke } from "./fixtures";
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

  it("rejects amplified near-limit output before final assembly or slice work", async ({
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

    expect(result).toMatchObject({ ok: false, error: { code: "static-output-limit-exceeded" } });
    expect(serializer.instrumentation.fragmentBuilds).toBeLessThan(amplified.elements.length);
    expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * MIB);
    expect(checkpoints).toBe(0);
    await annotate(
      `amplified near-limit rejection: ` +
        `fragmentsBuilt=${serializer.instrumentation.fragmentBuilds}/${amplified.elements.length}, ` +
        `checkpoints=${checkpoints}`,
      "performance",
    );
  }, 120_000);

  it("checkpoints receiver integrity derivation without changing its result", async () => {
    let checkpoints = 0;
    const result = await deriveDocumentIntegrityManifestAsync(snapshot, {
      checkpoint: async () => {
        checkpoints += 1;
      },
    });
    expect(result).toEqual(deriveDocumentIntegrityManifest(snapshot));
    expect(checkpoints).toBeGreaterThan(1);
    expect(checkpoints).toBeLessThanOrEqual(snapshot.elements.length);
  }, 120_000);
});

describe("document worker export work bounds", () => {
  it("rebuilds only changed fragments and reuses all fragments for order-only exports", async () => {
    const runtime = createProductionDocumentRuntime(
      { sessionId: "performance", workerEpoch: 1 },
      { yieldControl: async () => undefined },
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
  runtime.acknowledgeExport(identity, true);
  runtime.requestPrewarm();
  while (runtime.instrumentation.prewarmedElements < snapshot.elements.length) {
    await yieldToMainThread();
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
