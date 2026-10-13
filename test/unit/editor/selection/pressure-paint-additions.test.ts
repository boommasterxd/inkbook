import { strokePrimitiveSteps } from "../../../../src/editor/selection/stroke-selection-geometry";
import { translatedStroke } from "../../../../src/domain/geometry/stroke-position";
import { describe, expect, it, vi } from "vitest";

import type {
  PreparedPressureGeometryPort,
  PressureWindow,
} from "../../../../src/domain/geometry/prepared-pressure-geometry";
import {
  transformedStrokeCenters,
  type StrokeCenter,
} from "../../../../src/domain/geometry/stroke-path";
import * as pressureUnion from "../../../../src/domain/geometry/pressure-union";
import * as pressureOutline from "../../../../src/domain/geometry/pressure-outline";
import * as pressureWindow from "../../../../src/domain/geometry/pressure-window";
import { buildPressureCapsule } from "../../../../src/domain/geometry/pressure-joins";
import { simplifyStrokeCenters } from "../../../../src/domain/geometry/stroke-simplification";
import { pressurePaintAdditionSteps } from "../../../../src/editor/selection/pressure-paint-additions";
import { elementContainsPoint } from "../../../../src/editor/selection/hit-test";
import { elementMatchesSelectionAreaSteps } from "../../../../src/editor/selection/selection-area";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import { strokeSvgContainsPoint } from "../../../fixtures/domain/svg-path-fill";
import { stroke } from "../../domain/schema/fixtures";
import { rectangleSelectionAround } from "../../../fixtures/editor/selection-query";

function fixture() {
  const target = {
    ...stroke(),
    points: [0, 0, 1, 20, 40, 1, 40, 0, 1],
    pivot: { x: 0, y: 0 },
    style: { ...stroke().style, width: 8 as const, pressureEnabled: true },
  };
  const windows = new Map<number, PressureWindow>();
  const publishWindow = vi.fn((index: number, window: PressureWindow) => {
    windows.set(index, window);
  });
  const prepared: PreparedPressureGeometryPort = {
    readWindow: (index) => windows.get(index),
    publishWindow,
  };
  return { target, windows, prepared, publishWindow };
}

const windowBoundaryCenters = Array.from({ length: 66 }, (_, index) => ({
  x: index * 20,
  y: index % 2 ? 10 : 0,
  pressure: 0.5,
}));

it.each([63, 64, 65])("preserves exact emitted-window identity at %s pieces", (count) => {
  const { prepared, windows, publishWindow } = fixture();
  const centers = windowBoundaryCenters.slice(0, count + 1);
  const chunks: (readonly pressureOutline.PressureOutlinePiece[])[] = [];
  const prepare = vi.spyOn(pressureWindow, "preparePressureWindowSteps");
  prepare.mockImplementation(function* (pieces): Generator<void, PressureWindow> {
    chunks.push([...pieces]);
    yield;
    return {
      kind: "window",
      loops: [],
      additions: [[{ x: chunks.length, y: 0 }]],
    };
  });
  try {
    const expected = centers.slice(1).map((end, index) => ({
      kind: "strip",
      capsule: buildPressureCapsule(centers[index]!, end, 8),
      width: 8,
    }));
    const output = [...pressurePaintAdditionSteps(centers, 8, { prepared })];
    expect(chunks).toEqual(count <= 64 ? [expected] : [expected.slice(0, 64), expected.slice(64)]);
    expect(output.filter((value) => typeof value === "number")).toEqual(
      Array.from({ length: Math.floor(count / 32) }, () => 32),
    );
    expect(output.filter(Array.isArray)).toEqual(
      [...windows.values()].flatMap((window) => window.additions),
    );
    expect(publishWindow).toHaveBeenCalledTimes(Math.ceil(count / 64));
    prepare.mockClear();
    expect([...pressurePaintAdditionSteps(centers, 8, { prepared })]).toEqual(
      output.filter((value) => value !== undefined),
    );
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
  }
});

it("counts suppressed intervals for checkpoints without creating extra windows", () => {
  const { prepared, windows, publishWindow } = fixture();
  const centers = Array.from({ length: 130 }, () => ({ x: 0, y: 0, pressure: 1 }));
  const output = [...pressurePaintAdditionSteps(centers, 8, { prepared })];
  expect(output.filter((value) => typeof value === "number")).toEqual([32, 32, 32, 32]);
  expect(windows.size).toBe(1);
  expect(windows.get(0)!.loops).toHaveLength(1);
  expect(publishWindow).toHaveBeenCalledTimes(1);
  expect(output.filter(Array.isArray)).toEqual(windows.get(0)!.additions);
});

it("closes the shared outline iterator when cancelled at a raw-interval checkpoint", () => {
  const original = pressureOutline.iteratePreparedPressureOutline;
  let closed = false;
  const outline = vi.spyOn(pressureOutline, "iteratePreparedPressureOutline");
  outline.mockImplementation(function* (...args) {
    try {
      yield* original(...args);
    } finally {
      closed = true;
    }
  });
  try {
    const { prepared, windows } = fixture();
    const steps = pressurePaintAdditionSteps(windowBoundaryCenters, 8, { prepared });
    expect(steps.next()).toEqual({ done: false, value: 32 });
    expect(closed).toBe(false);
    steps.return(undefined);
    expect(closed).toBe(true);
    expect(windows.size).toBe(0);
    expect(steps.next().done).toBe(true);
  } finally {
    outline.mockRestore();
  }
});

