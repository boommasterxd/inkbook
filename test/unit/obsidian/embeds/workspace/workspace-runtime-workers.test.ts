import { describe, expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../../../src/domain/scheduling/shared-frame-scheduler";
import { SchedulerDisposedError } from "../../../../../src/domain/scheduling/work-scheduler";
import { createWorkspaceDocumentRuntimes } from "../../../../../src/obsidian/embeds/workspace/workspace-runtime-workers";
import * as documentRuntime from "../../../../../src/persistence/worker/runtime/public";
import { ManualHost } from "../../../../fixtures/scheduling/manual-frame-host";
import {
  observedSchedulingWindow,
  windowBindingHarness,
} from "../../../../fixtures/obsidian/window-scheduling";

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
    ownerWindowVersion: () => 0,
    subscribeSchedulingProfile: () => () => undefined,
    workScheduler: () => fixture.scheduler,
  };
}

function documentTransferHarness() {
  const first = windowHarness();
  const second = windowHarness();
  let owner = first;
  let ownerVersion = 0;
  const runtimes = createWorkspaceDocumentRuntimes({
    ...runtimePorts(first),
    owningWindow: () => owner.ownerWindow,
    ownerWindowVersion: () => ownerVersion,
    workScheduler: (window) => (window === first.ownerWindow ? first.scheduler : second.scheduler),
  });
  return {
    first,
    second,
    runtimes,
    documentScheduler: runtimes.workScheduler("drawing.svg"),
    moveToSecond: () => {
      owner = second;
      ownerVersion += 1;
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

it.each(["unload", "transfer"] as const)(
  "admits a third owner after an intermediate destination %s",
  async (transition) => {
    const h = windowBindingHarness();
    const third = observedSchedulingWindow();
    const scheduler = h.runtimes.workScheduler("drawing.svg");
    const secondScheduler = h.profiles.workScheduler(h.second.ownerWindow);
    const thirdScheduler = h.profiles.workScheduler(third.ownerWindow);
    scheduler.deadline();
    secondScheduler.deadline();
    thirdScheduler.deadline();
    h.second.host.time = secondScheduler.budgetMs();
    third.host.time = thirdScheduler.budgetMs();
    let settled = false;
    const pending = scheduler.nextFrame().then(() => {
      settled = true;
    });
    h.attachment.root = h.second.root;
    h.registry.observe("drawing.svg", h.second.ownerWindow);
    h.presentations.push({ attachment: { documentId: "other.svg", root: third.root } });
    h.first.host.frame();
    await Promise.resolve();
    expect(h.second.host.pendingFrames).toBe(1);
    if (transition === "unload") h.second.ownerWindow.dispatchEvent(new Event("unload"));
    else {
      h.attachment.root = third.root;
      h.second.host.time = h.second.host.frameInterval;
      h.second.host.frame();
    }
    await Promise.resolve();
    expect(third.host.pendingFrames).toBe(1);
    expect(settled).toBe(false);
    third.host.time = third.host.frameInterval;
    third.host.frame();
    await pending;
    expect(settled).toBe(true);
    scheduler.dispose();
    h.profiles.dispose();
    for (const window of [h.first, h.second, third]) {
      expect(window.host.pendingFrames).toBe(0);
      expect(window.host.pendingTimers).toBe(0);
    }
  },
);

describe("document scheduler owning-window binding", () => {
  it.each(["checkpoint", "nextFrame"] as const)(
    "requires destination admission after a successful old-owner %s",
    async (method) => {
      const h = windowBindingHarness();
      const scheduler = h.runtimes.workScheduler("drawing.svg");
      const target = h.profiles.workScheduler(h.second.ownerWindow);
      const admit = vi.spyOn(target, "checkpoint");
      const caller = new AbortController();
      scheduler.deadline();
      target.deadline();
      h.first.host.time = scheduler.budgetMs();
      h.second.host.time = target.budgetMs();
      let settled = false;
      const pending = scheduler[method](caller.signal, "frame")?.then(() => {
        settled = true;
      });
      h.attachment.root = h.second.root;
      h.first.host.time = h.first.host.frameInterval;
      h.first.host.frame();
      await Promise.resolve();
      expect(admit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ aborted: false }),
        "frame",
      );
      expect(h.second.host.pendingFrames).toBe(1);
      expect(settled).toBe(false);
      h.second.host.time = h.second.host.frameInterval;
      h.second.host.frame();
      await pending;
      expect(settled).toBe(true);
      scheduler.dispose();
      h.profiles.dispose();
    },
  );

  it("revalidates silent presentation adoption only when an actual handoff resumes", async () => {
    const h = windowBindingHarness();
    const scheduler = h.runtimes.workScheduler("drawing.svg");
    const pending = scheduler.nextFrame();
    h.attachment.root = h.second.root;
    h.second.host.time = 2;
    h.first.host.frame();
    await pending;
    expect(scheduler.now()).toBe(2);
    scheduler.dispose();
    h.profiles.dispose();
  });

  it("rebinds a closed pop-out wait to the fallback even before window.closed changes", async () => {
    const h = windowBindingHarness();
    const scheduler = h.runtimes.workScheduler("drawing.svg");
    const pending = scheduler.nextFrame();
    expect(h.first.host.pendingFrames).toBe(1);
    h.first.ownerWindow.dispatchEvent(new Event("unload"));
    await Promise.resolve();
    expect(h.first.host.pendingFrames).toBe(0);
    expect(h.second.host.pendingFrames).toBe(1);
    h.second.host.frame();
    await pending;
    scheduler.dispose();
    h.profiles.dispose();
    expect(h.first.host.pendingTimers).toBe(0);
    expect(h.second.host.pendingFrames).toBe(0);
    expect(h.second.host.pendingTimers).toBe(0);
  });

  it("keeps first-mounted, retained detached and fallback owner selection between changes", () => {
    const h = windowBindingHarness();
    const scheduler = h.runtimes.workScheduler("drawing.svg");
    h.registry.observe("drawing.svg", h.second.ownerWindow);
    expect(scheduler.now()).toBe(0);
    h.first.host.time = 1;
    h.second.host.time = 2;
    expect(scheduler.now()).toBe(1);
    h.presentations.length = 0;
    h.profiles.notifyOwnerWindowChanged();
    expect(scheduler.now()).toBe(2);
    h.registry.clear();
    h.profiles.notifyOwnerWindowChanged();
    expect(scheduler.now()).toBe(2);
    scheduler.dispose();
    h.profiles.dispose();
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
    expect(nextFrame).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: false }),
      "background",
    );
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
    expect(firstCheckpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ aborted: false }),
      "frame",
    );
    moveToSecond();
    first.scheduler.dispose();
    await Promise.resolve();
    expect(second.host.pendingFrames).toBe(0);
    await pending;
    expect(secondCheckpoint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ aborted: false }),
      "frame",
    );

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
});

it.each(["checkpoint", "nextFrame"] as const)(
  "cancels an owned %s on disposal without closing another document's shared scheduler",
  async (method) => {
    const { first, second, runtimes, documentScheduler, moveToSecond } = documentTransferHarness();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    documentScheduler.deadline();
    first.host.time = first.host.budget;
    const pending = documentScheduler[method](caller.signal);
    expect(pending).toBeDefined();
    const cancelled = expect(pending).rejects.toBeInstanceOf(SchedulerDisposedError);
    const otherDocument = runtimes.workScheduler("other.svg");
    const otherPending = otherDocument.nextFrame();
    moveToSecond();
    documentScheduler.dispose();
    await cancelled;
    expect(removeListener).toHaveBeenCalledOnce();
    expect(second.host.pendingFrames).toBe(0);
    expect(first.host.pendingFrames).toBe(1);
    first.host.time = first.host.frameInterval;
    first.host.frame();
    await otherPending;
    await expect(documentScheduler[method]()).rejects.toBeInstanceOf(SchedulerDisposedError);
    otherDocument.dispose();
    first.scheduler.dispose();
    second.scheduler.dispose();
  },
);

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
