import { describe, expect, it, vi } from "vitest";

import type {
  BoxShapeElementV1,
  StrokeElementV1,
  TableElementV1,
} from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { strokeCenterWindow } from "../../../../../src/domain/geometry/stroke-center-window";
import { rotatePointClockwise } from "../../../../../src/domain/geometry/primitives";
import type { PreparedPressureGeometryPort } from "../../../../../src/domain/geometry/pressure/prepared-pressure-geometry";
import { selectionStrokeCenters } from "../../../../../src/editor/selection/query/stroke-selection-centers";
import * as centers from "../../../../../src/domain/geometry/stroke-path";
import {
  elementContainsPoint,
  HitTestScratch,
} from "../../../../../src/editor/selection/query/hit-test";

function rectangle(fillOpacity: number, id = "rectangle"): BoxShapeElementV1 {
  return {
    id,
    kind: "rectangle",
    createdAt: 1,
    rotation: 0,
    pivot: { x: 50, y: 50 },
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    style: {
      outlineColor: { type: "theme-text" },
      outlineWidth: 4,
      outlineOpacity: 1,
      outlineStyle: "solid",
      fillColor: fillOpacity === 0 ? null : { type: "theme-text" },
      fillOpacity,
    },
  };
}

function stroke(points: number[], id = "stroke"): StrokeElementV1 {
  return {
    createdAt: 1,
    id,
    kind: "stroke",
    pivot: { x: 0, y: 0 },
    points,
    rotation: 0,
    style: {
      color: { type: "theme-text" },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 2,
    },
    tool: "pen",
  };
}

function table(): TableElementV1 {
  return {
    columnWidth: 50,
    columns: 3,
    createdAt: 1,
    headerHeight: 30,
    height: 100,
    id: "table",
    kind: "table",
    pivot: { x: 75, y: 50 },
    rotation: 0,
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    x: 0,
    y: 0,
  };
}

function assertMutableStrokeUpdates(
  points: number[] | Float64Array,
  pressureEnabled: boolean,
): void {
  const element = stroke(points as unknown as number[]);
  element.style.pressureEnabled = pressureEnabled;
  expect(elementContainsPoint(element, { x: 50, y: 0 }, 1)).toBe(false);
  points[1] = 0;
  points[4] = 0;
  expect(elementContainsPoint(element, { x: 50, y: 0 }, 1)).toBe(true);
}

function preparedHitFixture(rotation = 0, count = 130) {
  const points = Array.from({ length: count }, (_, index) => [
    index,
    index === 64 ? 0 : 100,
    0.5,
  ]).flat();
  Object.freeze(points);
  const source = stroke(points);
  const element = { ...source, rotation, style: { ...source.style, pressureEnabled: false } };
  const windows: (readonly centers.StrokeCenter[] | undefined)[] = Array.from(
    { length: Math.max(1, Math.ceil((count - 1) / 64)) },
    (_, index) => strokeCenterWindow(element, index),
  );
  const readCenters = vi.fn((index: number) => windows[index]);
  const prepared: PreparedPressureGeometryPort = {
    readCenters,
    readWindow: () => undefined,
    publishWindow: () => undefined,
  };
  return { element, windows, prepared, readCenters };
}

describe("collapsed ellipse hit testing", () => {
  it.each([
    [0, 0],
    [0, 20],
    [20, 0],
  ])("selects an ellipse of size %s by %s", (width, height) => {
    const element: BoxShapeElementV1 = {
      ...rectangle(0),
      kind: "ellipse",
      width,
      height,
      pivot: { x: width / 2, y: height / 2 },
    };
    expect(elementContainsPoint(element, element.pivot, 0)).toBe(true);
    expect(elementContainsPoint(element, { x: width + 3, y: height + 3 }, 0)).toBe(false);
  });
});

