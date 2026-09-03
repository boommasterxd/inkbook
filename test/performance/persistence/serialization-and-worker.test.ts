import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../src/domain/geometry/public";
import { ElementStore } from "../../../src/domain/store/public";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../../../src/domain/spatial/index";
import { changedElementDerivations } from "../../../src/obsidian/embeds/vault-document-model-delta";
import { saveExistingFile } from "../../../src/persistence/saving/save-existing";
import { yieldToMainThread } from "../../../src/persistence/scheduling/main-thread-yield";
import {
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../src/persistence/serialization/public";
import { sha256Hex } from "../../../src/persistence/serialization/sha256";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { createProductionDocumentRuntime } from "../../../src/persistence/worker/runtime/production-document-runtime";
import type { DocumentRuntimeRequest } from "../../../src/persistence/worker/runtime/public";
import { STANDARD_POINTS, createStandardPersistenceFixture, replaceFirstStroke } from "./fixtures";
import {
  annotateDurations,
  annotateProfileRuns,
  collectProfileGarbage,
  expectProfileBudget,
  expectProfileRunsBudget,
  measure,
  measureAsync,
} from "./metrics";

const MIB = 1024 * 1024;
const FULL_EXPORT_SAMPLES_PER_RUN = 20;
const INCREMENTAL_EXPORT_SAMPLES_PER_RUN = 100;
const ORDER_ONLY_EXPORT_SAMPLES_PER_RUN = 20;
const snapshot = createStandardPersistenceFixture();
let serializedSvg: string | null = null;

describe("persistence serialization performance", () => {
  it("keeps the normative fixture deterministic and within file-size budgets", async ({
    annotate,
  }) => {
    const warmup = serializeFixture();
    const baseline = requireSerialized(warmup.value);
    const durations: number[] = [];

    for (let run = 0; run < 5; run += 1) {
      const measured = serializeFixture();
      const output = requireSerialized(measured.value);
      expect(output).toEqual(baseline);
      durations.push(measured.durationMs);
    }

    serializedSvg = baseline.svg;
    expect(baseline.metadataBytes).toBeLessThanOrEqual(32 * MIB);
    expect(baseline.totalBytes).toBeLessThanOrEqual(48 * MIB);
    expect(baseline.svg).not.toContain("\n");
    await annotateDurations(annotate, "full document serialization", durations);
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
    const started = performance.now();
    const result = await serializer.serializeChunked({
      checkpoint: async () => {
        checkpoints += 1;
      },
      sliceByteLimit: 64 * 1024,
    });
    const durationMs = performance.now() - started;

    expect(result).toMatchObject({ ok: false, error: { code: "static-output-limit-exceeded" } });
    expect(serializer.instrumentation.fragmentBuilds).toBeLessThan(amplified.elements.length);
    expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(64 * MIB);
    expect(checkpoints).toBe(0);
    await annotate(
      `amplified near-limit rejection: duration=${durationMs.toFixed(1)}ms, ` +
        `fragmentsBuilt=${serializer.instrumentation.fragmentBuilds}/${amplified.elements.length}, ` +
        `checkpoints=${checkpoints}`,
      "performance",
    );
  }, 120_000);

  it("keeps the synchronous exact-base callback inside the autosave slice budget", async ({
    annotate,
  }) => {
    if (serializedSvg === null) throw new Error("Standard SVG fixture was not serialized.");
    const base = copyString(serializedSvg);
    const next = base
      .replace('data-inkbook-revision="1"', 'data-inkbook-revision="2"')
      .replace('"revision":1', '"revision":2');
    const outputHash = sha256Hex(next);
    await exactBaseSave(base, next, outputHash);
    const callbackDurations: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      callbackDurations.push(await exactBaseSave(base, next, outputHash));
    }
    await annotateDurations(annotate, "Vault.process exact-base callback", callbackDurations);
    expectProfileBudget(callbackDurations, 8);
  }, 120_000);
});

