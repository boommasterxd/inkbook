import { expect, it, vi } from "vitest";
import { createWorkspaceDocumentRuntimes } from "../../../src/obsidian/embeds/workspace-runtime-workers";

it("owns at most two message ports per sequential store handoff and closes failed dispatches", async () => {
  let open = 0;
  let created = 0;
  let maximumOpen = 0;
  let fail = false;
  const tasks: Array<() => void> = [];
  class Channel {
    public readonly port1 = {
      onmessage: () => undefined,
      close: () => {
        open -= 1;
      },
    };
    public readonly port2 = {
      close: () => {
        open -= 1;
      },
      postMessage: () => {
        if (fail) throw new Error("closed window");
        tasks.push(() => this.port1.onmessage());
      },
    };
    public constructor() {
      created += 1;
      open += 2;
      maximumOpen = Math.max(maximumOpen, open);
    }
  }
  const timer = vi.fn();
  let now = 0;
  const ownerWindow = {
    MessageChannel: Channel,
    performance: { now: () => now },
    setTimeout: timer,
  } as unknown as Window;
  const runtimes = createWorkspaceDocumentRuntimes({
    owningWindow: () => ownerWindow,
    fallbackWindow: () => ownerWindow,
  });
  const scheduler = runtimes.createStoreScheduler("drawing.svg", () => false);
  for (let slice = 0; slice < 158; slice += 1) {
    now += 8;
    expect(scheduler.shouldYield()).toBe(true);
    const pending = scheduler.yieldControl();
    expect(tasks).toHaveLength(1);
    tasks.shift()?.();
    await pending;
    expect(open).toBe(0);
    expect(scheduler.shouldYield()).toBe(false);
  }
  expect(created).toBe(158);
  expect(maximumOpen).toBe(2);
  expect(timer).not.toHaveBeenCalled();
  fail = true;
  await expect(scheduler.yieldControl()).rejects.toThrow("closed window");
  expect(open).toBe(0);
  expect(tasks).toHaveLength(0);
});
