// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-magic-numbers -- Distinct pointer IDs and coordinates model concurrent gesture identities. */

import { Menu } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhaseZeroViewRegistry } from "../../../../src/adapters/obsidian/views";
import type { Disposable } from "../../../../src/adapters/obsidian/views/contracts";
import {
  directTouch,
  installObsidianElementProperties,
  phaseZeroViewContext,
  phaseZeroViewRegistry,
  pointer,
} from "./phase-zero-view-test-helpers";

const menuProbe = Menu as typeof Menu & {
  readonly positions: {
    document: Document | undefined;
    position: Readonly<{ x: number; y: number }>;
  }[];
};

type Harness = Readonly<{
  binding: Disposable;
  container: HTMLElement;
  marker: SVGCircleElement;
  registry: PhaseZeroViewRegistry;
}>;

function createHarness(): Harness {
  const container = document.createElement("div");
  installObsidianElementProperties(container);
  document.body.append(container);
  const registry = phaseZeroViewRegistry();
  const binding = registry.bind(
    phaseZeroViewContext(container, "live-preview"),
  );
  const marker = container.querySelector<SVGCircleElement>(
    ".inkbook-phase-zero-marker",
  );
  if (marker === null) throw new Error("Expected retained marker.");
  return { binding, container, marker, registry };
}

function startLongPress(marker: SVGCircleElement, pointerId: number): void {
  marker.dispatchEvent(
    pointer("pointerdown", {
      button: 0,
      clientX: 42,
      clientY: 54,
      pointerId,
      pointerType: "touch",
    }),
  );
  expect(vi.getTimerCount()).toBe(1);
}

describe("PhaseZeroViewRegistry long-press lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    menuProbe.positions.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("cancels idempotently on pointerup, pointercancel, and lost capture", () => {
    const harness = createHarness();
    const terminations = ["pointerup", "pointercancel", "lostpointercapture"];

    terminations.forEach((type, index) => {
      const pointerId = index + 1;
      startLongPress(harness.marker, pointerId);
      harness.container.dispatchEvent(pointer(type, { pointerId }));
      harness.container.dispatchEvent(pointer(type, { pointerId }));
      expect(vi.getTimerCount()).toBe(0);
      vi.runOnlyPendingTimers();
      expect(menuProbe.positions).toHaveLength(0);
    });

    harness.registry.dispose();
  });

  it("cancels on a third pointer and on host ownership takeover", () => {
    const thirdPointer = createHarness();
    startLongPress(thirdPointer.marker, 10);
    thirdPointer.container.dispatchEvent(
      pointer("pointerdown", {
        pointerId: 11,
        pointerType: "touch",
      }),
    );
    expect(vi.getTimerCount()).toBe(1);
    thirdPointer.container.dispatchEvent(
      pointer("pointerdown", {
        pointerId: 12,
        pointerType: "touch",
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    thirdPointer.registry.dispose();

    const hostClaim = createHarness();
    startLongPress(hostClaim.marker, 20);
    const first = { clientX: 42, clientY: 54, identifier: 20 } as const;
    const second = { clientX: 62, clientY: 54, identifier: 21 } as const;
    hostClaim.container.dispatchEvent(
      directTouch("touchstart", [first], [first]),
    );
    hostClaim.container.dispatchEvent(
      directTouch("touchstart", [second], [first, second]),
    );
    hostClaim.container.dispatchEvent(
      directTouch(
        "touchmove",
        [{ clientX: 70, clientY: 54, identifier: 21 }],
        [first, { clientX: 70, clientY: 54, identifier: 21 }],
      ),
    );
    expect(vi.getTimerCount()).toBe(0);
    vi.runOnlyPendingTimers();
    expect(menuProbe.positions).toHaveLength(0);
    hostClaim.registry.dispose();
  });

  it("dispatches one menu when the scheduled long press succeeds", () => {
    const harness = createHarness();
    startLongPress(harness.marker, 30);

    vi.runOnlyPendingTimers();

    expect(menuProbe.positions).toEqual([
      { document, position: { x: 42, y: 54 } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    harness.container.dispatchEvent(
      pointer("lostpointercapture", { pointerId: 30 }),
    );
    vi.runOnlyPendingTimers();
    expect(menuProbe.positions).toHaveLength(1);
    harness.registry.dispose();
  });

  it("cancels pending work on view disposal and plugin unload", () => {
    const viewDisposal = createHarness();
    startLongPress(viewDisposal.marker, 40);
    viewDisposal.binding.dispose();
    viewDisposal.binding.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.runOnlyPendingTimers();
    expect(menuProbe.positions).toHaveLength(0);

    const pluginUnload = createHarness();
    startLongPress(pluginUnload.marker, 41);
    pluginUnload.registry.dispose();
    pluginUnload.registry.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.runOnlyPendingTimers();
    expect(menuProbe.positions).toHaveLength(0);
  });
});
