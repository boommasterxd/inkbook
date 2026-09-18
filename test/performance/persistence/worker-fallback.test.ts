import { describe, expect, it } from "vitest";

import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
  type DocumentRuntimePort,
  type DocumentRuntimeRequest,
} from "../../../src/persistence/worker/runtime/public";
import { createStandardPersistenceFixture } from "./fixtures";
import { FallbackSliceProbe } from "../../fixtures/persistence/fallback-slice-probe";
import { createFallbackDeadlineClock } from "./fallback-deadline-clock";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
type MetricAnnotator = (message: string, type?: string) => Promise<unknown>;

const snapshot = createFallbackFixture();
const serialized = requireSerialized();

describe("worker failure fallback performance", () => {
  it("bounds validation, migration, clipboard, export, hashing, preflight, and read-back slices", async ({
    annotate,
  }) => {
    await expectWorkerFailure();
    const { probe, runtime } = createScheduledFallback();
    try {
      await runMigrationValidation(runtime, probe);
      await runClipboardRoundtrip(runtime, probe);
      const output = await runExportAndHash(runtime, probe);
      await runPersistedOutputVerification(runtime, probe, output);
      await assertFallbackMeasurements(probe, annotate);
    } finally {
      runtime.terminate();
    }
  }, 120_000);
});

async function expectWorkerFailure(): Promise<void> {
  const failedWorker = new FailingWorker();
  await expect(
    failedWorker.execute({
      identity: { operationId: 1, purpose: "unlock", sessionId: "fallback", workerEpoch: 1 },
      input: serialized.svg,
      type: "unlock",
    }),
  ).rejects.toThrow("worker failed");
  failedWorker.terminate();
}

function createScheduledFallback(): {
  readonly probe: FallbackSliceProbe;
  readonly runtime: DocumentWorkerRuntime;
} {
  const probe = new FallbackSliceProbe();
  const scheduler = new GestureAwareSliceScheduler({
    isInputActive: probe.isInputActive,
    now: createFallbackDeadlineClock(),
    sliceMilliseconds: INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
    yieldControl: probe.yieldControl,
  });
  return {
    probe,
    runtime: new DocumentWorkerRuntime({ sessionId: "fallback", workerEpoch: 2 }, scheduler),
  };
}

async function runMigrationValidation(
  runtime: DocumentWorkerRuntime,
  probe: FallbackSliceProbe,
): Promise<void> {
  const migrated = serialized.svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0');
  probe.startOperation("migration-validation");
  const result = await runtime.execute({
    identity: { operationId: 1, purpose: "migration", sessionId: "fallback", workerEpoch: 2 },
    input: migrated,
    type: "unlock",
  });
  probe.finishOperation();
  expect(result).toMatchObject({ sourceVersion: 0, type: "unlock-success" });
}

async function runClipboardRoundtrip(
  runtime: DocumentWorkerRuntime,
  probe: FallbackSliceProbe,
): Promise<void> {
  const identity = {
    operationId: 1,
    purpose: "clipboard" as const,
    sessionId: "fallback",
    workerEpoch: 2,
  };
  probe.startOperation("clipboard-encode");
  const encoded = await runtime.execute({
    basisRevision: snapshot.revision,
    identity,
    selectedIds: snapshot.elements.slice(0, 100).map(({ id }) => id),
    type: "clipboard-encode",
  });
  probe.finishOperation();
  if (encoded.type !== "clipboard-encode-success" || !encoded.result.ok) {
    throw new Error("Fallback clipboard encoding failed.");
  }
  probe.startOperation("clipboard-decode");
  const decoded = await runtime.execute({
    basisRevision: snapshot.revision,
    candidates: { customText: encoded.result.value.customText },
    identity: { ...identity, operationId: 2 },
    type: "clipboard-decode",
  });
  probe.finishOperation();
  expect(decoded).toMatchObject({ result: { ok: true }, type: "clipboard-decode-success" });
}

async function runExportAndHash(
  runtime: DocumentWorkerRuntime,
  probe: FallbackSliceProbe,
): Promise<string | Uint8Array> {
  probe.startOperation("export-hash");
  const exported = await runtime.execute({
    baseModelRevision: snapshot.revision,
    exportGeneration: 1,
    modelRevision: snapshot.revision,
    sessionId: "fallback",
    type: "export-incremental",
    workerEpoch: 2,
  });
  probe.finishOperation();
  if (exported.type !== "export-success") throw new Error("Fallback export failed.");
  return exported.output;
}

async function runPersistedOutputVerification(
  runtime: DocumentWorkerRuntime,
  probe: FallbackSliceProbe,
  output: string | Uint8Array,
): Promise<void> {
  for (const purpose of ["preflight", "read-back"] as const) {
    probe.startOperation(purpose);
    const verified = await runtime.execute({
      identity: { operationId: 1, purpose, sessionId: "fallback", workerEpoch: 2 },
      input: output,
      type: "verify-output",
    });
    probe.finishOperation();
    expect(verified).toMatchObject({
      persisted: { type: "confirmed" },
      type: "verify-output-success",
    });
  }
}

async function assertFallbackMeasurements(
  probe: FallbackSliceProbe,
  annotate: MetricAnnotator,
): Promise<void> {
  for (const [name, measurement] of probe.operations) {
    expect(measurement.yields).toBeGreaterThanOrEqual(measurement.inputPauseYields);
    await annotate(
      `fallback ${name} live input: samples=${measurement.syntheticInputSamples}, ` +
        `pauseYields=${measurement.inputPauseYields}`,
      "performance",
    );
    expect(measurement.syntheticInputSamples).toBeGreaterThanOrEqual(2);
    expect(measurement.inputPauseYields).toBeGreaterThanOrEqual(2);
  }
  expect([...probe.operations.keys()]).toEqual([
    "migration-validation",
    "clipboard-encode",
    "clipboard-decode",
    "export-hash",
    "preflight",
    "read-back",
  ]);
  expect(probe.yields).toBeGreaterThanOrEqual(100);
}

class FailingWorker implements DocumentRuntimePort {
  public execute(_request: DocumentRuntimeRequest): Promise<never> {
    return Promise.reject(new Error("worker failed"));
  }

  public terminate(): void {}
}

function requireSerialized() {
  const result = serializeInkbookDocument(snapshot);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function createFallbackFixture() {
  const standard = createStandardPersistenceFixture();
  return { ...standard, elements: standard.elements.slice(10_000, 10_257) };
}
