// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact touch coordinates exercise the specified slop and scale boundaries. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectTouchZoomReservation } from "../../../../src/adapters/obsidian/views/direct-touch-zoom-reservation";
import type { Disposable } from "../../../../src/adapters/obsidian/views";
import {
  directTouch as touch,
  installObsidianElementProperties,
  phaseZeroViewContext,
  phaseZeroViewRegistry,
  pointer,
  type TestTouchPoint,
} from "./phase-zero-view-test-helpers";

type Harness = Readonly<{
  binding: Disposable;
  container: HTMLElement;
  registry: ReturnType<typeof phaseZeroViewRegistry>;
  svg: SVGSVGElement;
}>;

function createHarness(): Harness {
  const container = document.createElement("div");
  installObsidianElementProperties(container);
  document.body.append(container);
  const registry = phaseZeroViewRegistry();
  const binding = registry.bind(phaseZeroViewContext(container, "source"));
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("Expected retained SVG.");
  return { binding, container, registry, svg };
}

function readScale(svg: SVGSVGElement): number | undefined {
  const value = /scale\(([^)]+)\)$/u.exec(svg.style.transform)?.[1];
  return value === undefined ? undefined : Number(value);
}

function startReservedPair(container: HTMLElement): readonly TestTouchPoint[] {
  const first = { clientX: 0, identifier: 1 } as const;
  const second = { clientX: 100, identifier: 2 } as const;
  container.dispatchEvent(touch("touchstart", [first], [first]));
  const reservation = touch("touchstart", [second], [first, second]);
  container.dispatchEvent(reservation);
  expect(reservation.defaultPrevented).toBe(true);
  return [first, second];
}

afterEach(() => document.body.replaceChildren());

describe("direct-touch zoom presentation", () => {
  it("leaves the complete one-finger native scroll sequence unclaimed", () => {
    const harness = createHarness();
    const first = { clientX: 0, identifier: 1 } as const;
    const start = touch("touchstart", [first], [first]);
    const move = touch(
      "touchmove",
      [{ clientX: 20, identifier: 1 }],
      [{ clientX: 20, identifier: 1 }],
    );

    harness.container.dispatchEvent(start);
    harness.container.dispatchEvent(move);

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(harness.svg.style.transform).toBe("");
    harness.registry.dispose();
  });

  it("reserves the second contact and updates before either finger lifts", () => {
    const harness = createHarness();
    const [first] = startReservedPair(harness.container);
    if (first === undefined) throw new Error("Expected first touch.");
    const below = touch(
      "touchmove",
      [{ clientX: 107, identifier: 2 }],
      [first, { clientX: 107, identifier: 2 }],
    );
    const exact = touch(
      "touchmove",
      [{ clientX: 108, identifier: 2 }],
      [first, { clientX: 108, identifier: 2 }],
    );

    harness.container.dispatchEvent(below);
    expect(below.defaultPrevented).toBe(true);
    expect(harness.svg.style.transform).toBe("");
    harness.container.dispatchEvent(exact);

    expect(exact.defaultPrevented).toBe(true);
    expect(readScale(harness.svg)).toBeCloseTo(1.1664);
    const live = touch(
      "touchmove",
      [{ clientX: 109, identifier: 2 }],
      [first, { clientX: 109, identifier: 2 }],
    );
    harness.container.dispatchEvent(live);
    expect(readScale(harness.svg)).toBeCloseTo(1.1881);
    harness.registry.dispose();
  });

  it("does not apply duplicate touch PointerEvents", () => {
    const harness = createHarness();
    harness.container.dispatchEvent(
      pointer("pointerdown", {
        clientX: 0,
        pointerId: 11,
        pointerType: "touch",
      }),
    );
    harness.container.dispatchEvent(
      pointer("pointerdown", {
        clientX: 100,
        pointerId: 12,
        pointerType: "touch",
      }),
    );
    const [first] = startReservedPair(harness.container);
    if (first === undefined) throw new Error("Expected first touch.");
    harness.container.dispatchEvent(
      touch(
        "touchmove",
        [{ clientX: 108, identifier: 2 }],
        [first, { clientX: 108, identifier: 2 }],
      ),
    );
    const liveTransform = harness.svg.style.transform;

    harness.container.dispatchEvent(
      pointer("pointermove", {
        clientX: 108,
        pointerId: 12,
        pointerType: "touch",
      }),
    );

    expect(harness.svg.style.transform).toBe(liveTransform);
    harness.registry.dispose();
  });
});

