import { describe, expect, it } from "vitest";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";

import { ChunkedInputCancelledError } from "../../../../../src/persistence/serialization/chunked-input-types";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../src/persistence/worker/runtime/public";
import { createProductionDocumentRuntime } from "../../../../../src/persistence/worker/runtime/production-document-runtime";
import type { DocumentRuntimePort } from "../../../../../src/persistence/worker/runtime/types";
import { isDocumentRuntimeWireResult } from "../../../../../src/persistence/worker/runtime/wire-codec";

import { rectangle, snapshot } from "./fixtures";

const EXECUTOR = { sessionId: "migration-session", workerEpoch: 1 } as const;
const UNLOCK_IDENTITY = { ...EXECUTOR, operationId: 1, purpose: "unlock" as const };

function versionZeroDocument(): string {
  const serialized = serializeInkbookDocument(snapshot());
  if (!serialized.ok) throw new Error(serialized.error.code);
  return serialized.value.svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0');
}

function versionZeroDocumentWithInvalidSecondElement(): string {
  const secondId = "00000000-0000-4000-8000-000000000002";
  const serialized = serializeInkbookDocument({
    ...snapshot(),
    elements: [rectangle(), { ...rectangle(300), id: secondId }],
  });
  if (!serialized.ok) throw new Error(serialized.error.code);
  return serialized.value.svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0')
    .replace(secondId, "invalid-id");
}

async function expectRuntimeMigrationCancellation(
  createRuntime: (onYield: () => void) => DocumentRuntimePort,
): Promise<void> {
  let runtime: DocumentRuntimePort;
  let yields = 0;
  runtime = createRuntime(() => {
    yields += 1;
    if (yields === 2) runtime.terminate();
  });

  const pending = runtime.execute({
    identity: UNLOCK_IDENTITY,
    input: versionZeroDocumentWithInvalidSecondElement(),
    type: "unlock",
  });

  await expect(pending).rejects.toThrow("terminated");
  expect(yields).toBe(2);
}

describe("document runtime migration", () => {
  it("requires a bounded source version on worker unlock results", () => {
    expect(
      isDocumentRuntimeWireResult({
        lockedHeight: 348.6,
        requiresCanonicalRewrite: false,
        sourceVersion: 0,
        type: "unlock-success",
      }),
    ).toBe(true);
    expect(isDocumentRuntimeWireResult({ sourceVersion: 0, type: "unlock-success" })).toBe(false);
    expect(
      isDocumentRuntimeWireResult({
        lockedHeight: 348.6,
        requiresCanonicalRewrite: false,
        sourceVersion: 2,
        type: "unlock-success",
      }),
    ).toBe(false);
  });
  it("adopts only the fully migrated version in worker and fallback paths", async () => {
    const input = versionZeroDocument();
    const direct = await new DocumentModelRuntime().unlock(input);
    const controller = new AbortController();
    const checkpoints: number[] = [];
    const sliced = await new DocumentModelRuntime().unlock(input, {
      checkpoint: () => {
        checkpoints.push(checkpoints.length + 1);
        return Promise.resolve();
      },
      signal: controller.signal,
    });

    expect(direct).toMatchObject({ snapshot: { version: 1 }, sourceVersion: 0 });
    expect(sliced).toEqual(direct);
    expect(checkpoints.length).toBeGreaterThan(0);
  });

  it("does not adopt a cancelled migration result", async () => {
    const runtime = new DocumentModelRuntime();
    const controller = new AbortController();

    await expect(
      runtime.unlock(versionZeroDocument(), {
        checkpoint: () => {
          controller.abort();
          return Promise.resolve();
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(runtime.modelRevision).toBeNull();
  });

  it("cancels sliced v0 validation before reaching a malformed later element", async () => {
    const runtime = new DocumentModelRuntime();
    const controller = new AbortController();
    let checkpoints = 0;

    await expect(
      runtime.unlock(versionZeroDocumentWithInvalidSecondElement(), {
        checkpoint: () => {
          checkpoints += 1;
          if (checkpoints === 2) controller.abort();
          return Promise.resolve();
        },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ChunkedInputCancelledError);
    expect(checkpoints).toBe(2);
    expect(runtime.modelRevision).toBeNull();
  });
});

describe("runtime migration cancellation", () => {
  it("cancels v0 validation slices in production-worker scheduling", async () => {
    let now = 0;
    await expectRuntimeMigrationCancellation((onYield) =>
      createProductionDocumentRuntime(EXECUTOR, {
        workScheduler: createTestWorkScheduler({
          now: () => (now += 9),
          checkpoint: async () => onYield(),
        }),
      }),
    );
  });

  it("cancels v0 validation slices in the main-thread fallback", async () => {
    let now = 0;
    await expectRuntimeMigrationCancellation(
      (onYield) =>
        new DocumentWorkerRuntime(
          EXECUTOR,
          new GestureAwareSliceScheduler({
            isInputActive: () => false,
            workScheduler: createTestWorkScheduler({
              now: () => (now += 9),
              checkpoint: async () => onYield(),
            }),
          }),
        ),
    );
  });
});
