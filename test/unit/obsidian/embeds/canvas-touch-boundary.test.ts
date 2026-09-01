// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { CanvasTouchBoundary } from "../../../../src/obsidian/embeds/canvas-touch-boundary";

describe("canvas touch boundary", () => {
  it("owns the complete pen stream before Obsidian can scroll or swipe", () => {
    const fixture = createFixture();
    const blockedBeforeEditor: boolean[] = [];
    fixture.onPenPointerStart.mockImplementation((event: PointerEvent) => {
      blockedBeforeEditor.push(event.defaultPrevented);
    });
    fixture.onPenPointerMove.mockImplementation((event: PointerEvent) => {
      blockedBeforeEditor.push(event.defaultPrevented);
    });
    fixture.onPenPointerUp.mockImplementation((event: PointerEvent) => {
      blockedBeforeEditor.push(event.defaultPrevented);
    });

    const down = dispatchPointer(fixture.surface, "pointerdown", true, 7, "pen");
    const move = dispatchPointer(fixture.surface, "pointermove", true, 7, "pen");
    const up = dispatchPointer(fixture.surface, "pointerup", true, 7, "pen");

    expect([down.defaultPrevented, move.defaultPrevented, up.defaultPrevented]).toEqual([
      true,
      true,
      true,
    ]);
    expect(fixture.onPenPointerStart).toHaveBeenCalledWith(down);
    expect(fixture.onPenPointerMove).toHaveBeenCalledWith(move);
    expect(fixture.onPenPointerUp).toHaveBeenCalledWith(up);
    expect(blockedBeforeEditor).toEqual([true, true, true]);
    expect(fixture.hostPointerStarts).not.toHaveBeenCalled();
    expect(fixture.hostPointerMoves).not.toHaveBeenCalled();
    expect(fixture.hostPointerUps).not.toHaveBeenCalled();
    fixture.dispose();
  });

  it("lets unclaimed touch events reach host scrolling without cancelling them", () => {
    const fixture = createFixture();

    const start = dispatchTouch(fixture.surface, "touchstart", [touch(1, 20, 20)]);
    const move = dispatchTouch(fixture.surface, "touchmove", [touch(1, 22, 40)]);

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(fixture.hostStarts).toHaveBeenCalledOnce();
    expect(fixture.hostMoves).toHaveBeenCalledOnce();
    fixture.dispose();
  });

  it("stops claimed touch events before host drawer gestures", () => {
    const fixture = createFixture(true);

    const start = dispatchTouch(fixture.surface, "touchstart", [touch(1, 20, 20)]);
    const move = dispatchTouch(fixture.surface, "touchmove", [touch(1, 40, 22)]);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(fixture.hostStarts).not.toHaveBeenCalled();
    expect(fixture.hostMoves).not.toHaveBeenCalled();
    fixture.dispose();
  });

  it("cancels native scrolling after pointer arbitration claims the touch", () => {
    let blockTouch = false;
    const fixture = createFixture(() => blockTouch);
    fixture.onTouchPointerStart.mockImplementation(() => {
      blockTouch = true;
    });

    dispatchPointer(fixture.surface, "pointerdown", true, 4);
    const start = dispatchTouch(fixture.surface, "touchstart", [touch(4, 20, 20)]);
    const move = dispatchTouch(fixture.surface, "touchmove", [touch(4, 20, 40)]);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(fixture.hostPointerStarts).not.toHaveBeenCalled();
    expect(fixture.hostStarts).not.toHaveBeenCalled();
    expect(fixture.hostMoves).not.toHaveBeenCalled();
    fixture.dispose();
  });
});

