// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-magic-numbers -- Coordinates exercise the exact gesture boundary. */

import { describe, expect, it, vi } from "vitest";

import { DirectTouchZoomReservation } from "../../../../src/adapters/obsidian/views/direct-touch-zoom-reservation";

interface TestTouch {
  readonly clientX: number;
  readonly clientY: number;
  readonly identifier: number;
}

function touchEvent(
  type: string,
  changed: readonly TestTouch[],
  active: readonly TestTouch[],
  cancelable = true,
): TouchEvent {
  const event = new Event(type, { cancelable }) as TouchEvent;
  Object.defineProperties(event, {
    changedTouches: { value: touchList(changed) },
    touches: { value: touchList(active) },
  });
  return event;
}

function touchList(values: readonly TestTouch[]): TouchList {
  return {
    item: (index: number): Touch | null =>
      (values[index] as Touch | undefined) ?? null,
    length: values.length,
  } as TouchList;
}

function pair(): readonly [TestTouch, TestTouch] {
  return [
    { clientX: 0, clientY: 0, identifier: 1 },
    { clientX: 100, clientY: 0, identifier: 2 },
  ];
}

describe("DirectTouchZoomReservation", () => {
  it("leaves a one-finger sequence native", () => {
    const scale = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream: vi.fn(),
      reserveMoveStream: vi.fn(),
      scale,
    });
    const [first] = pair();
    const start = touchEvent("touchstart", [first], [first]);

    reservation.touchStart(start);

    expect(start.defaultPrevented).toBe(false);
    expect(scale).not.toHaveBeenCalled();
  });

  it("reserves the second contact and publishes current scale samples", () => {
    const releaseMoveStream = vi.fn();
    const scale = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream,
      reserveMoveStream: (): boolean => true,
      scale,
    });
    const [first, second] = pair();
    reservation.touchStart(touchEvent("touchstart", [first], [first]));
    const secondStart = touchEvent("touchstart", [second], [first, second]);
    reservation.touchStart(secondStart);
    const moved = { ...second, clientX: 108 };
    const move = touchEvent("touchmove", [moved], [first, moved]);

    reservation.touchMove(move);
    reservation.touchEnd(touchEvent("touchend", [moved], [first]));

    expect(secondStart.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(scale).toHaveBeenLastCalledWith(1.08);
    expect(releaseMoveStream).toHaveBeenCalledTimes(1);
  });

  it("does not claim when the move stream cannot be reserved", () => {
    const scale = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream: vi.fn(),
      reserveMoveStream: (): boolean => false,
      scale,
    });
    const [first, second] = pair();
    reservation.touchStart(touchEvent("touchstart", [first], [first]));
    const secondStart = touchEvent("touchstart", [second], [first, second]);

    reservation.touchStart(secondStart);

    expect(secondStart.defaultPrevented).toBe(false);
    expect(scale).not.toHaveBeenCalled();
  });
});

describe("DirectTouchZoomReservation failure and disposal", () => {
  it("yields a non-cancelable second contact to the host until it ends", () => {
    const reserveMoveStream = vi.fn(() => true);
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream: vi.fn(),
      reserveMoveStream,
      scale: vi.fn(),
    });
    const [first, second] = pair();
    reservation.touchStart(touchEvent("touchstart", [first], [first]));
    const secondStart = touchEvent(
      "touchstart",
      [second],
      [first, second],
      false,
    );

    reservation.touchStart(secondStart);
    reservation.touchEnd(touchEvent("touchend", [second], [first]));
    reservation.touchCancel(touchEvent("touchcancel", [first], []));

    expect(secondStart.defaultPrevented).toBe(false);
    expect(reserveMoveStream).not.toHaveBeenCalled();
  });

  it("releases when a reserved move cannot be canceled", () => {
    const releaseMoveStream = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream,
      reserveMoveStream: (): boolean => true,
      scale: vi.fn(),
    });
    const [first, second] = pair();
    reservation.touchStart(touchEvent("touchstart", [first], [first]));
    reservation.touchStart(touchEvent("touchstart", [second], [first, second]));

    reservation.touchMove(
      touchEvent("touchmove", [second], [first, second], false),
    );

    expect(releaseMoveStream).toHaveBeenCalledOnce();
  });

  it("releases a reservation when a third contact blocks the gesture", () => {
    const releaseMoveStream = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream,
      reserveMoveStream: (): boolean => true,
      scale: vi.fn(),
    });
    const [first, second] = pair();
    const third = { clientX: 50, clientY: 50, identifier: 3 };
    reservation.touchStart(touchEvent("touchstart", [first], [first]));
    reservation.touchStart(touchEvent("touchstart", [second], [first, second]));

    reservation.touchStart(
      touchEvent("touchstart", [third], [first, second, third]),
    );

    expect(releaseMoveStream).toHaveBeenCalledTimes(1);
  });

  it("disposes idempotently and releases an active reservation once", () => {
    const releaseMoveStream = vi.fn();
    const reservation = new DirectTouchZoomReservation({
      gestureClaimed: vi.fn(),
      releaseMoveStream,
      reserveMoveStream: (): boolean => true,
      scale: vi.fn(),
    });
    const [first, second] = pair();
    reservation.touchStart(touchEvent("touchstart", [first], [first]));
    reservation.touchStart(touchEvent("touchstart", [second], [first, second]));

    reservation.dispose();
    reservation.dispose();
    reservation.touchStart(touchEvent("touchstart", [first], [first]));
    reservation.touchMove(touchEvent("touchmove", [first], [first]));
    reservation.touchEnd(touchEvent("touchend", [first], []));
    reservation.touchCancel(touchEvent("touchcancel", [first], []));

    expect(releaseMoveStream).toHaveBeenCalledTimes(1);
  });
});
