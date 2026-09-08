import { describe, expect, it } from "vitest";

import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
} from "../../../../src/persistence/worker/runtime/public";
import {
  createReadOnlyVaultSession,
  documentFromSnapshot,
  emptySnapshot,
  operation,
  rectangle,
} from "./vault-session-fixtures";

describe("vault-backed unlock integrity", () => {
  it("rejects reordered worker batches and publishes only a verified fallback Store", async () => {
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
    const { factory, session } = createReadOnlyVaultSession(document, createReorderingRuntime);

    await expect(session.unlock(operation())).resolves.toMatchObject({
      status: "active",
      workerEpoch: 2,
    });
    expect(factory.getDocumentModel("session-1")?.store.materializeBandOrder("content")).toEqual([
      rectangle().id,
      second.id,
    ]);
  });
});

async function createReorderingRuntime(
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
                    derivations: [...batch.derivations].reverse(),
                    elements: [...batch.elements].reverse(),
                  },
                  signal,
                ),
            },
      ),
    terminate: () => runtime.terminate(),
  };
}
