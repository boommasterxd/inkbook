import { describe, expect, it, vi } from "vitest";

import { createWorkspaceDocumentRuntimes } from "../../../../src/obsidian/embeds/workspace-runtime-workers";

function windowHarness() {
  let now = 0;
  const ownerWindow = {
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
});
