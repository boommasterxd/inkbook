import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalElementPathPreparation } from "../../../../src/domain/geometry/canonical-element-path-preparation";
import * as windows from "../../../../src/domain/geometry/pressure/pressure-window";
import * as pressureWindows from "../../../../src/domain/geometry/pressure/pressure-path-serialization";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import {
  createMultiWindowPressureStroke,
  createTestStroke,
} from "../../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.restoreAllMocks());

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
    const output = { readWindow: () => undefined, publishWindow: vi.fn(), publishPath: vi.fn() };
    const job = new CanonicalElementPathPreparation(stroke, undefined, "path-only", output);
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
      expect(output.publishWindow).not.toHaveBeenCalled();
      expect(output.publishPath).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("does not let an output cache bypass external sample validation", () => {
    const stroke = { ...createTestStroke(), points: [NaN, 10, 0.5] };
    const cache = {
      readCenters: vi.fn(() => [{ x: 0, y: 0, pressure: 0.5 }]),
      readPath: vi.fn(() => [{ d: "M0 0Z", paint: "fill" as const }]),
      readWindow: vi.fn(),
      publishPath: vi.fn(),
    };
    const job = new CanonicalElementPathPreparation(stroke, undefined, "path-only", cache);
    expect(() => job.step()).toThrow("Stroke samples must be finite.");
    expect(cache.readPath).not.toHaveBeenCalled();
    expect(cache.readCenters).not.toHaveBeenCalled();
    expect(cache.readWindow).not.toHaveBeenCalled();
    expect(cache.publishPath).not.toHaveBeenCalled();
    job.cancel();
    expect(job.memoryUsage()).toBe(0);
  });
});

it("uses the store's exact window measurement during full canonical preparation", () => {
  const element = createMultiWindowPressureStroke();
  const measurement = vi.spyOn(pressureWindows, "pressureWindowMemoryUsage");
  const published: pressureWindows.PressureWindow[] = [];
  const job = new CanonicalElementPathPreparation(element, {
    readWindow: () => undefined,
    publishWindow: (_index, window) => {
      published.push(window);
      return { window, numericBytes: pressureWindows.pressureWindowMemoryUsage(window) };
    },
  });
  while (!job.step()) {
    /* Finish the unchanged full selection-geometry publication path. */
  }
  expect(published.length).toBeGreaterThan(0);
  expect(measurement).toHaveBeenCalledTimes(published.length);
  expect(job.parts).toEqual(buildElementPathParts(element));
});

it("recounts full geometry when a port reports another window's measurement", () => {
  const usage = vi.spyOn(pressureWindows, "pressureWindowMemoryUsage");
  let published = 0;
  const job = new CanonicalElementPathPreparation(createMultiWindowPressureStroke(), {
    readWindow: () => undefined,
    publishWindow: () => {
      published += 1;
      return { window: { kind: "window", additions: [], loops: [] }, numericBytes: 0 };
    },
  });
  while (!job.step()) {
    /* Reject a foreign measurement while preserving full preparation. */
  }
  expect(published).toBeGreaterThan(0);
  expect(usage).toHaveBeenCalledTimes(published);
});
