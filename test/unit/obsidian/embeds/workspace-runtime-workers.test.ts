import { describe, expect, it, vi } from "vitest";

import { createWorkspaceDocumentRuntimes } from "../../../../src/obsidian/embeds/workspace-runtime-workers";

function windowHarness() {
  let now = 0;
  const warn = vi.fn();
  const ownerWindow = {
    console: { warn },
    performance: {
      now: () => now,
      timeOrigin: 1_000,
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
  } as unknown as Window;
  return {
    now: (value: number) => {
      now = value;
    },
    ownerWindow,
    warn,
  };
}

describe("workspace document runtime profiles", () => {
  it("uses the desktop 8 ms store-adoption slice", () => {
    const fixture = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes(
      { fallbackWindow: () => fixture.ownerWindow, owningWindow: () => fixture.ownerWindow },
      "desktop",
    );
    const scheduler = runtimes.createStoreScheduler(
      "drawing.svg",
      vi.fn(() => false),
    );

    fixture.now(7.99);
    expect(scheduler.shouldYield()).toBe(false);
    fixture.now(8);
    expect(scheduler.shouldYield()).toBe(true);
  });

  it("uses the mobile 12 ms store-adoption slice", () => {
    const fixture = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes(
      { fallbackWindow: () => fixture.ownerWindow, owningWindow: () => fixture.ownerWindow },
      "mobile",
    );
    const scheduler = runtimes.createStoreScheduler(
      "drawing.svg",
      vi.fn(() => false),
    );

    fixture.now(11.99);
    expect(scheduler.shouldYield()).toBe(false);
    fixture.now(12);
    expect(scheduler.shouldYield()).toBe(true);
  });

  it("reads the current refresh-profile budget for every store slice", async () => {
    const fixture = windowHarness();
    let budget = 4.58;
    const runtimes = createWorkspaceDocumentRuntimes({
      fallbackWindow: () => fixture.ownerWindow,
      owningWindow: () => fixture.ownerWindow,
      sliceBudgetMs: () => budget,
    });
    const scheduler = runtimes.createStoreScheduler("drawing.svg", () => false);

    fixture.now(4.57);
    expect(scheduler.shouldYield()).toBe(false);
    fixture.now(4.58);
    expect(scheduler.shouldYield()).toBe(true);
    await scheduler.yieldControl();

    budget = 2.29;
    fixture.now(6.86);
    expect(scheduler.shouldYield()).toBe(false);
    fixture.now(6.87);
    expect(scheduler.shouldYield()).toBe(true);
  });

  it("warns once per owning window when the bounded fallback is activated", () => {
    const fixture = windowHarness();
    const runtimes = createWorkspaceDocumentRuntimes({
      fallbackWindow: () => fixture.ownerWindow,
      owningWindow: () => fixture.ownerWindow,
    });

    const first = runtimes.createFallback("session-a", 1, () => false);
    const second = runtimes.createFallback("session-b", 1, () => false);

    expect(fixture.warn).toHaveBeenCalledOnce();
    expect(fixture.warn).toHaveBeenCalledWith(
      "Inkbook: Document Worker unavailable or failed; using the bounded main-thread fallback. Performance may be reduced.",
    );
    first.terminate();
    second.terminate();
  });
});