describe("direct-touch zoom failure and disposal", () => {
  it("fails closed when the second contact cannot be reserved", () => {
    const harness = createHarness();
    const first = { clientX: 0, identifier: 1 } as const;
    const second = { clientX: 100, identifier: 2 } as const;
    harness.container.dispatchEvent(touch("touchstart", [first], [first]));
    const unavailable = touch("touchstart", [second], [first, second], false);
    harness.container.dispatchEvent(unavailable);
    harness.container.dispatchEvent(
      touch(
        "touchmove",
        [{ clientX: 120, identifier: 2 }],
        [first, { clientX: 120, identifier: 2 }],
      ),
    );

    expect(unavailable.defaultPrevented).toBe(false);
    expect(harness.svg.style.transform).toBe("");
    harness.registry.dispose();
  });

  it("cancels a reserved sequence on a third contact", () => {
    const harness = createHarness();
    const [first, second] = startReservedPair(harness.container);
    if (first === undefined || second === undefined) {
      throw new Error("Expected touch pair.");
    }
    harness.container.dispatchEvent(
      touch(
        "touchmove",
        [{ clientX: 108, identifier: 2 }],
        [first, { clientX: 108, identifier: 2 }],
      ),
    );
    const claimedTransform = harness.svg.style.transform;
    const third = { clientX: 50, clientY: 50, identifier: 3 } as const;
    const thirdStart = touch("touchstart", [third], [first, second, third]);

    harness.container.dispatchEvent(thirdStart);
    harness.container.dispatchEvent(
      touch(
        "touchmove",
        [{ clientX: 120, identifier: 2 }],
        [first, { clientX: 120, identifier: 2 }, third],
      ),
    );

    expect(thirdStart.defaultPrevented).toBe(true);
    expect(harness.svg.style.transform).toBe(claimedTransform);
    harness.registry.dispose();
  });

  it("releases the live move listener after touch cancellation", () => {
    const harness = createHarness();
    const [first, second] = startReservedPair(harness.container);
    if (first === undefined || second === undefined) {
      throw new Error("Expected touch pair.");
    }
    harness.container.dispatchEvent(touch("touchcancel", [second], [first]));
    const laterMove = touch(
      "touchmove",
      [{ clientX: 120, identifier: 1 }],
      [{ clientX: 120, identifier: 1 }],
    );

    harness.container.dispatchEvent(laterMove);

    expect(laterMove.defaultPrevented).toBe(false);
    expect(harness.svg.style.transform).toBe("");
    harness.registry.dispose();
  });

  it("removes the reserved move stream during idempotent disposal", () => {
    const harness = createHarness();
    const [first] = startReservedPair(harness.container);
    if (first === undefined) throw new Error("Expected first touch.");
    harness.binding.dispose();
    harness.binding.dispose();
    const move = touch(
      "touchmove",
      [{ clientX: 120, identifier: 2 }],
      [first, { clientX: 120, identifier: 2 }],
    );

    harness.container.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(harness.svg.style.transform).toBe("");
    harness.registry.dispose();
  });
});

describe("DirectTouchZoomReservation failure handling", () => {
  it("releases a failed reservation and ignores the host-owned sequence", () => {
    const releaseMoveStream = vi.fn();
    const scale = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream,
      reserveMoveStream: (): boolean => false,
      scale,
    });
    const first = { clientX: 0, identifier: 1 } as const;
    const second = { clientX: 100, identifier: 2 } as const;

    reservation.touchStart(touch("touchstart", [first], [first]));
    reservation.touchStart(touch("touchstart", [second], [first, second]));
    reservation.touchMove(
      touch(
        "touchmove",
        [{ clientX: 120, identifier: 2 }],
        [first, { clientX: 120, identifier: 2 }],
      ),
    );
    reservation.touchEnd(touch("touchend", [first, second], []));
    reservation.dispose();

    expect(scale).not.toHaveBeenCalled();
    expect(releaseMoveStream).not.toHaveBeenCalled();
  });
});

describe("DirectTouchZoomReservation terminal states", () => {
  it("yields and releases when a reserved move becomes non-cancelable", () => {
    const releaseMoveStream = vi.fn();
    const reserveMoveStream = vi.fn(() => true);
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream,
      reserveMoveStream,
      scale: vi.fn(),
    });
    const first = { clientX: 0, identifier: 1 } as const;
    const second = { clientX: 100, identifier: 2 } as const;
    reservation.touchStart(touch("touchstart", [first], [first]));
    reservation.touchStart(touch("touchstart", [second], [first, second]));

    reservation.touchMove(
      touch(
        "touchmove",
        [{ clientX: 108, identifier: 2 }],
        [first, { clientX: 108, identifier: 2 }],
        false,
      ),
    );
    reservation.touchEnd(touch("touchend", [second], [first]));
    reservation.touchCancel(touch("touchcancel", [first], []));
    reservation.touchStart(touch("touchstart", [first], [first]));
    reservation.touchStart(touch("touchstart", [second], [first, second]));

    expect(releaseMoveStream).toHaveBeenCalledTimes(1);
    expect(reserveMoveStream).toHaveBeenCalledTimes(2);
    reservation.dispose();
  });

  it("releases an unclaimed pair when one contact ends", () => {
    const releaseMoveStream = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream,
      reserveMoveStream: (): boolean => true,
      scale: vi.fn(),
    });
    const first = { clientX: 0, identifier: 1 } as const;
    const second = { clientX: 100, identifier: 2 } as const;
    reservation.touchStart(touch("touchstart", [first], [first]));
    reservation.touchStart(touch("touchstart", [second], [first, second]));
    const end = touch("touchend", [second], [first]);

    reservation.touchEnd(end);
    reservation.touchMove(
      touch(
        "touchmove",
        [{ clientX: 10, identifier: 1 }],
        [{ clientX: 10, identifier: 1 }],
      ),
    );
    reservation.touchCancel(touch("touchcancel", [first], []));
    reservation.dispose();
    reservation.dispose();

    expect(end.defaultPrevented).toBe(false);
    expect(releaseMoveStream).toHaveBeenCalledTimes(1);
  });
});
