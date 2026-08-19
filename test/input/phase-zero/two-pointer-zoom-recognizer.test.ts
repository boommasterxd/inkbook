/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact pointer coordinates exercise product thresholds and geometry. */
import { describe, expect, it } from "vitest";

import {
  TwoPointerZoomRecognizer,
  type PointerSample,
} from "../../../src/input/phase-zero";

const point = (
  pointerId: number,
  clientX: number,
  clientY: number,
): PointerSample => ({
  pointerId,
  clientX,
  clientY,
});

describe("TwoPointerZoomRecognizer", () => {
  it("leaves one pointer and sub-threshold distance changes unclaimed", () => {
    const recognizer = new TwoPointerZoomRecognizer();

    expect(recognizer.pointerDown(point(1, 0, 0)).preventDefault).toBe(false);
    expect(recognizer.pointerDown(point(2, 10, 0)).preventDefault).toBe(false);
    expect(recognizer.pointerMove(point(2, 17.999, 0))).toMatchObject({
      handled: false,
      preventDefault: false,
      capturePointerIds: [],
    });
    expect(recognizer.state).toBe("tracking-two");
  });

  it.each([
    [18, 1.8],
    [19, 1.9],
    [2, 0.2],
  ])("claims inclusive slop at distance %s", (x, scale) => {
    const recognizer = new TwoPointerZoomRecognizer();
    recognizer.pointerDown(point(4, 0, 0));
    recognizer.pointerDown(point(7, 10, 0));

    const result = recognizer.pointerMove(point(7, x, 0));

    expect(result).toMatchObject({
      handled: true,
      preventDefault: true,
      stopPropagation: true,
      capturePointerIds: [4, 7],
      zoom: {
        focalScreen: { x: x / 2, y: 0 },
        scaleFromStart: scale,
      },
    });
  });

  it("emits incremental focal zoom and releases all capture on release", () => {
    const recognizer = new TwoPointerZoomRecognizer();
    recognizer.pointerDown(point(1, 0, 0));
    recognizer.pointerDown(point(2, 10, 0));
    recognizer.pointerMove(point(2, 18, 0));

    const update = recognizer.pointerMove(point(1, 2, 4));
    expect(update.zoom?.focalScreen).toEqual({ x: 10, y: 2 });
    expect(update.capturePointerIds).toEqual([]);

    expect(recognizer.pointerUp(2)).toMatchObject({
      handled: true,
      releasePointerIds: [1, 2],
    });
    expect(recognizer.state).toBe("idle");
  });

  it("applies the complete accumulated scale when crossing slop", () => {
    const recognizer = new TwoPointerZoomRecognizer();
    recognizer.pointerDown(point(1, 0, 0));
    recognizer.pointerDown(point(2, 20, 0));
    recognizer.pointerMove(point(2, 27, 0));

    const firstClaim = recognizer.pointerMove(point(2, 28, 0));
    const liveUpdate = recognizer.pointerMove(point(2, 35, 0));

    expect(firstClaim.zoom?.scaleDelta).toBeCloseTo(1.4);
    expect(liveUpdate.zoom?.scaleDelta).toBeCloseTo(1.25);
  });
});

describe("TwoPointerZoomRecognizer live updates and termination", () => {
  it("emits continuous latest-sample deltas after claiming", () => {
    const recognizer = new TwoPointerZoomRecognizer();
    recognizer.pointerDown(point(1, 0, 0));
    recognizer.pointerDown(point(2, 100, 0));
    recognizer.pointerMove(point(2, 108, 0));

    const scales = [109, 110, 111, 112].map(
      (x) => recognizer.pointerMove(point(2, x, 0)).zoom?.scaleDelta,
    );

    expect(scales).toEqual([109 / 108, 110 / 109, 111 / 110, 112 / 111]);
  });

  it("cancels invalid pairs and additional-pointer races without zoom output", () => {
    const zeroDistance = new TwoPointerZoomRecognizer();
    zeroDistance.pointerDown(point(1, 3, 3));
    expect(zeroDistance.pointerDown(point(2, 3, 3)).handled).toBe(false);
    expect(zeroDistance.state).toBe("blocked");

    const thirdPointer = new TwoPointerZoomRecognizer();
    thirdPointer.pointerDown(point(1, 0, 0));
    thirdPointer.pointerDown(point(2, 10, 0));
    expect(thirdPointer.pointerDown(point(3, 20, 0))).toMatchObject({
      handled: false,
      preventDefault: false,
    });
    expect(thirdPointer.state).toBe("blocked");
    thirdPointer.pointerDown(point(4, 30, 0));
    thirdPointer.pointerUp(1);
    thirdPointer.pointerUp(2);
    thirdPointer.pointerUp(3);
    expect(thirdPointer.state).toBe("idle");
  });

  it("releases claimed pointers on cancellation, host claim, and idempotent disposal", () => {
    const recognizer = new TwoPointerZoomRecognizer();
    recognizer.pointerDown(point(1, 0, 0));
    recognizer.pointerDown(point(2, 10, 0));
    recognizer.pointerMove(point(2, 18, 0));

    expect(recognizer.hostClaimedGesture().releasePointerIds).toEqual([1, 2]);
    expect(recognizer.dispose().handled).toBe(false);
    expect(recognizer.dispose().handled).toBe(false);
    expect(recognizer.pointerDown(point(3, 0, 0)).handled).toBe(false);
    expect(recognizer.state).toBe("disposed");

    const cancelled = new TwoPointerZoomRecognizer();
    cancelled.pointerDown(point(1, 0, 0));
    cancelled.pointerDown(point(2, 10, 0));
    cancelled.pointerMove(point(2, 18, 0));
    expect(cancelled.pointerCancel(1).releasePointerIds).toEqual([1, 2]);
    expect(cancelled.state).toBe("idle");
  });

  it("ignores malformed and unrelated pointer events", () => {
    const recognizer = new TwoPointerZoomRecognizer();
    expect(recognizer.pointerDown(point(-1, 0, 0)).handled).toBe(false);
    expect(recognizer.pointerDown(point(1, Number.NaN, 0)).handled).toBe(false);
    expect(recognizer.pointerMove(point(99, 1, 1)).handled).toBe(false);
    expect(recognizer.pointerCancel(99).handled).toBe(false);
  });
});
