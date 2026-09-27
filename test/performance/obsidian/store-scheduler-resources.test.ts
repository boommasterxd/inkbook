import { expect, it } from "vitest";

import { SharedFrameScheduler } from "../../../src/domain/scheduling/shared-frame-scheduler";
import { createWorkspaceDocumentRuntimes } from "../../../src/obsidian/embeds/workspace-runtime-workers";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";

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
