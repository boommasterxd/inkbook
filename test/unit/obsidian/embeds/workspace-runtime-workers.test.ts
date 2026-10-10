import { describe, expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { SchedulerDisposedError } from "../../../../src/domain/scheduling/work-scheduler";
import { createWorkspaceDocumentRuntimes } from "../../../../src/obsidian/embeds/workspace-runtime-workers";
import * as documentRuntime from "../../../../src/persistence/worker/runtime/public";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

function windowHarness() {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const warn = vi.fn();
  const ownerWindow = {
    console: { warn },
    performance: { now: () => host.time, timeOrigin: 1_000 },
    setTimeout: vi.fn(),
  } as unknown as Window;
  return { host, ownerWindow, scheduler, warn };
}

function runtimePorts(fixture: ReturnType<typeof windowHarness>) {
  return {
    fallbackWindow: () => fixture.ownerWindow,
    owningWindow: () => fixture.ownerWindow,
    subscribeSchedulingProfile: () => () => undefined,
    workScheduler: () => fixture.scheduler,
  };
}

function documentTransferHarness() {
  const first = windowHarness();
  const second = windowHarness();
  let owner = first;
  const runtimes = createWorkspaceDocumentRuntimes({
    ...runtimePorts(first),
    owningWindow: () => owner.ownerWindow,
    workScheduler: (window) => (window === first.ownerWindow ? first.scheduler : second.scheduler),
  });
  return {
    first,
    second,
    runtimes,
    documentScheduler: runtimes.workScheduler("drawing.svg"),
    moveToSecond: () => {
      owner = second;
    },
  };
}

describe("workspace document runtime scheduling", () => {
  it("continues pure store quanta within budget and waits once when it is exhausted", async () => {
    const fixture = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes(runtimePorts(fixture));
    const store = runtimes.createStoreScheduler("drawing.svg", () => false);
    const terminalStore = runtimes.createStoreScheduler("drawing.svg", () => false, "frame");

    for (let quantum = 0; quantum < 8; quantum += 1) {
      await store.yieldControl();
    }
    expect(fixture.host.frameRequests).toBe(0);
    expect(fixture.host.pendingFrames).toBe(0);
    await terminalStore.yieldControl();
    expect(fixture.host.frameRequests).toBe(0);

    fixture.host.time = fixture.host.budget;
    const pending = store.yieldControl();
    expect(fixture.host.frameRequests).toBe(1);
    fixture.host.time = fixture.host.frameInterval;
    fixture.host.frame();
    await pending;
    fixture.scheduler.dispose();
  });

  it("shares the current frame deadline and dynamically updated budget with store work", async () => {
    const fixture = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes(runtimePorts(fixture));
    const store = runtimes.createStoreScheduler("drawing.svg", () => false);

    expect(store.shouldYield()).toBe(false);
    fixture.host.time = 3.99;
    expect(store.shouldYield()).toBe(false);
    fixture.host.time = 4;
    expect(store.shouldYield()).toBe(true);
    const pending = store.yieldControl();
    expect(fixture.host.pendingFrames).toBe(1);
    fixture.host.time = fixture.host.frameInterval;
    fixture.host.frame();
    await pending;
    fixture.host.budget = 2;
    fixture.host.time = 9.99;
    expect(store.shouldYield()).toBe(false);
    fixture.host.time = 10;
    expect(store.shouldYield()).toBe(true);
    fixture.scheduler.dispose();
  });

  it("routes a retained document to its new live owner window", async () => {
    const { first, second, runtimes, documentScheduler, moveToSecond } = documentTransferHarness();
    const store = runtimes.createStoreScheduler("drawing.svg", () => false);

    expect(documentScheduler.shouldYield()).toBe(false);
    first.host.time = 4;
    expect(documentScheduler.shouldYield()).toBe(true);
    const requestFrame = vi.spyOn(first.scheduler, "requestFrame");
    const oldFrame = documentScheduler.requestFrame(vi.fn(), "input");
    expect(requestFrame).toHaveBeenCalledWith(expect.any(Function), "input");
    expect(first.host.pendingFrames).toBe(1);
    moveToSecond();
    documentScheduler.cancelFrame(oldFrame);
    expect(first.host.pendingFrames).toBe(0);
    expect(documentScheduler.shouldYield()).toBe(false);
    second.host.time = 4;
    const pending = store.yieldControl();
    expect(first.host.pendingFrames).toBe(0);
    expect(second.host.pendingFrames).toBe(1);
    second.host.time = second.host.frameInterval;
    second.host.frame();
    await pending;
    expect(store.shouldYield()).toBe(false);
    first.scheduler.dispose();
    second.scheduler.dispose();
  });
});

describe("document worker warning boundaries", () => {
  it.each([
    { error: new TypeError("private-document-content"), name: "TypeError" },
    { error: new DOMException("private-document-content", "SecurityError"), name: "SecurityError" },
    {
      error: new DOMException("private-document-content", "InvalidStateError"),
      name: "InvalidStateError",
    },
    {
      error: Object.assign(new Error("private-document-content"), { name: "private-document.svg" }),
      name: "unknown",
    },
    { error: { name: "TypeError", message: "private-document-content" }, name: "unknown" },
  ])("limits construction warning details to a safe error name: $name", async ({ error, name }) => {
    const h = windowHarness();
    const create = vi.spyOn(documentRuntime, "createDocumentRuntime").mockRejectedValue(error);
    const runtimes = createWorkspaceDocumentRuntimes(runtimePorts(h));
    try {
      await expect(runtimes.create("session", 1, "private-document.svg")).rejects.toBe(error);
      expect(h.warn).toHaveBeenCalledOnce();
      expect(h.warn.mock.calls[0]?.[0]).toContain(`error=${name}.`);
      expect(JSON.stringify(h.warn.mock.calls)).not.toContain("private-document");
    } finally {
      create.mockRestore();
      h.scheduler.dispose();
    }
  });

  it("warns on construction failure and fallback without leaking document content", async () => {
    const h = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes(runtimePorts(h));
    await expect(runtimes.create("session", 1, "private-document.svg")).rejects.toThrow(
      "Worker and Blob URL APIs",
    );
    const fallback = runtimes.createFallback("session", 2, () => false, "private-document.svg");
    expect(h.warn.mock.calls[0]?.[0]).toContain("session=session; epoch=1; phase=construction");
    expect(h.warn.mock.calls[0]?.[0]).toContain("kind=error; request=none; error=Error");
    expect(h.warn.mock.calls[1]?.[0]).toContain("main-thread fallback");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("private-document");
    fallback.terminate();
    h.scheduler.dispose();
  });

  it("keeps the original factory failure even if the console rejects warnings", async () => {
    const h = windowHarness();
    h.warn.mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const runtimes = createWorkspaceDocumentRuntimes(runtimePorts(h));
    await expect(runtimes.create("session", 1, "drawing.svg")).rejects.toThrow(
      "Worker and Blob URL APIs",
    );
    h.scheduler.dispose();
  });
});

describe("document scheduler transfer and fallback", () => {
  it("resumes an in-flight frame wait on the new window after the old scheduler closes", async () => {
    const { first, second, documentScheduler, moveToSecond } = documentTransferHarness();
    const nextFrame = vi.spyOn(second.scheduler, "nextFrame");
    const pending = documentScheduler.nextFrame(undefined, "background");
    expect(first.host.pendingFrames).toBe(1);

    moveToSecond();
    first.scheduler.dispose();
    await Promise.resolve();
    expect(nextFrame).toHaveBeenCalledWith(undefined, "background");
    expect(second.host.pendingFrames).toBe(1);
    second.host.frame();
    await pending;
    second.scheduler.dispose();
  });

  it("retries a checkpoint only after transfer and preserves abort errors", async () => {
    const { first, second, documentScheduler, moveToSecond } = documentTransferHarness();
    const firstCheckpoint = vi.spyOn(first.scheduler, "checkpoint");
    const secondCheckpoint = vi.spyOn(second.scheduler, "checkpoint");
    const caller = new AbortController();
    expect(documentScheduler.checkpoint()).toBeUndefined();
    first.host.time = first.host.budget;
    const pending = documentScheduler.checkpoint(caller.signal, "frame");
    expect(pending).toBeDefined();
    expect(firstCheckpoint).toHaveBeenLastCalledWith(caller.signal, "frame");
    moveToSecond();
    first.scheduler.dispose();
    await Promise.resolve();
    expect(second.host.pendingFrames).toBe(0);
    await pending;
    expect(secondCheckpoint).toHaveBeenCalledExactlyOnceWith(caller.signal, "frame");

    const aborted = new AbortController();
    const rejected = documentScheduler.nextFrame(aborted.signal);
    aborted.abort(new Error("cancelled"));
    await expect(rejected).rejects.toThrow("cancelled");
    expect(second.host.pendingFrames).toBe(0);
    second.scheduler.dispose();
  });

  it("does not retry a disposed scheduler when the document has not moved", async () => {
    const fixture = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes(runtimePorts(fixture));
    const documentScheduler = runtimes.workScheduler("drawing.svg");
    const pending = documentScheduler.nextFrame();
    fixture.scheduler.dispose();
    await expect(pending).rejects.toBeInstanceOf(SchedulerDisposedError);
  });

  it("does not resume work after its document scheduler is disposed", async () => {
    const { first, second, documentScheduler, moveToSecond } = documentTransferHarness();
    const pending = documentScheduler.nextFrame();
    moveToSecond();
    documentScheduler.dispose();
    first.scheduler.dispose();
    await expect(pending).rejects.toBeInstanceOf(SchedulerDisposedError);
    expect(second.host.pendingFrames).toBe(0);
    second.scheduler.dispose();
  });

  it("warns once per owning window when fallback is activated", () => {
    const fixture = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes(runtimePorts(fixture));
    const first = runtimes.createFallback("session-a", 1, () => false, "drawing.svg");
    const second = runtimes.createFallback("session-b", 1, () => false, "drawing.svg");

    expect(fixture.warn).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith(
      "Inkbook: Document Worker unavailable or failed; using the bounded main-thread fallback. Performance may be reduced.",
    );
    first.terminate();
    second.terminate();
    fixture.scheduler.dispose();
  });
});
