/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact pointer coordinates exercise the product threshold. */
import { describe, expect, it } from "vitest";

import {
  OutsideTapSelectionRecognizer,
  type OutsideTapSelectionInput,
} from "../../../src/input/phase-zero";

const outsideTouch = (
  pointerId: number,
  clientX: number,
  clientY: number,
): OutsideTapSelectionInput => ({
  button: 0,
  clientX,
  clientY,
  hit: { kind: "native-markdown" } as const,
  pointerId,
  pointerKind: "touch" as const,
  selectionActive: true,
});

describe("OutsideTapSelectionRecognizer", () => {
  it("dismisses selection only after a stationary outside touch completes", () => {
    const recognizer = new OutsideTapSelectionRecognizer();
    expect(recognizer.pointerDown(outsideTouch(1, 20, 30))).toEqual({
      dismissSelection: false,
    });
    expect(recognizer.pointerMove(outsideTouch(1, 27.999, 30))).toEqual({
      dismissSelection: false,
    });
    expect(recognizer.pointerUp(1)).toEqual({ dismissSelection: true });
  });

  it("preserves selection for scrolling at the inclusive movement slop", () => {
    const recognizer = new OutsideTapSelectionRecognizer();
    recognizer.pointerDown(outsideTouch(1, 0, 0));
    recognizer.pointerMove(outsideTouch(1, 8, 0));

    expect(recognizer.pointerUp(1).dismissSelection).toBe(false);
  });

  it("preserves selection for plugin targets, inactive selection, and multi-touch", () => {
    const recognizer = new OutsideTapSelectionRecognizer();
    expect(
      recognizer.pointerDown({
        ...outsideTouch(1, 0, 0),
        hit: { elementId: "shape-1", kind: "plugin-element" },
      }).dismissSelection,
    ).toBe(false);
    expect(
      recognizer.pointerDown({
        ...outsideTouch(1, 0, 0),
        selectionActive: false,
      }).dismissSelection,
    ).toBe(false);
    recognizer.pointerDown(outsideTouch(1, 0, 0));
    recognizer.pointerDown(outsideTouch(2, 20, 0));
    expect(recognizer.pointerUp(1).dismissSelection).toBe(false);
  });

  it("cancels for pointer cancellation, host claim, disposal, and malformed input", () => {
    const recognizer = new OutsideTapSelectionRecognizer();
    recognizer.pointerDown(outsideTouch(1, 0, 0));
    recognizer.pointerCancel(1);
    expect(recognizer.pointerUp(1).dismissSelection).toBe(false);
    recognizer.pointerDown(outsideTouch(2, 0, 0));
    recognizer.hostClaimedGesture();
    expect(recognizer.pointerUp(2).dismissSelection).toBe(false);
    expect(
      recognizer.pointerDown(outsideTouch(-1, 0, 0)).dismissSelection,
    ).toBe(false);
    recognizer.pointerDown(outsideTouch(3, 0, 0));
    recognizer.pointerMove(outsideTouch(3, Number.NaN, 0));
    expect(recognizer.pointerUp(3).dismissSelection).toBe(false);
    recognizer.pointerDown(outsideTouch(3, 0, 0));
    recognizer.dispose();
    expect(recognizer.pointerUp(3).dismissSelection).toBe(false);
    expect(recognizer.pointerDown(outsideTouch(4, 0, 0)).dismissSelection).toBe(
      false,
    );
  });
});