describe("document worker export performance", () => {
  it("reports unlock and incremental-save phases while reusing validated bounds", async ({
    annotate,
  }) => {
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime({ sessionId: "phases", workerEpoch: 1 });
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    const unlocked = await runtime.execute(
      {
        identity: {
          operationId: 1,
          purpose: "unlock",
          sessionId: "phases",
          workerEpoch: 1,
        },
        input: serialized.value.svg,
        type: "unlock",
      },
      {
        unlockBatch: async (batch) => {
          await builder.appendOwnedValidatedRuntime(batch.elements, batch.derivations);
        },
      },
    );
    expect(unlocked.type).toBe("unlock-success");
    const finalized = await measureAsync(() => builder.finalize());
    if (finalized.value === null) throw new Error("Store hydration was cancelled.");

    const first = snapshot.elements[0]!;
    const changed = { ...replaceFirstStroke(snapshot, 2), createdAt: first.createdAt };
    const delta = finalized.value.replace(changed.id, changed);
    if (delta === null) throw new Error("Expected a changed Store record.");
    const reusesBefore = runtime.instrumentation.derivedBoundsReuses;
    const exported = await runtime.execute({
      baseModelRevision: 1,
      changedElementDerivations: changedElementDerivations(delta),
      changedElements: [changed],
      exportGeneration: 1,
      modelRevision: 2,
      sessionId: "phases",
      type: "export-incremental",
      workerEpoch: 1,
    });
    expect(exported.type).toBe("export-success");
    expect(runtime.instrumentation.derivedBoundsReuses).toBe(reusesBefore + 1);
    await annotate(
      `unlock phases=${JSON.stringify(runtime.instrumentation.lastUnlockPhases)}, ` +
        `storeFinalizeMs=${finalized.durationMs.toFixed(1)}, ` +
        `save phases=${JSON.stringify(runtime.instrumentation.lastExportPhases)}`,
      "performance",
    );
    runtime.terminate();
  }, 120_000);

  it("measures full and one-stroke incremental export against desktop budgets", async ({
    annotate,
  }) => {
    const runtime = createProductionDocumentRuntime(
      { sessionId: "performance", workerEpoch: 1 },
      { yieldControl: async () => undefined },
    );
    try {
      const generation = { value: 0 };
      await runExportWarmup(runtime, generation);
      const profile = await runExportProfile(runtime, generation);
      const fullRuns = [profile.full];
      const incrementalRuns = [profile.incremental];
      const orderOnlyRuns = [profile.orderOnly];

      await annotateProfileRuns(annotate, "full worker export", fullRuns);
      await annotateProfileRuns(annotate, "one-stroke incremental worker export", incrementalRuns);
      await annotateProfileRuns(annotate, "order-only worker export", orderOnlyRuns);
      expectProfileRunsBudget(fullRuns, 750);
      expectProfileRunsBudget(incrementalRuns, 100);
      expectProfileRunsBudget(orderOnlyRuns, 100);
      await annotate(
        "Every sample acknowledges its exact export identity and awaits complete input-aware " +
          "fragment prewarming before the next measured export.",
        "performance",
      );
    } finally {
      runtime.terminate();
    }
  }, 300_000);
});

async function runExportWarmup(
  runtime: DocumentWorkerRuntime,
  generation: { value: number },
): Promise<void> {
  await fullExport(runtime, ++generation.value);
  await incrementalExport(runtime, ++generation.value, snapshot.revision, snapshot.revision + 1);
  await orderOnlyExport(
    runtime,
    ++generation.value,
    snapshot.revision + 1,
    snapshot.revision + 2,
    snapshot.elements.map(({ id }) => id).reverse(),
  );
}