describe("claimed canvas touch boundary", () => {
  it("does not attempt to cancel a claimed touch event after native scrolling owns it", () => {
    const fixture = createFixture(true);
    const event = new Event("touchmove", { bubbles: true, cancelable: false });
    const preventDefault = vi.spyOn(event, "preventDefault");

    fixture.surface.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(fixture.hostMoves).not.toHaveBeenCalled();
    fixture.dispose();
  });

  it("lets terminal touch events reach host cleanup handlers", () => {
    const fixture = createFixture();

    const end = dispatchTouch(fixture.surface, "touchend", []);

    expect(end.defaultPrevented).toBe(false);
    expect(fixture.hostEnds).toHaveBeenCalledOnce();
    fixture.dispose();
  });

  it("recovers stale state before a new primary pointer and after terminal dispatch completes", () => {
    vi.useFakeTimers();
    const fixture = createFixture();

    dispatchPointer(fixture.surface, "pointerdown", true, 4);
    dispatchPointer(fixture.surface, "pointermove", true, 4);
    dispatchPointer(fixture.surface, "pointerdown", false, 5);
    dispatchPointer(fixture.surface, "pointerup", true, 4);

    expect(fixture.onPrimaryTouchStart).toHaveBeenCalledOnce();
    expect(fixture.onTouchPointerMove).toHaveBeenCalledOnce();
    expect(fixture.onTouchPointerStart).toHaveBeenCalledTimes(2);
    expect(fixture.onTouchTerminal).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(fixture.onTouchTerminal).toHaveBeenCalledWith(4);
    expect(fixture.hostPointerStarts).not.toHaveBeenCalled();
    fixture.dispose();
    vi.useRealTimers();
  });

  it("cancels deferred terminal recovery during disposal", () => {
    vi.useFakeTimers();
    const fixture = createFixture();

    dispatchPointer(fixture.surface, "pointerup", true, 9);
    fixture.dispose();
    vi.runOnlyPendingTimers();

    expect(fixture.onTouchTerminal).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("recovers active touch state when the owning window loses focus", () => {
    const fixture = createFixture();

    window.dispatchEvent(new Event("blur"));

    expect(fixture.onTouchInterrupted).toHaveBeenCalledOnce();
    fixture.dispose();
  });
});

function createFixture(blockTouch: boolean | (() => boolean) = false) {
  const host = htmlDiv();
  const surface = htmlDiv();
  host.append(surface);
  document.body.append(host);
  const hostStarts = vi.fn();
  const hostMoves = vi.fn();
  const hostEnds = vi.fn();
  const hostPointerStarts = vi.fn();
  const hostPointerMoves = vi.fn();
  const hostPointerUps = vi.fn();
  const onPenPointerCancel = vi.fn();
  const onPenPointerMove = vi.fn();
  const onPenPointerStart = vi.fn();
  const onPenPointerUp = vi.fn();
  const onPrimaryTouchStart = vi.fn();
  const onTouchInterrupted = vi.fn();
  const onTouchPointerMove = vi.fn();
  const onTouchPointerStart = vi.fn();
  const onTouchTerminal = vi.fn();
  host.addEventListener("touchstart", hostStarts);
  host.addEventListener("touchmove", hostMoves);
  host.addEventListener("touchend", hostEnds);
  host.addEventListener("pointerdown", hostPointerStarts);
  host.addEventListener("pointermove", hostPointerMoves);
  host.addEventListener("pointerup", hostPointerUps);
  const boundary = new CanvasTouchBoundary(surface, {
    onPenPointerCancel,
    onPenPointerMove,
    onPenPointerStart,
    onPenPointerUp,
    onPrimaryTouchStart,
    onTouchInterrupted,
    onTouchPointerMove,
    onTouchPointerStart,
    onTouchTerminal,
    shouldBlockTouchEvent: typeof blockTouch === "function" ? blockTouch : () => blockTouch,
  });
  return {
    dispose: () => {
      boundary.dispose();
      host.remove();
    },
    hostEnds,
    hostMoves,
    hostPointerStarts,
    hostPointerMoves,
    hostPointerUps,
    hostStarts,
    onPrimaryTouchStart,
    onPenPointerCancel,
    onPenPointerMove,
    onPenPointerStart,
    onPenPointerUp,
    onTouchInterrupted,
    onTouchPointerMove,
    onTouchPointerStart,
    onTouchTerminal,
    surface,
  };
}

function dispatchPointer(
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  isPrimary: boolean,
  pointerId: number,
  pointerType: "pen" | "touch" = "touch",
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    isPrimary: { value: isPrimary },
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchTouch(
  target: HTMLElement,
  type: "touchend" | "touchmove" | "touchstart",
  touches: readonly Touch[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touchList(touches) });
  target.dispatchEvent(event);
  return event;
}

function touch(identifier: number, clientX: number, clientY: number): Touch {
  return { clientX, clientY, identifier } as Touch;
}

function touchList(touches: readonly Touch[]): TouchList {
  return {
    ...touches,
    item: (index: number) => touches[index] ?? null,
    length: touches.length,
  };
}

function htmlDiv(): HTMLDivElement {
  return document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
}
