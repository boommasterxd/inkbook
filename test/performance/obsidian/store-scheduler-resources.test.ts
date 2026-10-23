import { expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../src/domain/scheduling/shared-frame-scheduler";
import { createWorkspaceDocumentRuntimes } from "../../../src/obsidian/embeds/workspace/workspace-runtime-workers";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";
import { ElementStore, type StoreSliceScheduler } from "../../../src/domain/store/public";
import { verifyVaultUnlockIntegrity } from "../../../src/obsidian/embeds/document-session/vault-unlock-integrity";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { windowBindingHarness } from "../../fixtures/obsidian/window-scheduling";
import { SchedulerDisposedError } from "../../../src/domain/scheduling/work-scheduler";

it("releases document-owned waits and callbacks while another document retains the shared frame", async () => {
  const h = windowBindingHarness();
  const shared = h.profiles.workScheduler(h.first.ownerWindow);
  const closeShared = vi.spyOn(shared, "dispose");
  const otherDocument = h.runtimes.workScheduler("other.svg");
  const otherPending = otherDocument.nextFrame();
  const cancelled: Promise<unknown>[] = [];
  const run = vi.fn();
  shared.deadline();
  h.first.host.time = shared.budgetMs();
  for (let index = 0; index < 1_000; index++) {
    const document = h.runtimes.workScheduler("drawing.svg");
    const caller = new AbortController();
    const checkpoint = document.checkpoint(caller.signal);
    expect(checkpoint).toBeDefined();
    cancelled.push(expect(checkpoint).rejects.toBeInstanceOf(SchedulerDisposedError));
    cancelled.push(expect(document.nextFrame()).rejects.toBeInstanceOf(SchedulerDisposedError));
    document.requestFrame(run);
    document.dispose();
    expect(h.first.host.pendingFrames).toBe(1);
    expect(h.first.host.pendingTimers).toBeLessThanOrEqual(2);
  }
  await Promise.all(cancelled);
  expect(closeShared).not.toHaveBeenCalled();
  h.first.host.time += h.first.host.frameInterval;
  h.first.host.frame();
  await otherPending;
  expect(run).not.toHaveBeenCalled();
  otherDocument.dispose();
  h.profiles.dispose();
  for (const window of [h.first, h.second]) {
    expect(window.host.pendingFrames).toBe(0);
    expect(window.host.pendingTimers).toBe(0);
  }
});

it("bounds retained frame resources across sequential store handoffs", async () => {
  const host = new ManualHost();
  const workScheduler = new SharedFrameScheduler(host);
  const ownerWindow = {
    performance: { now: () => host.time, timeOrigin: 1_000 },
  } as unknown as Window;
  const runtimes = createWorkspaceDocumentRuntimes({
    owningWindow: () => ownerWindow,
    ownerWindowVersion: () => 0,
    fallbackWindow: () => ownerWindow,
    subscribeSchedulingProfile: () => () => undefined,
    workScheduler: () => workScheduler,
  });
  const store = runtimes.createStoreScheduler("drawing.svg", () => false);

  expect(store.shouldYield()).toBe(false);
  for (let slice = 0; slice < 158; slice += 1) {
    host.time += host.budget;
    expect(store.shouldYield()).toBe(true);
    const pending = store.yieldControl();
    expect(host.pendingFrames).toBe(1);
    expect(host.pendingTimers).toBeLessThanOrEqual(2);
    host.time += host.frameInterval - host.budget;
    host.frame();
    await pending;
    expect(host.pendingFrames).toBe(0);
    expect(store.shouldYield()).toBe(false);
    host.timer(0);
  }
  expect(host.frameRequests).toBe(158);
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
  workScheduler.dispose();
});

async function removeAndReplay(store: ElementStore, scheduler: StoreSliceScheduler) {
  const ids = store.materializeBandOrder("content");
  const prepared = await store.prepareElementRemoval(ids, scheduler);
  if (prepared.token === null) throw new Error("Removal preparation failed.");
  const removed = store.commitPreparedElementMutation(prepared.token);
  if (removed.transition === null) throw new Error("Removal commit failed.");
  expect(store.size).toBe(0);
  for (const direction of ["reverse", "forward", "reverse"] as const) {
    const replay = await store.prepareHistoryReplay(
      removed.transition[direction],
      scheduler,
      removed.transition,
    );
    if (replay.token === null) throw new Error("History preparation failed.");
    expect(store.commitPreparedElementMutation(replay.token).status).toBe("committed");
    expect(store.size).toBe(direction === "forward" ? 0 : 10_000);
  }
  expect(store.materializeBandOrder("content")).toEqual(ids);
}

it("binds 10K store checkpoints without repeating presentation or window liveness reads", async () => {
  const h = windowBindingHarness();
  const first = createTestStroke();
  const snapshot = createWorkerSnapshot(
    Array.from({ length: 10_000 }, (_, index) => ({
      ...first,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })),
  );
  const scheduler = h.runtimes.createStoreScheduler("drawing.svg", () => false);
  const builder = ElementStore.createBuilder(scheduler);
  const initialReads = { ...h.first.accesses };
  try {
    await builder.appendOwnedRuntime(snapshot.elements);
    const store = await builder.finalize();
    if (store === null) throw new Error("Store creation failed.");
    const read = vi.spyOn(store, "get");
    const rank = vi.spyOn(store, "getRank");
    const yieldControl = vi.spyOn(scheduler, "yieldControl");
    await verifyVaultUnlockIntegrity({ snapshot, store, scheduler });
    expect(read).toHaveBeenCalledTimes(10_000);
    expect(rank).toHaveBeenCalledTimes(10_000);
    expect(yieldControl).not.toHaveBeenCalled();
    read.mockRestore();
    rank.mockRestore();
    await removeAndReplay(store, scheduler);
    // One binding reads the first mounted root and validates its live window once.
    expect(h.first.accesses.presentation - initialReads.presentation).toBe(1);
    expect(h.first.accesses.closed - initialReads.closed).toBe(1);
    expect(h.first.accesses.document - initialReads.document).toBe(1);
    expect(h.first.accesses.performance - initialReads.performance).toBe(1);
    expect(h.first.accesses.now).toBeGreaterThanOrEqual(10_000);
    expect(h.first.host.frameRequests).toBe(0);

    h.profiles.setPreference(240);
    const reads = { ...h.first.accesses };
    await verifyVaultUnlockIntegrity({ snapshot, store, scheduler });
    expect(h.first.accesses.presentation).toBe(reads.presentation);
    expect(h.first.accesses.closed).toBe(reads.closed);
    expect(h.first.accesses.document).toBe(reads.document);
    expect(h.first.accesses.performance).toBe(reads.performance);
    expect(h.first.accesses.now).toBeGreaterThan(reads.now);
    expect(h.profiles.workScheduler(h.first.ownerWindow).budgetMs()).toBeCloseTo(
      (1_000 / 240) * 0.55,
    );

    h.attachment.root = h.second.root;
    h.registry.observe("drawing.svg", h.second.ownerWindow);
    h.profiles.notifyOwnerWindowChanged();
    const transferredReads = { ...h.second.accesses };
    await verifyVaultUnlockIntegrity({ snapshot, store, scheduler });
    expect(h.second.accesses.presentation - transferredReads.presentation).toBe(1);
    expect(h.second.accesses.closed - transferredReads.closed).toBe(1);
    expect(h.second.accesses.document - transferredReads.document).toBe(1);
    expect(h.second.accesses.performance - transferredReads.performance).toBe(1);

    const cancelled = h.runtimes.createStoreScheduler("drawing.svg", () => true);
    await expect(
      verifyVaultUnlockIntegrity({ snapshot, store, scheduler: cancelled }),
    ).rejects.toThrow("cancelled");
  } finally {
    h.profiles.dispose();
    h.registry.clear();
  }
  for (const window of [h.first, h.second]) {
    expect(window.host.pendingFrames).toBe(0);
    expect(window.host.pendingTimers).toBe(0);
  }
});
