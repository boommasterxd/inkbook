import { translatedStroke } from "../../../src/domain/geometry/stroke-position";
import * as geometryPrimitives from "../../../src/domain/geometry/primitives";
import * as strokeCenters from "../../../src/domain/geometry/stroke-path";
import { strokePrimitiveSteps } from "../../../src/editor/selection/stroke-selection-geometry";
import * as pressureUnion from "../../../src/domain/geometry/pressure-union";
import * as pressureIntersections from "../../../src/domain/geometry/pressure-boundary-intersections";
import { pressurePaintAdditionSteps } from "../../../src/editor/selection/pressure-paint-additions";
import { describe, expect, it, vi } from "vitest";

import * as pressureWindows from "../../../src/domain/geometry/pressure-window";
import * as pressureCapsuleSelection from "../../../src/domain/geometry/pressure-capsule-selection";
import * as pressureJoins from "../../../src/domain/geometry/pressure-joins";
import { calculateElementBounds } from "../../../src/domain/geometry/public";
import * as geometryBounds from "../../../src/domain/geometry/public";
import { LassoSelectionSession } from "../../../src/editor/selection/lasso-selection-session";
import {
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
} from "../../../src/editor/selection/overlay-geometry";
import {
  createRectangleSelectionArea,
  elementMatchesSelectionAreaSteps,
  createLassoSelectionArea,
} from "../../../src/editor/selection/selection-area";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { visitVisibleElementPrimitives } from "../../../src/editor/selection/element-selection-geometry";
import { elementContainsPoint } from "../../../src/editor/selection/hit-test";
import { coordinateSystem, rectangle } from "../../unit/domain/geometry/fixtures";
import {
  primitiveEnclosedByAreaSteps,
  primitiveTouchesAreaSteps,
} from "../../../src/editor/selection/selection-area-primitives";
import { maximumStroke } from "./maximum-stroke-fixture";
import { indexedLassoEdges } from "../../../src/editor/selection/lasso-edge-index";

it("charges and cancels dense lasso bin construction and duplicate query visits", () => {
  const points = Array.from({ length: 512 }, (_, index) => ({
    x: index,
    y: index % 2 === 0 ? -100 : 100,
  }));
  const bounds = { minX: 0, minY: -100, maxX: 511, maxY: 100 };
  const cancelled = indexedLassoEdges(points, bounds, bounds);
  expect(cancelled.next().value).toBe(32);
  cancelled.return([]);
  expect(cancelled.next().done).toBe(true);
  const query = indexedLassoEdges(points, bounds, bounds);
  let charged = 0;
  let result = query.next();
  while (!result.done) {
    expect(result.value).toBeLessThanOrEqual(32);
    charged += result.value;
    result = query.next();
  }
  expect(result.value).toHaveLength(512);
  expect(charged).toBe(1087);
});

it("bounds actual indexed lasso edge work across 10,000 interior candidates", () => {
  const points = Array.from({ length: 512 }, (_, index) => ({
    x: 500 + 400 * Math.cos((index * 2 * Math.PI) / 512),
    y: 500 + 400 * Math.sin((index * 2 * Math.PI) / 512),
  }));
  const area = createLassoSelectionArea(points);
  const stroke = indexedStroke(0);
  let charged = 0;
  const edgeCheck = vi.spyOn(geometryBounds, "boundsIntersect");
  try {
    for (let candidate = 0; candidate < 10_000; candidate += 1) {
      const x = 490 + (candidate % 20);
      const y = 490 + (Math.floor(candidate / 20) % 20);
      const bounds = { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 };
      const steps = elementMatchesSelectionAreaSteps(area, stroke, "fully-enclosed", bounds);
      let result = steps.next();
      while (!result.done) {
        charged += result.value ?? 64;
        expect(result.value).toBeLessThanOrEqual(32);
        result = steps.next();
      }
      expect(result.value).toBe(true);
    }
    const actualEdgeChecks = edgeCheck.mock.calls.filter(([left]) => "start" in left).length;
    expect(actualEdgeChecks).toBeGreaterThan(0);
    expect(actualEdgeChecks).toBeLessThan(400_000);
    expect(charged).toBeLessThan(80_000);
  } finally {
    edgeCheck.mockRestore();
  }
});