describe("selection hit testing", () => {
  it("does not hit transparent interiors but does hit visible fills and outlines", () => {
    expect(elementContainsPoint(rectangle(0), { x: 50, y: 50 }, 8)).toBe(false);
    expect(elementContainsPoint(rectangle(1), { x: 50, y: 50 }, 8)).toBe(true);
    expect(elementContainsPoint(rectangle(0), { x: 1, y: 50 }, 8)).toBe(true);
  });

  it("hits table separators without treating the invisible outer bounds as a frame", () => {
    const target = table();

    expect(elementContainsPoint(target, { x: 50, y: 70 }, 1)).toBe(true);
    expect(elementContainsPoint(target, { x: 25, y: 30 }, 1)).toBe(true);
    expect(elementContainsPoint(target, { x: 0, y: 70 }, 1)).toBe(false);
    expect(elementContainsPoint(target, { x: 150, y: 70 }, 1)).toBe(false);
  });

  it("selects the frontmost candidate and uses touch tolerance", () => {
    const candidates = [
      { band: "content" as const, element: rectangle(0, "back"), rank: 0 },
      { band: "content" as const, element: rectangle(0, "front"), rank: 1 },
    ];
    const scratch = new HitTestScratch();
    expect(frontmostHit(scratch, { x: -12, y: 50 }, "touch", candidates)).toBe("front");
    expect(frontmostHit(scratch, { x: -12, y: 50 }, "mouse", candidates)).toBeNull();
  });
});

describe("prepared non-pressure stroke hit indexes", () => {
  it.each([65, 66])("keeps the shared endpoint at the %s-sample window boundary", (count) => {
    const { element, prepared, readCenters } = preparedHitFixture(0, count);
    const point = { x: 64, y: count === 65 ? 0 : 50 };
    expect(elementContainsPoint(element, point, 0, prepared)).toBe(true);
    expect(readCenters).toHaveBeenCalledTimes(count === 65 ? 1 : 2);
  });

  it.each(["width", "samples"] as const)(
    "rebuilds after the real store revokes a prepared port on a %s change",
    (change) => {
      const source = {
        ...preparedHitFixture().element,
        id: "00000000-0000-4000-8000-000000000002",
      };
      const store = new ElementStore([source]);
      const record = store.get(source.id)!;
      const element = record.element as StrokeElementV1;
      const prepared = store.pressureGeometry(source.id, record.geometryVersion);
      selectionStrokeCenters(element, prepared);
      const replacement =
        change === "width"
          ? { ...element, style: { ...element.style, width: 8 as const } }
          : {
              ...element,
              points: element.points.map((value, index) => (index % 3 === 1 ? 0 : value)),
            };
      store.replace(source.id, replacement);
      expect(prepared.readCenters!(0)).toBeUndefined();
      const current = store.get(source.id)!.element as StrokeElementV1;
      const read = vi.spyOn(centers, "smoothStrokeCenters");
      try {
        expect(elementContainsPoint(current, { x: 100, y: 0 }, 0, prepared)).toBe(
          change === "samples",
        );
        expect(read).toHaveBeenCalledTimes(1);
        expect(elementContainsPoint(current, { x: 100, y: 0 }, 0, prepared)).toBe(
          change === "samples",
        );
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        read.mockRestore();
        store.releasePreparedPressureGeometry();
      }
    },
  );

  it.each([undefined, 0, 1] as const)(
    "preserves canonical hits with complete or missing prepared window %s",
    (missing) => {
      const { element, prepared, windows, readCenters } = preparedHitFixture();
      if (missing !== undefined) windows[missing] = undefined;
      expect(elementContainsPoint(element, { x: 64, y: 56.25 }, 1, prepared)).toBe(true);
      expect(elementContainsPoint(element, { x: 64, y: 45 }, 1, prepared)).toBe(false);
      expect(elementContainsPoint(element, { x: 128.5, y: 100 }, 0, prepared)).toBe(true);
      readCenters.mockClear();
      expect(elementContainsPoint(element, { x: 64, y: 56.25 }, 1, prepared)).toBe(true);
      expect(readCenters).not.toHaveBeenCalled();
    },
  );

  it("keeps the first-point hit ahead of prepared-window lookup", () => {
    const { element, prepared, readCenters } = preparedHitFixture();
    expect(elementContainsPoint(element, { x: 0, y: 100 }, 0, prepared)).toBe(true);
    expect(readCenters).not.toHaveBeenCalled();
  });

  it("does not use rotated prepared centers for an unrotated hit index", () => {
    const { element, prepared, readCenters } = preparedHitFixture(37);
    const point = rotatePointClockwise({ x: 64, y: 50 }, element.pivot, 37);
    expect(elementContainsPoint(element, point, 1, prepared)).toBe(true);
    expect(readCenters).not.toHaveBeenCalled();
  });

  it.each([false, true])("requires an explicit local port for offset reuse (local=%s)", (local) => {
    const { element, prepared, readCenters } = preparedHitFixture();
    const localPort = { ...prepared };
    if (local) prepared.local = () => localPort;
    const offset = { x: -1000.003, y: 200.007 };
    const positioned = { ...element, offset };
    const point = { x: 64 + offset.x, y: 50 + offset.y };
    expect(elementContainsPoint(positioned, point, 1, prepared)).toBe(true);
    expect(readCenters.mock.calls.length).toBe(local ? 3 : 0);
  });
});

