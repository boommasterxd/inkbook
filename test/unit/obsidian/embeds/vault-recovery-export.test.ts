import { expect, it, vi } from "vitest";
import { runVaultRecoveryExport } from "../../../../src/obsidian/embeds/vault-recovery-export";
import { runVaultRecoveryOperation } from "../../../../src/obsidian/embeds/vault-recovery-executor";
import { deriveDocumentIntegrityManifest } from "../../../../src/persistence/serialization/public";
import type { DocumentRuntimePort } from "../../../../src/persistence/worker/runtime/public";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";

const request = {
  baseModelRevision: null,
  exportGeneration: 1,
  modelRevision: 0,
  sessionId: "session-a",
  snapshot: createWorkerSnapshot([]),
  type: "export-full" as const,
  workerEpoch: 1,
};
const exported = {
  exportGeneration: request.exportGeneration,
  integrityManifest: deriveDocumentIntegrityManifest(request.snapshot),
  modelRevision: request.modelRevision,
  output: "caller-owned SVG",
  outputHash: "output-hash",
  sessionId: request.sessionId,
  totalBytes: 16,
  type: "export-success" as const,
  workerEpoch: request.workerEpoch,
};

it("closes successful receipts before downstream validation rejects the output", async () => {
  const acknowledgeExport = vi.fn();
  const executor = {
    acknowledgeExport,
    execute: vi.fn<DocumentRuntimePort["execute"]>().mockResolvedValue(exported),
    terminate: vi.fn(),
  };
  await expect(
    runVaultRecoveryOperation({
      access: { current: () => ({ executor, workerEpoch: 1 }), recover: vi.fn() },
      run: async (port) => {
        expect(await runVaultRecoveryExport(port, request)).toBe(exported);
        expect(acknowledgeExport).toHaveBeenCalledExactlyOnceWith(exported, false);
        throw new Error("invalid recovery manifest");
      },
      stopped: () => false,
    }),
  ).rejects.toThrow("invalid recovery manifest");
});

it.each(["cancelled", "replaced"])(
  "closes a %s export on its originating executor",
  async (change) => {
    const originalAck = vi.fn();
    const replacementAck = vi.fn();
    let stopped = false;
    const original: DocumentRuntimePort = {
      acknowledgeExport: originalAck,
      execute: async () => {
        if (change === "cancelled") stopped = true;
        else current = { executor: replacement, workerEpoch: 2 };
        return exported;
      },
      terminate: vi.fn(),
    };
    const replacement: DocumentRuntimePort = {
      acknowledgeExport: replacementAck,
      execute: vi.fn(),
      terminate: vi.fn(),
    };
    let current = { executor: original, workerEpoch: 1 };
    expect(
      await runVaultRecoveryOperation({
        access: { current: () => current, recover: vi.fn() },
        run: (port) => runVaultRecoveryExport(port, request),
        stopped: () => stopped,
      }),
    ).toBeUndefined();
    expect(originalAck).toHaveBeenCalledExactlyOnceWith(exported, false);
    expect(replacementAck).not.toHaveBeenCalled();
  },
);

it("retries an executor rejection and closes only the replacement's receipt", async () => {
  const originalAck = vi.fn();
  const original = {
    acknowledgeExport: originalAck,
    execute: vi.fn<DocumentRuntimePort["execute"]>().mockRejectedValue(new Error("worker lost")),
    terminate: vi.fn(),
  };
  const replacementAck = vi.fn();
  const replacement = {
    acknowledgeExport: replacementAck,
    execute: vi
      .fn<DocumentRuntimePort["execute"]>()
      .mockResolvedValue({ ...exported, workerEpoch: 2 }),
    terminate: vi.fn(),
  };
  let current: { executor: DocumentRuntimePort; workerEpoch: number } = {
    executor: original,
    workerEpoch: 1,
  };
  const result = await runVaultRecoveryOperation({
    access: {
      current: () => current,
      recover: async () => {
        current = { executor: replacement, workerEpoch: 2 };
        return true;
      },
    },
    run: (port, workerEpoch) => runVaultRecoveryExport(port, { ...request, workerEpoch }),
    stopped: () => false,
  });
  expect(result).toMatchObject({ type: "export-success", workerEpoch: 2 });
  expect(originalAck).not.toHaveBeenCalled();
  expect(replacementAck).toHaveBeenCalledExactlyOnceWith(result, false);
});

it("preserves typed export failures without acknowledging them", async () => {
  const failure = {
    exportGeneration: 1,
    modelRevision: 0,
    sessionId: "session-a",
    workerEpoch: 1,
    type: "export-failure" as const,
    error: { code: "invalid-snapshot", retryable: false },
  };
  const acknowledgeExport = vi.fn();
  const executor = {
    acknowledgeExport,
    execute: vi.fn<DocumentRuntimePort["execute"]>().mockResolvedValue(failure),
    terminate: vi.fn(),
  };
  expect(await runVaultRecoveryExport(executor, request)).toBe(failure);
  expect(acknowledgeExport).not.toHaveBeenCalled();
});

it("supports an executor without optional export acknowledgements", async () => {
  const executor = {
    execute: vi.fn<DocumentRuntimePort["execute"]>().mockResolvedValue(exported),
    terminate: vi.fn(),
  };
  expect(await runVaultRecoveryExport(executor, request)).toBe(exported);
});
