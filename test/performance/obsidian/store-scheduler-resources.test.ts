import { expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../src/domain/scheduling/shared-frame-scheduler";
import { createWorkspaceDocumentRuntimes } from "../../../src/obsidian/embeds/workspace-runtime-workers";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";
import { ElementStore } from "../../../src/domain/store/public";
import { verifyVaultUnlockIntegrity } from "../../../src/obsidian/embeds/vault-unlock-integrity";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";

it("bounds retained frame resources across sequential store handoffs", async () => {
  const host = new ManualHost();
  const workScheduler = new SharedFrameScheduler(host);
  const ownerWindow = {
    performance: { now: () => host.time, timeOrigin: 1_000 },
  } as unknown as Window;
  const runtimes = createWorkspaceDocumentRuntimes({
    owningWindow: () => ownerWindow,
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

it("checks every owned unlock element once without count-forced scheduler handoffs", async () => {
  const first = createTestStroke();
  const snapshot = createWorkerSnapshot(
    Array.from({ length: 10_000 }, (_, index) => ({
      ...first,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })),
  );
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  await builder.appendOwnedRuntime(snapshot.elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Store creation failed.");
  const read = vi.spyOn(store, "get");
  const rank = vi.spyOn(store, "getRank");
  const yieldControl = vi.fn(async () => undefined);
  try {
    await verifyVaultUnlockIntegrity({
      snapshot,
      store,
      scheduler: { shouldYield: () => false, yieldControl },
    });
    expect(read).toHaveBeenCalledTimes(10_000);
    expect(rank).toHaveBeenCalledTimes(10_000);
    expect(yieldControl).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    rank.mockRestore();
  }
});
