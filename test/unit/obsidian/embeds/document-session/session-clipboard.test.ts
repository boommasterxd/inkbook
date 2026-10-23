import { describe, expect, it, vi } from "vitest";

import { SessionClipboardCoordinator } from "../../../../../src/obsidian/embeds/document-session/session-clipboard";
import type { PurposeOperationIdentity } from "../../../../../src/persistence/worker/protocol";
import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
} from "../../../../../src/persistence/worker/runtime/public";

const payload = { byteLength: 4, customText: "ink", plainText: "ink" } as const;

function executor(
  execute: (request: DocumentRuntimeRequest) => Promise<DocumentRuntimeResult>,
): DocumentRuntimePort {
  return { execute, terminate: vi.fn() };
}

function encodeSuccess(request: DocumentRuntimeRequest): DocumentRuntimeResult {
  return {
    identity: clipboardIdentity(request),
    result: { ok: true, value: payload },
    type: "clipboard-encode-success",
  };
}

function clipboardIdentity(request: DocumentRuntimeRequest): PurposeOperationIdentity {
  if (request.type !== "clipboard-encode") throw new Error("Expected clipboard encoding.");
  return request.identity;
}

function createHarness(run: (request: DocumentRuntimeRequest) => Promise<DocumentRuntimeResult>) {
  let disposed = false;
  let epoch = 1;
  let revision = 7;
  let activeExecutor = executor(run);
  const synchronize = vi.fn(async () => true);
  const recover = vi.fn(() => false);
  const coordinator = new SessionClipboardCoordinator({
    disposed: () => disposed,
    executor: () => activeExecutor,
    now: () => 1,
    recoverExecutorFailure: recover,
    revision: () => revision,
    sessionId: "session-a",
    synchronizeWorkerBaseline: synchronize,
    workerEpoch: () => epoch,
  });
  return {
    coordinator,
    recover,
    setDisposed: (value: boolean) => {
      disposed = value;
    },
    setExecutor: (value: DocumentRuntimePort) => {
      activeExecutor = value;
    },
    setRevision: (value: number) => {
      revision = value;
    },
    switchEpoch: () => {
      epoch += 1;
    },
    synchronize,
  };
}

describe("SessionClipboardCoordinator result adoption", () => {
  it.each([
    {
      mutate: (harness: ReturnType<typeof createHarness>) => harness.setDisposed(true),
      name: "disposed session",
    },
    {
      mutate: (harness: ReturnType<typeof createHarness>) => harness.setRevision(8),
      name: "stale revision",
    },
    {
      mutate: (harness: ReturnType<typeof createHarness>) => harness.switchEpoch(),
      name: "stale worker epoch",
    },
  ])("rejects a successful result for a $name", async ({ mutate }) => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness(async (request) => {
      mutate(harness);
      return encodeSuccess(request);
    });

    await expect(harness.coordinator.encode(new Set(["element-a"]))).resolves.toBeNull();
  });

  it("rejects a stale operation identity without partial adoption", async () => {
    const harness = createHarness(async (request) => {
      const identity = clipboardIdentity(request);
      return {
        identity: { ...identity, operationId: identity.operationId + 1 },
        result: { ok: true, value: payload },
        type: "clipboard-encode-success",
      };
    });

    await expect(harness.coordinator.encode(new Set(["element-a"]))).resolves.toBeNull();
  });
});

describe("SessionClipboardCoordinator executor recovery", () => {
  it("changes epoch and purpose identity before its single retry", async () => {
    const identities: PurposeOperationIdentity[] = [];
    const harness = createHarness(async (request) => {
      identities.push(clipboardIdentity(request));
      throw new Error("primary crashed");
    });
    const fallback = executor(async (request) => {
      identities.push(clipboardIdentity(request));
      return encodeSuccess(request);
    });
    harness.recover.mockImplementation(() => {
      harness.switchEpoch();
      harness.setExecutor(fallback);
      return true;
    });

    await expect(harness.coordinator.encode(new Set(["element-a"]))).resolves.toEqual(payload);
    expect(identities).toEqual([
      expect.objectContaining({ operationId: 1, workerEpoch: 1 }),
      expect.objectContaining({ operationId: 2, workerEpoch: 2 }),
    ]);
    expect(harness.synchronize).toHaveBeenCalledTimes(2);
  });

  it("does not attempt a second recovery after the fallback fails", async () => {
    const execute = vi.fn(async () => Promise.reject(new Error("executor crashed")));
    const harness = createHarness(execute);
    harness.recover.mockImplementation(() => {
      harness.switchEpoch();
      return true;
    });

    await expect(harness.coordinator.encode(new Set(["element-a"]))).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(harness.recover).toHaveBeenCalledOnce();
  });
});
