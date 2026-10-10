import { expect, it, vi } from "vitest";
import { runVaultRecoveryOperation } from "../../../../src/obsidian/embeds/vault-recovery-executor";
import type { DocumentRuntimePort } from "../../../../src/persistence/worker/runtime/public";

function harness() {
  const execute = vi.fn<DocumentRuntimePort["execute"]>();
  const executor = { execute, terminate: vi.fn() };
  let workerEpoch = 1;
  const access = {
    current: () => ({ executor, workerEpoch }),
    recover: vi.fn(async () => {
      workerEpoch += 1;
      return true;
    }),
  };
  const run = (port: DocumentRuntimePort, epoch: number) =>
    port.execute({
      identity: { operationId: 1, purpose: "recovery", sessionId: "session-1", workerEpoch: epoch },
      input: "svg",
      type: "verify-output",
    });
  return { execute, access, run };
}

it("bounds executor retries to the native replacement and fallback", async () => {
  const fixture = harness();
  fixture.execute.mockRejectedValue(new Error("terminal executor"));
  expect(await runVaultRecoveryOperation({ ...fixture, stopped: () => false })).toBeUndefined();
  expect(fixture.execute).toHaveBeenCalledTimes(3);
  expect(fixture.access.recover).toHaveBeenCalledTimes(2);
  expect(
    fixture.execute.mock.calls.map(
      ([request]) => "identity" in request && request.identity.workerEpoch,
    ),
  ).toEqual([1, 2, 3]);
});

it("does not replace an executor for a typed operation failure or host exception", async () => {
  const fixture = harness();
  const result = {
    type: "runtime-failure" as const,
    code: "queue-full",
    retryable: true,
    identity: {
      operationId: 1,
      purpose: "recovery" as const,
      sessionId: "session-1",
      workerEpoch: 1,
    },
  };
  fixture.execute.mockResolvedValue(result);
  expect(await runVaultRecoveryOperation({ ...fixture, stopped: () => false })).toBe(result);
  await expect(
    runVaultRecoveryOperation({
      ...fixture,
      stopped: () => false,
      run: () => Promise.reject(new Error("host failure")),
    }),
  ).rejects.toThrow("host failure");
  expect(fixture.access.recover).not.toHaveBeenCalled();
});

it.each(["before", "during"])("stops cancelled recovery %s replacement", async (timing) => {
  const fixture = harness();
  let stopped = false;
  fixture.execute.mockImplementation(async () => {
    if (timing === "before") stopped = true;
    throw new Error("terminal executor");
  });
  fixture.access.recover.mockImplementation(async () => {
    stopped = true;
    return true;
  });
  expect(await runVaultRecoveryOperation({ ...fixture, stopped: () => stopped })).toBeUndefined();
  expect(fixture.execute).toHaveBeenCalledOnce();
  expect(fixture.access.recover).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
});

it("stops when the session cannot recover or no longer owns an executor", async () => {
  const fixture = harness();
  fixture.execute.mockRejectedValue(new Error("terminal executor"));
  fixture.access.recover.mockResolvedValue(false);
  expect(await runVaultRecoveryOperation({ ...fixture, stopped: () => false })).toBeUndefined();
  expect(fixture.execute).toHaveBeenCalledOnce();
  expect(
    await runVaultRecoveryOperation({
      ...fixture,
      stopped: () => false,
      access: { ...fixture.access, current: () => undefined },
    }),
  ).toBeUndefined();
  expect(fixture.execute).toHaveBeenCalledOnce();
});

it("rejects a successful result after another operation replaces its executor epoch", async () => {
  const fixture = harness();
  fixture.execute.mockImplementation(async () => {
    await fixture.access.recover();
    return {
      type: "verify-output-success",
      identity: {
        operationId: 1,
        purpose: "recovery",
        sessionId: "session-1",
        workerEpoch: 1,
      },
      persisted: { type: "missing" },
    };
  });
  expect(await runVaultRecoveryOperation({ ...fixture, stopped: () => false })).toBeUndefined();
  expect(fixture.execute).toHaveBeenCalledOnce();
});