it("cancels an addition guard without starting a pressure window", () => {
  const { target } = fixture();
  let advances = 0;
  let closed = false;
  function* guard() {
    try {
      advances += 1;
      yield 32;
      advances += 1;
      return true;
    } finally {
      closed = true;
    }
  }
  const union = vi.spyOn(pressureUnion, "iteratePressureUnion");
  try {
    const steps = strokePrimitiveSteps(target, { additionsMayTouch: guard });
    while (advances === 0 && !steps.next().done) {
      // The guard runs after the bounded capsule stream.
    }
    expect(advances).toBe(1);
    steps.return(undefined);
    expect(closed).toBe(true);
    expect(advances).toBe(1);
    expect(union).not.toHaveBeenCalled();
  } finally {
    union.mockRestore();
  }
});

it.each([
  { x: 0, y: 0 },
  { x: 100, y: 200 },
  { x: -100.003, y: -200.007 },
])("passes world-space centers to the positioned addition guard at $x, $y", (offset) => {
  const { target } = fixture();
  const moved = translatedStroke(target, offset);
  const original = simplifyStrokeCenters(
    transformedStrokeCenters(target),
    target.style.width,
    true,
  );
  const guard = vi.fn(function* (centers: readonly StrokeCenter[]) {
    expect(centers).toEqual(
      original.map((center) => ({
        ...center,
        x: center.x + offset.x,
        y: center.y + offset.y,
      })),
    );
    yield centers.length;
    return false;
  });
  const union = vi.spyOn(pressureUnion, "iteratePressureUnion");
  try {
    Array.from(strokePrimitiveSteps(moved, { additionsMayTouch: guard }));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(union).not.toHaveBeenCalled();
  } finally {
    union.mockRestore();
  }
});

it("cancels positioned-center translation before the addition guard runs", () => {
  const { target } = fixture();
  const points = Array.from({ length: 130 }, (_, index) => [index, index % 2 ? 100 : 0, 1]).flat();
  const guard = vi.fn(function* () {
    yield 1;
    return true;
  });
  const steps = strokePrimitiveSteps(translatedStroke({ ...target, points }, { x: -2, y: 3 }), {
    additionsMayTouch: guard,
  });
  let result = steps.next();
  while (!result.done && (typeof result.value !== "number" || result.value > 32))
    result = steps.next();
  expect(result.done).toBe(false);
  steps.return(undefined);
  expect(guard).not.toHaveBeenCalled();
  expect(steps.next().done).toBe(true);
});

describe("shared painted pressure windows", () => {
  it("reuses the renderer's exact outward patch for point and area selection", () => {
    const { target, prepared, windows } = fixture();
    const point = { x: 17.75, y: 23.37 };
    expect(strokeSvgContainsPoint(target, point, prepared)).toBe(true);
    expect(windows.size).toBe(1);
    const prepare = vi.spyOn(pressureUnion, "iteratePressureUnion");
    try {
      expect(elementContainsPoint(target, point, 0, prepared)).toBe(true);
      const area = rectangleSelectionAround(point, 0.001);
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

  it.each([0.003, -1000.007])(
    "translates local edge paint without re-quantizing at offset %s",
    (x) => {
      const { target, prepared, windows } = fixture();
      const point = { x: 17.75, y: 23.37 };
      expect(strokeSvgContainsPoint(target, point, prepared)).toBe(true);
      const offset = { x, y: x + 0.002 };
      const moved = translatedStroke(target, offset);
      const worldPoint = { x: point.x + offset.x, y: point.y + offset.y };
      const area = rectangleSelectionAround(worldPoint, 0.001);
      const readWindow = vi.spyOn(prepared, "readWindow");
      const publishWindow = vi.spyOn(prepared, "publishWindow");
      publishWindow.mockClear();
      const polygons = [
        ...strokePrimitiveSteps(moved, {
          bounds: area.bounds,
          prepared,
          nearPoint: { point: worldPoint, radius: 0.2 },
        }),
      ].filter(
        (value) => value !== undefined && typeof value !== "number" && value.kind === "polygon",
      );
      expect(polygons).toEqual(
        windows.get(0)!.additions.map((points) => ({
          kind: "polygon",
          points: points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })),
        })),
      );
      expect(polygons.length).toBeGreaterThan(0);
      const steps = elementMatchesSelectionAreaSteps(
        area,
        moved,
        "touched",
        calculateElementBounds(moved),
        prepared,
      );
      let result = steps.next();
      while (!result.done) result = steps.next();
      expect(result.value).toBe(true);
      expect(readWindow).not.toHaveBeenCalled();
      expect(publishWindow).not.toHaveBeenCalled();
    },
  );

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
