import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../src/domain/schema/public";
import * as centers from "../../../src/domain/geometry/stroke-path";
import * as pressureUnion from "../../../src/domain/geometry/pressure-union";
import * as position from "../../../src/domain/geometry/stroke-position";
import {
  createRectangleSelectionArea,
  elementMatchesSelectionAreaSteps,
} from "../../../src/editor/selection/selection-area";
import { elementContainsPoint } from "../../../src/editor/selection/hit-test";
import { SelectionFrameSession } from "../../../src/editor/selection/selection-frame";
import { selectionOverlayGeometry } from "../../../src/editor/selection/overlay-geometry";
import { moveSelection } from "../../../src/editor/selection/transforms";
import { strokePrimitiveSteps } from "../../../src/editor/selection/stroke-selection-geometry";
import { maximumStroke } from "./maximum-stroke-fixture";

function fixture(pressureEnabled: boolean, positioned: boolean) {
  const source = maximumStroke(0);
  const offset = positioned ? { x: -1000.003, y: 200.007 } : { x: 0, y: 0 };
  const store = new ElementStore([
    {
      ...source,
      ...(positioned
        ? { offset, pivot: { x: source.pivot.x + offset.x, y: source.pivot.y + offset.y } }
        : {}),
      style: { ...source.style, pressureEnabled },
    },
  ]);
  const record = store.get(source.id)!;
  const element = record.element as StrokeElementV1;
  const prepared = store.pressureGeometry(source.id, record.geometryVersion);
  return { store, record, element, prepared, offset };
}

