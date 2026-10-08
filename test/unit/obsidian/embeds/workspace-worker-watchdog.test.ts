import { afterEach, expect, it, vi } from "vitest";

import { createWorkspaceDocumentRuntimes } from "../../../../src/obsidian/embeds/workspace-runtime-workers";
import * as documentRuntime from "../../../../src/persistence/worker/runtime/public";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/worker-bridge";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const request = {
  identity: {
    sessionId: "session",
    workerEpoch: 1,
    operationId: 1,
    purpose: "verification" as const,
  },
  input: "private-document-content",
  type: "verify-output" as const,
};

function presentationWindow() {
  const pluginTimers = { setTimeout, clearTimeout };
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const ownerWindow = {
    performance: { now: () => (closed ? -50_000 : performance.now()) },
    setTimeout: vi.fn((callback: () => void, milliseconds: number) => {
      if (closed) return 0;
      const timer = pluginTimers.setTimeout(callback, milliseconds);
      timers.add(timer);
      return timer;
    }),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer);
      pluginTimers.clearTimeout(timer);
    },
  } as unknown as Window;
  return {
    ownerWindow,
    close: () => {
      closed = true;
      for (const timer of timers) pluginTimers.clearTimeout(timer);
      timers.clear();
    },
  };
}

async function workspaceWorkerHarness() {
  const first = presentationWindow();
  const second = presentationWindow();
  const firstScheduler = new TestWorkScheduler();
  const secondScheduler = new TestWorkScheduler();
  let owner = first.ownerWindow;
  const endpoint = new TestWorkerEndpoint();
  const warn = vi.fn();
  vi.spyOn(documentRuntime, "createDocumentRuntime").mockImplementation(
    async (_sessionId, _epoch, _window, options) =>
      new WorkerDocumentRuntimePort(() => endpoint, options),
  );
  const runtimes = createWorkspaceDocumentRuntimes({
    owningWindow: () => owner,
    fallbackWindow: () => owner,
    workScheduler: (window) => (window === first.ownerWindow ? firstScheduler : secondScheduler),
    subscribeSchedulingProfile: () => () => undefined,
    warn,
  });
  const client = await runtimes.create("session", 1, "private-document.svg");
  return {
    client,
    endpoint,
    warn,
    secondScheduler,
    transferAndClose: () => {
      owner = second.ownerWindow;
      first.close();
    },
    cleanup: () => {
      client.terminate();
      first.close();
      second.close();
    },
  };
}

it.each(["in-flight", "after-transfer"] as const)(
  "keeps the %s watchdog effective after the original presentation window closes",
  async (phase) => {
    vi.useFakeTimers();
    const h = await workspaceWorkerHarness();
    const admission = vi.spyOn(h.secondScheduler, "checkpoint");
    try {
      if (phase === "after-transfer") h.transferAndClose();
      const pending = h.client.execute(request).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      if (phase === "in-flight") {
        h.client.setNavigationActive?.(true);
        h.transferAndClose();
        await vi.advanceTimersByTimeAsync(50_000);
        expect(h.endpoint.terminated).toBe(false);
        h.client.setNavigationActive?.(false);
      } else {
        expect(admission).toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(19_999);
      expect(h.endpoint.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.endpoint.terminated).toBe(true);
      expect(await pending).toEqual(new Error("Document worker request timed out."));
      expect(h.warn).toHaveBeenCalledOnce();
      expect(h.warn.mock.calls[0]?.[1]).toContain(
        "phase=timeout; kind=timeout; request=verify-output",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.cleanup();
    }
  },
);

it("releases a transferred request timer when its retained session terminates", async () => {
  vi.useFakeTimers();
  const h = await workspaceWorkerHarness();
  try {
    const pending = h.client.execute(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    h.transferAndClose();
    expect(vi.getTimerCount()).toBe(1);
    h.cleanup();
    expect(await pending).toEqual(new Error("Document worker failed."));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.warn).not.toHaveBeenCalled();
  } finally {
    h.cleanup();
  }
});

it("warns with a safe native exception name without error content", async () => {
  vi.useFakeTimers();
  const subscribe = vi.spyOn(TestWorkerEndpoint.prototype, "addEventListener");
  const h = await workspaceWorkerHarness();
  try {
    const pending = h.client.execute(request).catch((error: unknown) => error);
    const errorHandler = subscribe.mock.calls.find(([type]) => type === "error")![1] as (
      event: unknown,
    ) => void;
    errorHandler({
      error: { name: "SyntaxError", message: "private-document-content" },
      filename: "private-document.svg",
    });
    expect(await pending).toEqual(new Error("Document worker failed."));
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.warn.mock.calls[0]?.[1]).toContain("phase=worker-event");
    expect(h.warn.mock.calls[0]?.[1]).toContain("error=SyntaxError");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("private-document");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    h.cleanup();
  }
});
