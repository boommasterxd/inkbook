import { describe, expect, it } from "vitest";

import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
} from "../../../../../src/persistence/worker/runtime/public";
import {
  createReadOnlyVaultSession,
  documentFromSnapshot,
  emptySnapshot,
  operation,
  rectangle,
} from "./vault-session-fixtures";

describe("vault-backed unlock integrity", () => {
  it("rejects an out-of-sequence worker batch without publishing the detached Store", async () => {
    const second = {
      ...rectangle(),
      id: "00000000-0000-4000-8000-000000000002",
      pivot: { x: 340, y: 140 },
      x: 300,
    };
    const document = documentFromSnapshot({
      ...emptySnapshot(),
      elements: [rectangle(), second],
    });
    const { factory, session } = createReadOnlyVaultSession(document, createOutOfSequenceRuntime);

    await expect(session.unlock(operation())).resolves.toMatchObject({
      status: "load-error",
      workerEpoch: 1,
    });
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
  });
});

async function createOutOfSequenceRuntime(
  sessionId: string,
  workerEpoch: number,
): Promise<DocumentRuntimePort> {
  const runtime = new DocumentWorkerRuntime({ sessionId, workerEpoch });
  return {
    execute: (request, observer) =>
      runtime.execute(
        request,
        observer === undefined
          ? undefined
          : {
              unlockBatch: (batch, signal) =>
                observer.unlockBatch(
                  {
                    ...batch,
                    batchIndex: batch.batchIndex + 1,
                  },
                  signal,
                ),
            },
      ),
    terminate: () => runtime.terminate(),
  };
}