function completeQuery(steps: Generator<number | void, boolean>): boolean {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

it.each(
  [false, true].flatMap((pressureEnabled) =>
    [false, true].map((positioned) => ({ pressureEnabled, positioned })),
  ),
)(
  "reuses demanded maximum-stroke centers (pressure=$pressureEnabled, positioned=$positioned)",
  ({ pressureEnabled, positioned }) => {
    const test = fixture(pressureEnabled, positioned);
    const { x, y } = test.offset;
    const area = createRectangleSelectionArea(
      { x: 7999 + x, y: 49 + y },
      { x: 8001 + x, y: 51 + y },
    );
    const read = vi.spyOn(centers, "strokeCenterAt");
    try {
      const query = () =>
        elementMatchesSelectionAreaSteps(
          area,
          test.element,
          "touched",
          test.record.bounds,
          test.prepared,
        );
      expect(completeQuery(query())).toBe(false);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(MAX_STROKE_POINTS);
      expect(read.mock.calls.length).toBeLessThanOrEqual(
        MAX_STROKE_POINTS + MAX_STROKE_POINTS / 64,
      );
      read.mockClear();
      expect(completeQuery(query())).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(
        test.store.activeDocumentMemoryUsage().selectionGeometryCacheBytes,
      ).toBeLessThanOrEqual(2 * 1024 * 1024);
      test.store.releasePreparedPressureGeometry();
      expect(test.store.activeDocumentMemoryUsage().selectionGeometryCacheBytes).toBe(0);
    } finally {
      read.mockRestore();
      test.store.releasePreparedPressureGeometry();
    }
  },
);

it("keeps first hits and cancelled cold preparation within one center window", () => {
  const test = fixture(true, true);
  const { x, y } = test.offset;
  const area = createRectangleSelectionArea({ x: -1 + x, y: 99 + y }, { x: 1 + x, y: 101 + y });
  const read = vi.spyOn(centers, "strokeCenterAt");
  try {
    expect(
      completeQuery(
        elementMatchesSelectionAreaSteps(
          area,
          test.element,
          "touched",
          test.record.bounds,
          test.prepared,
        ),
      ),
    ).toBe(true);
    expect(read.mock.calls.length).toBeLessThanOrEqual(65);
    const pending = strokePrimitiveSteps(test.element, { prepared: test.prepared });
    pending.next();
    pending.return(undefined);
    read.mockClear();
    expect(pending.next().done).toBe(true);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    test.store.releasePreparedPressureGeometry();
  }
});

it.each([0.003, -1000.007])(
  "reuses exact outward paint after a retained-sample translation of %s",
  (x) => {
    const source = {
      ...maximumStroke(0, [0, 0, 1, 20, 40, 1, 40, 0, 1]),
      pivot: { x: 0, y: 0 },
      style: { ...maximumStroke(0).style, width: 8 as const },
    };
    const store = new ElementStore([source]);
    const record = store.get(source.id)!;
    const original = record.element as StrokeElementV1;
    const prepared = store.pressureGeometry(source.id, record.geometryVersion);
    const pieces = [...strokePrimitiveSteps(original, { prepared })];
    expect(pieces.some((piece) => typeof piece === "object" && piece.kind === "polygon")).toBe(
      true,
    );
    const offset = { x, y: x + 0.002 };
    store.replace(source.id, moveSelection([original], offset)[0]!);
    const moved = store.get(source.id)!;
    const port = store.pressureGeometry(source.id, moved.geometryVersion);
    const point = { x: 17.75 + offset.x, y: 23.37 + offset.y };
    const read = vi.spyOn(centers, "strokeCenterAt");
    const build = vi.spyOn(pressureUnion, "iteratePressureUnion");
    try {
      expect(elementContainsPoint(moved.element as StrokeElementV1, point, 0, port)).toBe(true);
      const area = createRectangleSelectionArea(
        { x: point.x - 0.001, y: point.y - 0.001 },
        { x: point.x + 0.001, y: point.y + 0.001 },
      );
      expect(
        completeQuery(
          elementMatchesSelectionAreaSteps(
            area,
            moved.element as StrokeElementV1,
            "touched",
            moved.bounds,
            port,
          ),
        ),
      ).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      build.mockRestore();
      store.releasePreparedPressureGeometry();
    }
  },
);

it.each([0, 37])(
  "resolves one single-stroke frame for outline, handles and repeated access at %s degrees",
  (rotation) => {
    const source = { ...maximumStroke(0), rotation };
    const store = new ElementStore([source]);
    const record = store.get(source.id)!;
    const selected = [{ element: record.element as StrokeElementV1, bounds: record.bounds }];
    const session = new SelectionFrameSession();
    const calculate = vi.spyOn(position, "strokeWorldPoint");
    try {
      const frame = session.current(selected)!;
      expect(frame.rotation).toBe(rotation);
      expect(calculate).toHaveBeenCalledTimes(rotation === 0 ? 0 : MAX_STROKE_POINTS);
      calculate.mockClear();
      const overlay = selectionOverlayGeometry(selected, 1, null, frame)!;
      expect(overlay.outline).toEqual({ kind: "polygon", points: frame.points });
      expect(session.current(selected)).toBe(frame);
      expect(calculate).not.toHaveBeenCalled();
      const element = selected[0]!.element;
      store.replace(element.id, { ...element, style: { ...element.style, opacity: 0.5 } });
      const changed = store.get(element.id)!;
      expect(
        session.current([{ element: changed.element as StrokeElementV1, bounds: changed.bounds }]),
      ).toBe(frame);
      expect(calculate).not.toHaveBeenCalled();
    } finally {
      calculate.mockRestore();
      store.releasePreparedPressureGeometry();
    }
  },
);

it("cancels a cold rotated frame within one bounds batch without retaining partial work", async () => {
  const source = { ...maximumStroke(0), rotation: 37 };
  const store = new ElementStore([source]);
  const record = store.get(source.id)!;
  const selected = [{ element: record.element as StrokeElementV1, bounds: record.bounds }];
  const session = new SelectionFrameSession();
  const read = vi.spyOn(position, "strokeWorldPoint");
  let cancelled = false;
  try {
    expect(
      await session.currentTimeSliced(selected, {
        shouldYield: () => read.mock.calls.length > 0,
        yieldControl: async () => {
          cancelled = true;
        },
        isCancelled: () => cancelled,
      }),
    ).toBeNull();
    expect(read).toHaveBeenCalledTimes(256);
    read.mockClear();
    const frame = await session.currentTimeSliced(selected, {
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    expect(frame?.rotation).toBe(37);
    expect(read).toHaveBeenCalledTimes(MAX_STROKE_POINTS);
    read.mockClear();
    expect(session.current(selected)).toBe(frame);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    store.releasePreparedPressureGeometry();
  }
});
