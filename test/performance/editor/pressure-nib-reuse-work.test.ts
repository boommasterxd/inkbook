import { afterEach, expect, it, vi } from "vitest";
import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import type { StrokeCenter } from "../../../src/domain/geometry/stroke-path";
import type {
  PreparedPressureGeometryPort,
  PressureWindow,
} from "../../../src/domain/geometry/pressure/prepared-pressure-geometry";
import * as radii from "../../../src/domain/geometry/pressure/pressure-radius";
import * as unions from "../../../src/domain/geometry/pressure/pressure-union";
import { pressurePaintAdditionSteps } from "../../../src/editor/selection/query/pressure-paint-additions";

afterEach(() => vi.restoreAllMocks());

function centers(count: number, stationary = false): StrokeCenter[] {
  return Array.from({ length: count }, (_, index) => ({
    x: stationary ? 0 : index * 10,
    y: 0,
    pressure: 0.5,
  }));
}

function windowPort() {
  const windows = new Map<number, PressureWindow>();
  const readWindow = vi.fn((index: number) => windows.get(index));
  const publishWindow = vi.fn((index: number, window: PressureWindow) => {
    windows.set(index, window);
  });
  const prepared: PreparedPressureGeometryPort = {
    readWindow,
    publishWindow,
  };
  return { windows, prepared, readWindow, publishWindow };
}

it.each([65, MAX_STROKE_POINTS])(
  "prepares each of %i adjacent nibs once when reusing exact painted windows",
  (count) => {
    const source = centers(count);
    const { windows, prepared, readWindow, publishWindow } = windowPort();
    const cold = [...pressurePaintAdditionSteps(source, 8, { prepared })];
    const windowCount = Math.ceil((count - 1) / 64);
    expect(windows.size).toBe(windowCount);
    const radius = vi.spyOn(radii, "pressureRadius");
    const union = vi.spyOn(unions, "iteratePressureUnion");
    readWindow.mockClear();
    publishWindow.mockClear();
    const warm = [...pressurePaintAdditionSteps(source, 8, { prepared })];
    // Cold window construction has extra cooperative yields; compare painted
    // additions and raw-interval checkpoints, which remain identical on reuse.
    expect(warm).toEqual(cold.filter((value) => value !== undefined));
    expect(radius).toHaveBeenCalledTimes(count);
    expect(readWindow).toHaveBeenCalledTimes(windowCount);
    expect(publishWindow).not.toHaveBeenCalled();
    expect(union).not.toHaveBeenCalled();
    // Counts include the production radius boundary, not test iteration. Inner
    // tangent arithmetic and allocations inside each nib remain uninstrumented.
    windows.clear();
    expect(windows.size).toBe(0);
  },
);

it.each([false, true])(
  "stops maximum-length preparation at the first checkpoint, stationary=%s",
  (stationary) => {
    const { windows, prepared, readWindow, publishWindow } = windowPort();
    const radius = vi.spyOn(radii, "pressureRadius");
    const union = vi.spyOn(unions, "iteratePressureUnion");
    const steps = pressurePaintAdditionSteps(centers(MAX_STROKE_POINTS, stationary), 8, {
      prepared,
    });
    expect(steps.next()).toEqual({ done: false, value: 32 });
    const reads = radius.mock.calls.length;
    if (stationary) {
      // Suppressed disks still admit shared scheduling. coveredDisk retains its
      // two adjacent capsules, each with two nibs, in addition to 33 primary nibs.
      expect(reads).toBeGreaterThanOrEqual(33);
      expect(reads).toBeLessThanOrEqual(33 + 32 * 4);
    } else expect(reads).toBe(33);
    steps.return(undefined);
    expect(steps.next().done).toBe(true);
    expect(radius).toHaveBeenCalledTimes(reads);
    expect(readWindow).not.toHaveBeenCalled();
    expect(publishWindow).not.toHaveBeenCalled();
    expect(union).not.toHaveBeenCalled();
    expect(windows.size).toBe(0);
  },
);
