import { describe, expect, it, vi } from "vitest";

import type {
  PreparedPressureGeometryPort,
  PressureWindow,
} from "../../../../src/domain/geometry/prepared-pressure-geometry";
import { transformedStrokeCenters } from "../../../../src/domain/geometry/stroke-path";
import * as pressureUnion from "../../../../src/domain/geometry/pressure-union";
import { simplifyStrokeCenters } from "../../../../src/domain/geometry/stroke-simplification";
import { pressurePaintAdditionSteps } from "../../../../src/editor/selection/pressure-paint-additions";
import { elementContainsPoint } from "../../../../src/editor/selection/hit-test";
import {
  createRectangleSelectionArea,
  elementMatchesSelectionAreaSteps,
} from "../../../../src/editor/selection/selection-area";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import { strokeSvgContainsPoint } from "../../../fixtures/domain/svg-path-fill";
import { stroke } from "../../domain/schema/fixtures";

function fixture() {
  const target = {
    ...stroke(),
    points: [0, 0, 1, 20, 40, 1, 40, 0, 1],
    pivot: { x: 0, y: 0 },
    style: { ...stroke().style, width: 8 as const, pressureEnabled: true },
  };
  const windows = new Map<number, PressureWindow>();
  const prepared: PreparedPressureGeometryPort = {
    readWindow: (index) => windows.get(index),
    publishWindow: vi.fn((index: number, window: PressureWindow) => {
      windows.set(index, window);
    }),
  };
  return { target, windows, prepared };
}

describe("shared painted pressure windows", () => {
  it("reuses the renderer's exact outward patch for point and area selection", () => {
    const { target, prepared, windows } = fixture();
    const point = { x: 17.75, y: 23.37 };
    expect(strokeSvgContainsPoint(target, point, prepared)).toBe(true);
    expect(windows.size).toBe(1);
    const prepare = vi.spyOn(pressureUnion, "iteratePressureUnion");
    try {
      expect(elementContainsPoint(target, point, 0, prepared)).toBe(true);
      const area = createRectangleSelectionArea(
        { x: point.x - 0.001, y: point.y - 0.001 },
        { x: point.x + 0.001, y: point.y + 0.001 },
      );
      const steps = elementMatchesSelectionAreaSteps(
        area,
        target,
        "touched",
        calculateElementBounds(target),
        prepared,
      );
      let result = steps.next();
      while (!result.done) result = steps.next();
      expect(result.value).toBe(true);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("publishes only complete cold windows and abandons cancelled preparation", () => {
    const { target, prepared, windows } = fixture();
    const centers = simplifyStrokeCenters(
      transformedStrokeCenters(target),
      target.style.width,
      true,
    );
    const cancelled = pressurePaintAdditionSteps(centers, target.style.width, { prepared });
    expect(cancelled.next().done).toBe(false);
    expect(windows.size).toBe(0);
    cancelled.return(undefined);
    expect(windows.size).toBe(0);
    const complete = [
      ...pressurePaintAdditionSteps(centers, target.style.width, { prepared }),
    ].filter((value) => value !== undefined && typeof value !== "number");
    expect(complete.length).toBeGreaterThan(0);
    expect(windows.size).toBe(1);
    expect(windows.get(0)).toBeDefined();
  });
});