it.each(
  [true, false].flatMap((pressureEnabled) =>
    [false, true].map((positioned) => ({ pressureEnabled, positioned })),
  ),
)(
  "bounds raw reads before an early hit (pressure=$pressureEnabled, positioned=$positioned)",
  ({ pressureEnabled, positioned }) => {
    const offset = positioned ? { x: 0.003, y: -0.007 } : { x: 0, y: 0 };
    const target = positioned ? translatedStroke(maximumStroke(0), offset) : maximumStroke(0);
    let reads = 0;
    const points = new Proxy(target.points, {
      get: (source, key) => {
        if (key === "length") return source.length;
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads += 1;
          return source[Number(key)];
        }
        throw new Error("Unexpected sample access");
      },
    });
    const area = createRectangleSelectionArea(
      { x: -1 + offset.x, y: 99 + offset.y },
      { x: 1 + offset.x, y: 101 + offset.y },
    );
    const steps = elementMatchesSelectionAreaSteps(
      area,
      {
        ...target,
        points,
        style: { ...target.style, pressureEnabled },
      },
      "touched",
      calculateElementBounds(target),
    );
    let result = steps.next();
    let previousReads = 0;
    while (!result.done) {
      expect(reads - previousReads).toBeLessThanOrEqual(65 * 9);
      previousReads = reads;
      result = steps.next();
    }
    expect(result.value).toBe(true);
    expect(reads).toBeLessThanOrEqual(130 * 9);
    const cancelled = elementMatchesSelectionAreaSteps(
      area,
      { ...target, points },
      "touched",
      calculateElementBounds(target),
    );
    cancelled.next();
    cancelled.return(false);
    const beforeCancelledAdvance = reads;
    expect(cancelled.next().done).toBe(true);
    expect(reads).toBe(beforeCancelledAdvance);

    reads = 0;
    const windows = vi.spyOn(pressureWindows, "preparePressureWindows");
    const missed = elementMatchesSelectionAreaSteps(
      createRectangleSelectionArea({ x: 0, y: 900 }, { x: 20_000, y: 901 }),
      { ...target, points, style: { ...target.style, pressureEnabled } },
      "touched",
      { minX: 0, minY: 0, maxX: 20_000, maxY: 1000 },
    );
    previousReads = 0;
    let missResult = missed.next();
    while (!missResult.done) {
      expect(reads - previousReads).toBeLessThanOrEqual(65 * 9);
      previousReads = reads;
      missResult = missed.next();
    }
    expect(windows).not.toHaveBeenCalled();
    windows.mockRestore();
    expect(missResult.value).toBe(false);
    const sampleCount = target.points.length / 3;
    expect(reads).toBeLessThanOrEqual((sampleCount + Math.ceil(sampleCount / 64)) * 9);
  },
);

it("yields bounded polygon-edge work for a maximum lasso enclosure", () => {
  let reads = 0;
  const input = Array.from({ length: 512 }, (_, index) => ({
    x: Math.cos((index * Math.PI) / 256) * 100,
    y: Math.sin((index * Math.PI) / 256) * 100,
  }));
  const base = createLassoSelectionArea(input);
  const area = {
    ...base,
    points: input.map((point) => ({
      get x() {
        reads += 1;
        return point.x;
      },
      get y() {
        reads += 1;
        return point.y;
      },
    })),
  };
  const steps = primitiveEnclosedByAreaSteps(area, {
    kind: "capsule",
    start: { x: -50, y: 0 },
    end: { x: 50, y: 0 },
    radius: 1,
  });
  let previousReads = 0;
  let result = steps.next();
  let yields = 0;
  while (!result.done) {
    expect(reads - previousReads).toBeLessThanOrEqual(32_768);
    previousReads = reads;
    yields += 1;
    result = steps.next();
  }
  expect(reads - previousReads).toBeLessThanOrEqual(32_768);
  expect(yields).toBeGreaterThanOrEqual(16);
  expect(result.value).toBe(true);
  reads = 0;
  const miss = primitiveTouchesAreaSteps(area, {
    kind: "polygon",
    points: [
      { x: 90, y: 90 },
      { x: 110, y: 90 },
      { x: 110, y: 110 },
      { x: 90, y: 110 },
    ],
  });
  let missResult = miss.next();
  let missYields = 0;
  while (!missResult.done) {
    missYields += 1;
    missResult = miss.next();
  }
  expect(missResult.value).toBe(false);
  expect(missYields).toBeLessThanOrEqual(128);
  expect(reads).toBeLessThanOrEqual(100_000);
});

it("reuses compact pressure indexes and tests only candidate block nibs", () => {
  const original = maximumStroke(0);
  let reads = 0;
  const points = new Proxy(original.points, {
    get(source, key, receiver): unknown {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(source, key, receiver);
    },
  });
  const stroke = { ...original, points };
  expect(elementContainsPoint(stroke, { x: 10_000, y: 100 }, 0)).toBe(true);
  reads = 0;
  const build = vi.spyOn(pressureJoins, "buildPressureCapsule");
  const contains = vi.spyOn(pressureCapsuleSelection, "pressureCapsuleContainsPoint");
  try {
    expect(elementContainsPoint(stroke, { x: 10_001, y: 100 }, 0)).toBe(true);
    expect(reads).toBe(0);
    expect(build).not.toHaveBeenCalled();
    expect(contains.mock.calls.length).toBeGreaterThan(0);
    expect(contains.mock.calls.length).toBeLessThanOrEqual(64);
  } finally {
    build.mockRestore();
    contains.mockRestore();
  }
});

