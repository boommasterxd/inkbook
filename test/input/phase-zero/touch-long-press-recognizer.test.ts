/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact pointer coordinates exercise product thresholds. */
import { describe, expect, it } from "vitest";

import {
  TouchLongPressRecognizer,
  type TouchLongPressInput,
} from "../../../src/input/phase-zero";

const touch = (
  pointerId: number,
  clientX: number,
  clientY: number,
  kind: "native-markdown" | "plugin-element" = "plugin-element",
): TouchLongPressInput => ({
  button: 0,
  clientX,
  clientY,
  hit:
    kind === "plugin-element"
      ? ({ elementId: "shape-1", kind } as const)
      : ({ kind } as const),
  pointerId,
  pointerKind: "touch" as const,
});

describe("TouchLongPressRecognizer", () => {
  it("opens the frozen plugin menu only after the timer elapses", () => {
    const recognizer = new TouchLongPressRecognizer();
    expect(recognizer.pointerDown(touch(1, 20, 30))).toMatchObject({
      action: "schedule",
      delayMs: 500,
    });
    expect(recognizer.pointerMove(touch(1, 27.999, 30))).toEqual({
      action: "none",
      cancelTimer: false,
      preventDefault: false,
      stopPropagation: false,
    });

    expect(recognizer.timerElapsed()).toMatchObject({
      action: "open-menu",
      frozenHit: { elementId: "shape-1", kind: "plugin-element" },
      position: { x: 20, y: 30 },
      preventDefault: true,
    });
    expect(recognizer.contextMenu().action).toBe("suppress-native-menu");
    recognizer.pointerUp(1);
    expect(recognizer.state).toBe("idle");
  });

  it("cancels at the inclusive movement slop and for a third pointer", () => {
    const moved = new TouchLongPressRecognizer();
    moved.pointerDown(touch(1, 0, 0));
    expect(moved.pointerMove(touch(1, 8, 0))).toMatchObject({
      action: "none",
      cancelTimer: true,
    });
    expect(moved.timerElapsed().action).toBe("none");

    const multiTouch = new TouchLongPressRecognizer();
    multiTouch.pointerDown(touch(1, 0, 0));
    expect(multiTouch.pointerDown(touch(2, 20, 0))).toMatchObject({
      cancelTimer: false,
    });
    expect(multiTouch.pointerDown(touch(3, 40, 0))).toMatchObject({
      cancelTimer: true,
    });
    expect(multiTouch.state).toBe("idle");
  });

  it("leaves native, mouse, malformed, and unrelated input unclaimed", () => {
    const recognizer = new TouchLongPressRecognizer();
    expect(
      recognizer.pointerDown(touch(1, 0, 0, "native-markdown")).action,
    ).toBe("none");
    expect(
      recognizer.pointerDown({ ...touch(2, 0, 0), pointerKind: "mouse" })
        .action,
    ).toBe("none");
    expect(recognizer.pointerDown(touch(-1, 0, 0)).action).toBe("none");
    expect(recognizer.pointerUp(99).action).toBe("none");
    recognizer.pointerDown(touch(3, 0, 0));
    expect(recognizer.pointerMove(touch(3, Number.NaN, 0)).cancelTimer).toBe(
      true,
    );
  });

  it("cancels on release, cancellation, host claim, and disposal", () => {
    const recognizer = new TouchLongPressRecognizer();
    recognizer.pointerDown(touch(1, 0, 0));
    expect(recognizer.pointerUp(1).cancelTimer).toBe(true);
    recognizer.pointerDown(touch(2, 0, 0));
    expect(recognizer.pointerCancel(2).cancelTimer).toBe(true);
    recognizer.pointerDown(touch(3, 0, 0));
    expect(recognizer.hostClaimedGesture().cancelTimer).toBe(true);
    recognizer.pointerDown(touch(4, 0, 0));
    expect(recognizer.dispose().cancelTimer).toBe(true);
    expect(recognizer.dispose().action).toBe("none");
    expect(recognizer.pointerDown(touch(5, 0, 0)).action).toBe("none");
    expect(recognizer.state).toBe("disposed");
  });

  it("suppresses a premature native menu without bypassing the timer", () => {
    const recognizer = new TouchLongPressRecognizer();
    recognizer.pointerDown(touch(1, 4, 6));

    expect(recognizer.contextMenu()).toMatchObject({
      action: "suppress-native-menu",
      cancelTimer: false,
      position: { x: 4, y: 6 },
    });
    expect(recognizer.state).toBe("pending");
    expect(recognizer.timerElapsed().action).toBe("open-menu");
  });
});
