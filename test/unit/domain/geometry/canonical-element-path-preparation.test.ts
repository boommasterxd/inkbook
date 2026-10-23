import { describe, expect, it, vi } from "vitest";
import { CanonicalElementPathPreparation } from "../../../../src/domain/geometry/canonical-element-path-preparation";
import * as windows from "../../../../src/domain/geometry/pressure/pressure-window";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import {
  createMultiWindowPressureStroke,
  createTestStroke,
} from "../../../fixtures/persistence/worker-snapshot";

describe("path-only canonical preparation", () => {
  it.each([1, 2, 65, 131, MAX_STROKE_POINTS])(
    "preserves full canonical path bytes and raw samples for %i samples",
    (count) => {
      const stroke = {
        ...createTestStroke(),
        rotation: 0.37,
        offset: { x: 12, y: 25 },
        points: Array.from({ length: count }, (_, index) => [
          index * 3,
          (index % 7) * 0.1,
          0.1 + (index % 9) / 10,
        ]).flat(),
      };
      const original = [...stroke.points];
      const full = new CanonicalElementPathPreparation(stroke);
      const path = new CanonicalElementPathPreparation(stroke, undefined, "path-only");
      while (!full.stepOperation()) {
        /* Finish bounded full preparation. */
      }
      while (!path.stepOperation()) {
        /* Finish bounded path-only preparation. */
      }
      expect(path.parts).toEqual(full.parts);
      expect(stroke.points).toEqual(original);
      expect(path.stepOperation()).toBe(true);
      expect(path.memoryUsage()).toBe(path.parts![0]!.d.length * 2);
      path.cancel();
      expect(path.memoryUsage()).toBe(0);
      expect(path.stepOperation()).toBe(false);
    },
  );

  it("rejects a selection publication port in path-only mode", () => {
    const port = { readWindow: () => undefined, publishWindow: vi.fn() };
    expect(
      () => new CanonicalElementPathPreparation(createTestStroke(), port, "path-only"),
    ).toThrow("Path-only preparation cannot publish selection geometry.");
    expect(port.publishWindow).not.toHaveBeenCalled();
  });

  it("accounts suspended scratch and releases partial path-only preparation on cancellation", () => {
    const prepare = vi.spyOn(windows, "preparePressureWindowSteps");
    const stroke = createMultiWindowPressureStroke();
    const job = new CanonicalElementPathPreparation(stroke, undefined, "path-only");
    try {
      while (prepare.mock.calls.length === 0) job.step(0, () => 1);
      expect(job.memoryUsage()).toBeGreaterThanOrEqual(windows.PRESSURE_WINDOW_SCRATCH_BYTES);
      const iterator = prepare.mock.results[0]!.value as Generator;
      const close = vi.spyOn(iterator, "return");
      job.cancel();
      expect(close).toHaveBeenCalledOnce();
      expect(job.memoryUsage()).toBe(0);
      expect(job.parts).toBeUndefined();
      expect(job.stepOperation()).toBe(false);
    } finally {
      prepare.mockRestore();
    }
  });
});