describe("selection hot paths", () => {
  it("keeps point and tiny-axis selection visits bounded by axis count", () => {
    for (const length of [0, 0.001]) {
      const origin = { x: 100, y: 100 };
      const element = coordinateSystem();
      element.origin = origin;
      element.axes = [
        { x: 100 + length, y: 100 },
        { x: 100, y: 100 - length },
      ];
      const visit = vi.fn(() => true);
      expect(visitVisibleElementPrimitives(element, visit)).toBe(true);
      expect(visit).toHaveBeenCalledTimes(length === 0 ? 2 : 6);
    }
  });

  it("bounds collapsed ellipse hit testing to four dimension reads", () => {
    const dimensions = vi.fn(() => 0);
    const element = rectangle({ kind: "ellipse", pivot: { x: 0, y: 0 } });
    Object.defineProperties(element, {
      width: { get: dimensions },
      height: { get: dimensions },
    });
    expect(elementContainsPoint(element, { x: 0, y: 0 }, 0)).toBe(true);
    // Two radius reads and two segment-end reads; no sampled ellipse path.
    expect(dimensions).toHaveBeenCalledTimes(4);
  });

  it("reduces a maximum coalesced lasso batch to bounded storage", () => {
    const samples = Array.from({ length: 4_096 }, (_, index) => ({
      x: index * 2,
      y: 40 + Math.sin(index / 12) * 24,
    }));
    const session = new LassoSelectionSession({ x: 0, y: 40 }, 1);
    session.appendBatch(samples);
    expect(session.points.length).toBeLessThanOrEqual(512);
    expect(session.points.length).toBeGreaterThan(0);
  });

  it("keeps the 10,000-stroke group overlay bounded", () => {
    const selected = Array.from({ length: 10_000 }, (_, index) => {
      const element = indexedStroke(index);
      return { bounds: calculateElementBounds(element), element };
    });
    const geometry = selectionOverlayGeometry(selected, 1);
    expect(geometry?.outline.kind).toBe("polygon");
    expect(geometry?.handles).toHaveLength(9);
    expect(selectionOverlayContainsPoint(selected, { x: 1_000, y: 100 })).toBe(true);
    expect(selectionOverlayContainsPoint(selected, { x: -1_000, y: -100 })).toBe(false);
  });
});

it.each(["touched", "fully-enclosed"] as const)(
  "bounds actual analytic capsule edge checks for a maximum %s lasso",
  (inclusion) => {
    const enclosed = inclusion === "fully-enclosed";
    const radius = enclosed ? 100 : 10;
    const center = enclosed ? 0 : 10;
    const area = createLassoSelectionArea(
      Array.from({ length: 512 }, (_, index) => ({
        x: center + Math.cos((index * Math.PI) / 256) * radius,
        y: center + Math.sin((index * Math.PI) / 256) * radius,
      })),
    );
    const primitive = {
      kind: "pressure-capsule" as const,
      capsule: {
        start: { center: { x: 0.5, y: 0.5 }, radius: 0.1 },
        end: { center: { x: 1.5, y: 0.5 }, radius: 0.2 },
      },
    };
    const check = vi.spyOn(pressureCapsuleSelection, "pressureCapsuleSegmentMargin");
    const geometry = vi.spyOn(pressureJoins, "buildPressureCapsule");
    const steps = enclosed
      ? primitiveEnclosedByAreaSteps(area, primitive)
      : primitiveTouchesAreaSteps(area, primitive);
    try {
      let previous = 0;
      let result = steps.next();
      while (true) {
        const current = check.mock.calls.length;
        expect(current - previous).toBeLessThanOrEqual(enclosed ? 16 : 32);
        previous = current;
        if (result.done) break;
        result = steps.next();
      }
      expect(result.value).toBe(enclosed);
      if (enclosed) expect(check).toHaveBeenCalledTimes(512);
      else expect(check.mock.calls.length).toBeLessThan(64);
      expect(geometry).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
      geometry.mockRestore();
    }
  },
);

