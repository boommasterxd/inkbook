import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";

import { SelectionScalePreviewFramePlan } from "../../../src/editor/selection/scale-preview-frame";
import { SelectionScaleGesture } from "../../../src/editor/selection/selection-scale";
import { table } from "../../unit/domain/schema/fixtures";
import { calculateElementBounds } from "../../../src/domain/geometry/public";
import { selectionOverlayGeometry } from "../../../src/editor/selection/overlay-geometry";
import { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import { maximumStroke } from "./maximum-stroke-fixture";
import { PASS_THROUGH_PLANNER, createRotatedScaleFixture } from "./selection-input-fixture";

describe("arbitrary-frame stroke scale materialization", () => {
  it.each([false, true])(
    "materializes a maximum rotated stroke with one source-coordinate copy (typed=%s)",
    (typed) => {
      const { element, pointer, gesture, factors } = createRotatedScaleFixture(
        typed,
        SelectionScaleGesture,
      );
      let copiedCoordinates = 0;
      const points = new Proxy(element.points, {
        get(target, key) {
          if (key === "slice")
            return () => {
              copiedCoordinates += target.length;
              return target.slice();
            };
          return Reflect.get(target, key, target) as unknown;
        },
      });
      const result = gesture.materializeOne({ ...element, points }, pointer, false, factors);
      expect(copiedCoordinates).toBe(MAX_STROKE_POINTS * 3);
      expect(result.kind).toBe("stroke");
      if (result.kind !== "stroke") throw new Error("Expected a stroke replacement.");
      expect(result.rotation).toBe(0);
      expect(result.points).toHaveLength(MAX_STROKE_POINTS * 3);
      expect(result.points).not.toBe(element.points);
    },
  );
});

describe("collapsed structural scale work", () => {
  it("reuses the prepared basis without revisiting maximum table geometry", () => {
    let sourceReads = 0;
    const source = new Proxy(
      {
        ...table(),
        columns: 12,
        columnWidth: 0,
        height: 0,
        headerHeight: 0,
        x: 100,
        y: 100,
        pivot: { x: 100, y: 100 },
        columnOffsets: Array<number>(11).fill(0),
      },
      {
        get(target, key, receiver): unknown {
          sourceReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const gesture = new SelectionScaleGesture(
      { anchor: { x: 99, y: 99 }, kind: "scale", position: "bottom-right", rotation: 0 },
      [source],
      { x: 101, y: 101 },
    );
    sourceReads = 0;
    for (const pointer of [
      { x: 101.1, y: 101.1 },
      { x: 221, y: 221 },
      { x: 99, y: 99 },
    ]) {
      const factors = gesture.previewFactors(pointer, false, true);
      expect(factors.x).toBeGreaterThanOrEqual(0);
      expect(factors.y).toBeGreaterThanOrEqual(0);
    }
    // Both solver and preview frame use the prepared constant-size basis, not column data.
    expect(sourceReads).toBe(0);
  });
});

it("uses the prepared single-stroke frame without rereading maximum stroke coordinates", () => {
  const base = maximumStroke(0);
  let reads = 0;
  const points = new Proxy(base.points, {
    get(target, key, receiver): unknown {
      if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const element = { ...base, points };
  const selected = [{ element, bounds: calculateElementBounds(element) }];
  const session = new SelectionHandleSession({
    action: { anchor: { x: 0, y: 0 }, kind: "scale", position: "bottom-right", rotation: 0 },
    elements: [element],
    planner: PASS_THROUGH_PLANNER,
    startPointer: { x: 4100, y: 200 },
  });
  reads = 0;
  for (const x of [4200, 4400, 4150]) {
    session.update({ x, y: 250 });
    const frame = session.preview.previewFrame!;
    const geometry = selectionOverlayGeometry(selected, 1, null, frame)!;
    expect(geometry.outline).toEqual({ kind: "polygon", points: frame.points });
    expect(geometry.handles).toHaveLength(9);
  }
  expect(reads).toBe(0);
});

it("solves single-stroke factors once and reuses supplied factors during materialization", () => {
  const source = maximumStroke(0);
  const pointer = { x: 4500, y: 250 };
  const gesture = new SelectionScaleGesture(
    { anchor: { x: 0, y: 0 }, kind: "scale", position: "bottom-right", rotation: 0 },
    [source],
    { x: 4100, y: 200 },
  );
  const solve = vi.spyOn(SelectionScalePreviewFramePlan.prototype, "factorsForPointer");
  try {
    gesture.materialize(pointer, false);
    expect(solve).toHaveBeenCalledTimes(1);
    const factors = gesture.factorsAt(pointer, false);
    solve.mockClear();
    const reused = gesture.materializeOne(source, pointer, false, factors);
    expect(solve).not.toHaveBeenCalled();
    expect(gesture.materializeOne(source, pointer, false, undefined)).toEqual(reused);
    expect(solve).toHaveBeenCalledTimes(1);
  } finally {
    solve.mockRestore();
  }
});