async function runExportProfile(
  runtime: DocumentWorkerRuntime,
  generation: { value: number },
): Promise<{ full: number[]; incremental: number[]; orderOnly: number[] }> {
  const full: number[] = [];
  for (let sample = 0; sample < FULL_EXPORT_SAMPLES_PER_RUN; sample += 1) {
    const exported = await fullExport(runtime, ++generation.value);
    full.push(exported.durationMs);
    collectProfileGarbage();
  }
  const incremental: number[] = [];
  for (let sample = 0; sample < INCREMENTAL_EXPORT_SAMPLES_PER_RUN; sample += 1) {
    const baseRevision = sample + 1;
    const modelRevision = baseRevision + 1;
    const exported = await incrementalExport(
      runtime,
      ++generation.value,
      baseRevision,
      modelRevision,
    );
    incremental.push(exported.durationMs);
    collectProfileGarbage();
  }
  const orderOnly: number[] = [];
  const originalOrder = snapshot.elements.map(({ id }) => id);
  const reversedOrder = [...originalOrder].reverse();
  for (let sample = 0; sample < ORDER_ONLY_EXPORT_SAMPLES_PER_RUN; sample += 1) {
    const baseRevision = snapshot.revision + INCREMENTAL_EXPORT_SAMPLES_PER_RUN + sample;
    const exported = await orderOnlyExport(
      runtime,
      ++generation.value,
      baseRevision,
      baseRevision + 1,
      sample % 2 === 0 ? reversedOrder : originalOrder,
    );
    orderOnly.push(exported.durationMs);
    collectProfileGarbage();
  }
  return { full, incremental, orderOnly };
}

function serializeFixture() {
  return measure(() => serializeInkbookDocument(snapshot, { hash: () => "fixture-hash" }));
}

function copyString(value: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(value));
}

function requireSerialized(result: ReturnType<typeof serializeInkbookDocument>) {
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.validationError?.path ?? "output"}: ${result.error.message}`,
    );
  }
  return result.value;
}

async function exactBaseSave(base: string, next: string, outputHash: string): Promise<number> {
  const currentCopy = copyString(base);
  let persisted = base;
  let callbackDuration = Number.POSITIVE_INFINITY;
  const save = await saveExistingFile(
    {
      expectedBase: base,
      output: next,
      outputHash,
      path: "fixture.svg",
      revision: 2,
    },
    { currentRevision: () => 2 },
    {
      process: async (_path, update) => {
        const callback = measure(() => update(currentCopy));
        callbackDuration = callback.durationMs;
        persisted = callback.value;
        return persisted;
      },
      readWithMetadataGuard: async (path) => {
        const size = new TextEncoder().encode(persisted).byteLength;
        return {
          content: persisted,
          identity: { ctime: 1, mtime: 1, path, size },
          materialization: "host-full-read-not-bounded" as const,
          stabilityEvidence: "object-identity-and-stat-unchanged" as const,
        };
      },
    },
    {
      verify: async (content, revision, hash) =>
        content === next && revision === 2 && hash === outputHash,
    },
  );
  expect(save.revision).toBe(2);
  return callbackDuration;
}

async function fullExport(
  runtime: DocumentWorkerRuntime,
  exportGeneration: number,
): Promise<{ durationMs: number }> {
  return executeMeasuredExport(runtime, {
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
): Promise<{ durationMs: number }> {
  const changed = replaceFirstStroke(snapshot, modelRevision);
  const bounds = calculateElementBounds(changed);
  const spatialMemberships = spatialCellMembershipCount(bounds);
  const spatialOverflow = spatialMemberships > MAX_ELEMENT_CELLS;
  return executeMeasuredExport(runtime, {
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
): Promise<{ durationMs: number }> {
  return executeMeasuredExport(runtime, {
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

async function executeMeasuredExport(
  runtime: DocumentWorkerRuntime,
  request: ExportRequest,
): Promise<{ durationMs: number }> {
  let measured = await measureAsync(() => runtime.execute(request));
  const durationMs = measured.durationMs;
  const identity = exportIdentity(requireExportSuccess(measured.value));
  measured = null as never;
  await acknowledgeAndPrewarm(runtime, identity);
  return { durationMs };
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
        points[target + 4] = element.points[index + 1]!;
        points[target + 5] = element.points[index + 2]!;
      }
      return { ...element, points };
    }),
  };
}
