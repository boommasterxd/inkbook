import { expect, it } from "vitest";
import { runVaultRecoveryExport } from "../../../../src/obsidian/embeds/vault-recovery-export";
import { restoreWorkerBaseline } from "../../../../src/obsidian/embeds/vault-document-recovery";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";

it("closes native wire receipts while retaining decoded recovery output", async () => {
  const harness = createWorkerBridgeHarness();
  const executor = createWorkerBridgeClient(harness.clientEndpoint);
  try {
    const result = await runVaultRecoveryExport(executor, {
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      sessionId: "session-a",
      snapshot: createWorkerSnapshot([]),
      type: "export-full",
      workerEpoch: 1,
    });
    expect(result.type).toBe("export-success");
    if (result.type !== "export-success") throw new Error("Recovery export failed.");
    expect(result.output).toEqual(expect.stringContaining("<svg"));
    expect(harness.runtime.instrumentation.unacknowledgedExports).toBe(0);
    expect(harness.clientEndpoint.sentMessages).toContainEqual({
      accepted: false,
      exportGeneration: 1,
      modelRevision: 0,
      requestId: 1,
      sessionId: "session-a",
      type: "inkbook-worker-export-acknowledgement",
      workerEpoch: 1,
    });
    const acknowledgements = harness.clientEndpoint.sentMessages.length;
    executor.terminate();
    expect(harness.clientEndpoint.sentMessages).toHaveLength(acknowledgements);
  } finally {
    executor.terminate();
    harness.detach();
  }
});

it("closes unused baseline exports on a retained runtime", async () => {
  const executor = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
  try {
    await restoreWorkerBaseline({
      executor,
      identity: { documentId: "drawings/ink.svg", sessionId: "session-a" },
      revision: 0,
      snapshot: createWorkerSnapshot([]),
      workerEpoch: 1,
    });
    expect(executor.instrumentation.unacknowledgedExports).toBe(0);
    const verified = await executor.execute({
      basisRevision: 0,
      identity: { operationId: 1, purpose: "clipboard", sessionId: "session-a", workerEpoch: 1 },
      selectedIds: [],
      type: "clipboard-encode",
    });
    expect(verified.type).toBe("clipboard-encode-success");
  } finally {
    executor.terminate();
  }
});