describe("canonical stroke hit indexes", () => {
  it.each([true, false])(
    "finds exact canonical hits across block boundaries (pressure=%s)",
    (pressureEnabled) => {
      const points: number[] = [];
      for (let index = 0; index < 130; index += 1) {
        points.push(index, index === 64 ? 0 : 100, 0.5);
      }
      Object.freeze(points);
      const element = stroke(points);
      element.style.pressureEnabled = pressureEnabled;

      expect(elementContainsPoint(element, { x: 64, y: 56.25 }, 1)).toBe(true);
      expect(elementContainsPoint(element, { x: 30, y: 50 }, 1)).toBe(false);
      expect(elementContainsPoint(element, { x: 64, y: 50 }, 1)).toBe(true);
      expect(elementContainsPoint(element, { x: 64, y: 45 }, 1)).toBe(false);
      expect(elementContainsPoint(element, { x: 64, y: 56.25 }, 1)).toBe(true);
    },
  );

  it.each([false, true])("does not cache mutable samples (pressure=%s)", (pressureEnabled) => {
    assertMutableStrokeUpdates([0, 100, 0.5, 100, 100, 0.5], pressureEnabled);
  });

  it.each([false, true])(
    "does not cache an unowned mutable runtime buffer (pressure=%s)",
    (pressureEnabled) => {
      assertMutableStrokeUpdates(new Float64Array([0, 100, 0.5, 100, 100, 0.5]), pressureEnabled);
    },
  );

  it("reuses the hit index for an exclusively owned runtime stroke buffer", async () => {
    const runtime = stroke(
      new Float64Array([0, 100, 0.5, 100, 100, 0.5]) as unknown as number[],
      "00000000-0000-4000-8000-000000000001",
    );
    const builder = ElementStore.createBuilder({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    expect(await builder.appendOwnedRuntime([runtime])).toBe("accepted");
    const store = await builder.finalize();
    const stored = store?.get(runtime.id)?.element;
    if (stored?.kind !== "stroke") throw new Error("Expected a stored runtime stroke.");

    expect(elementContainsPoint(stored as StrokeElementV1, { x: 50, y: 0 }, 1)).toBe(false);
    const NativeFloat64Array = Float64Array;
    const blockedConstructor = new Proxy(NativeFloat64Array, {
      construct: () => {
        throw new Error("A cached hit index must not allocate replacement bounds.");
      },
    });
    vi.stubGlobal("Float64Array", blockedConstructor);
    try {
      expect(elementContainsPoint(stored as StrokeElementV1, { x: 50, y: 0 }, 1)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves deterministic rank and ID precedence while pruning losing candidates", () => {
    const candidates = [
      { band: "content" as const, element: rectangle(1, "b"), rank: 10 },
      { band: "content" as const, element: rectangle(1, "lower"), rank: 9 },
      { band: "content" as const, element: rectangle(1, "a"), rank: 10 },
    ];
    expect(frontmostHit(new HitTestScratch(), { x: 50, y: 50 }, "mouse", candidates)).toBe("a");
  });

  it("keeps content above highlight regardless of their band-local ranks", () => {
    const candidates = [
      { band: "highlight" as const, element: rectangle(1, "highlight"), rank: 100 },
      { band: "content" as const, element: rectangle(1, "content"), rank: 0 },
    ];

    expect(frontmostHit(new HitTestScratch(), { x: 50, y: 50 }, "mouse", candidates)).toBe(
      "content",
    );
  });
});

function frontmostHit(
  scratch: HitTestScratch,
  point: Readonly<{ x: number; y: number }>,
  pointerType: "mouse" | "pen" | "touch",
  candidates: readonly {
    readonly band: "content" | "highlight";
    readonly element: BoxShapeElementV1;
    readonly rank: number;
  }[],
): string | null {
  scratch.begin(point, pointerType, 1);
  for (const candidate of candidates) {
    scratch.consider(candidate.element.id, candidate.band, candidate.element, candidate.rank);
  }
  return scratch.finish();
}