it("rejects a maximum-stroke interior gap before any capsule or union construction", () => {
  const target = maximumStroke(0);
  const corners = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  const points = Array.from({ length: target.points.length / 3 }, (_, index) => [
    ...corners[index % 4]!,
    1,
  ]).flat();
  const build = vi.spyOn(pressureJoins, "buildPressureCapsule");
  const union = vi.spyOn(pressureUnion, "iteratePressureUnion");
  const contains = vi.spyOn(pressureCapsuleSelection, "pressureCapsuleContainsPoint");
  try {
    expect(elementContainsPoint({ ...target, points }, { x: 50, y: 50 }, 0)).toBe(false);
    expect(build).not.toHaveBeenCalled();
    expect(union).not.toHaveBeenCalled();
    expect(contains.mock.calls.length).toBeGreaterThan(0);
    expect(contains.mock.calls.length).toBeLessThanOrEqual((points.length / 3 - 1) * 2);
  } finally {
    build.mockRestore();
    union.mockRestore();
    contains.mockRestore();
  }
});

it("bounds real cold-window intersections between yields and stops on cancellation", () => {
  const centers = Array.from({ length: 65 }, (_, index) => ({
    x: index,
    y: Math.sin(index / 3) * 8,
    pressure: 1,
  }));
  const intersect = vi.spyOn(pressureIntersections, "intersectPressureBoundaries");
  try {
    const cancelled = pressurePaintAdditionSteps(centers, 8);
    while (intersect.mock.calls.length === 0) cancelled.next();
    cancelled.return(undefined);
    const before = intersect.mock.calls.length;
    expect(cancelled.next().done).toBe(true);
    expect(intersect.mock.calls.length).toBe(before);
    const steps = pressurePaintAdditionSteps(centers, 8);
    let previous = intersect.mock.calls.length;
    let result = steps.next();
    while (!result.done) {
      // Each grouped union interval can probe at most four capsule boundaries.
      expect(intersect.mock.calls.length - previous).toBeLessThanOrEqual(
        pressureUnion.PRESSURE_PREPARATION_CHECK_INTERVAL * 4,
      );
      previous = intersect.mock.calls.length;
      result = steps.next();
    }
    expect(intersect.mock.calls.length - previous).toBeLessThanOrEqual(
      pressureUnion.PRESSURE_PREPARATION_CHECK_INTERVAL * 4,
    );
    expect(intersect.mock.calls.length).toBeGreaterThan(0);
    expect(intersect.mock.calls.length).toBeLessThanOrEqual(64 * 63 * 16);
  } finally {
    intersect.mockRestore();
  }
});

it.each([3, 512])("charges actual polygon edge visits for %i lasso vertices", (count) => {
  const corners = [
    { x: 4, y: 4 },
    { x: 4, y: 1 },
    { x: 1, y: 4 },
  ];
  const points = Array.from({ length: count }, (_, index) => {
    const position = (index * 3) / count;
    const edge = Math.floor(position);
    const start = corners[edge]!;
    const end = corners[(edge + 1) % 3]!;
    return {
      x: start.x + (end.x - start.x) * (position - edge),
      y: start.y + (end.y - start.y) * (position - edge),
    };
  });
  const intersect = vi.spyOn(geometryPrimitives, "segmentsIntersect");
  const steps = primitiveTouchesAreaSteps(createLassoSelectionArea(points), {
    kind: "polygon",
    points: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ],
  });
  let charged = 0;
  let previous = 0;
  try {
    let result = steps.next();
    while (!result.done) {
      const visits = intersect.mock.calls.length - previous;
      expect(visits).toBeLessThanOrEqual(count);
      expect(result.value === undefined ? 64 : result.value).toBeLessThanOrEqual(64);
      charged += result.value ?? 64;
      previous = intersect.mock.calls.length;
      result = steps.next();
    }
    expect(result.value).toBe(false);
    expect(intersect.mock.calls.length).toBeLessThan(count * 3);
    expect(charged).toBeGreaterThan(intersect.mock.calls.length);
  } finally {
    intersect.mockRestore();
    steps.return(false);
  }
});

it.each([2, 65, 129])(
  "charges the actual first simplification window for %i stroke points",
  (count) => {
    const stroke = {
      ...indexedStroke(0),
      points: Array.from({ length: count }, (_, i) => [i, i % 7, 0.5]).flat(),
    };
    const read = vi.spyOn(strokeCenters, "strokeCenterAt");
    const steps = strokePrimitiveSteps(stroke);
    try {
      const first = steps.next();
      expect(first.done).toBe(false);
      expect(read).toHaveBeenCalledTimes(Math.min(count, 65));
      expect(first.value).toBe(read.mock.calls.length);
      steps.return(undefined);
      const before = read.mock.calls.length;
      expect(steps.next().done).toBe(true);
      expect(read).toHaveBeenCalledTimes(before);
    } finally {
      read.mockRestore();
      steps.return(undefined);
    }
  },
);
