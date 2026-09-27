import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";

import * as geometryBounds from "../../../src/domain/geometry/public";
import * as pressureUnion from "../../../src/domain/geometry/pressure-union";
import { ElementStore } from "../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import {
  createLassoSelectionArea,
  elementMatchesSelectionAreaSteps,
} from "../../../src/editor/selection/selection-area";
import { maximumStroke } from "./maximum-stroke-fixture";

describe("editor gesture hot paths", () => {
  it.each([512, MAX_STROKE_POINTS])(
    "previews a %i-point selection without reading or copying its points",
    (count) => {
      for (const kind of ["move", "scale"] as const) {
        const source = maximumStroke(0);
        const { observed: points, work } = observeSchemaArray(source.points.slice(0, count * 3));
        const stroke = { ...source, points };
        const store = new ElementStore([stroke]);
        const session = new SelectionHandleSession({
          action:
            kind === "move"
              ? { kind }
              : { kind, anchor: { x: -1, y: -1 }, position: "bottom-right", rotation: 0 },
          elements: [stroke],
          planner: store,
          startPointer: { x: count + 1, y: 102 },
        });
        work.indexedReads = 0;
        store.resetInstrumentation();
        for (let frame = 1; frame <= 120; frame += 1) {
          const preview = session.update({ x: count + 1 + frame, y: 102 + frame });
          expect(preview.exactElements).toHaveLength(0);
          expect(preview.exactPreviewTruncated).toBe(true);
          expect(preview.transform?.kind).toBe(kind === "move" ? "translate" : "scale");
        }
        expect(work.indexedReads).toBe(0);
        expect(stroke.points).toBe(points);
        expect(store.instrumentation).toMatchObject({
          fullStoreScans: 0,
          snapshotMaterializations: 0,
          recordReplacements: 0,
          identityChecks: 0,
        });
        session.cancel();
      }
    },
  );
});

it("bounds and cancels a long pressure-addition miss before union work", () => {
  const source = maximumStroke(
    0,
    Array.from({ length: 129 }, (_, index) => [
      index * 10,
      Math.sin((index * Math.PI) / 5) * 10,
      0.5,
    ]).flat(),
  );
  const { observed: points, work } = observeSchemaArray(source.points);
  const stroke = { ...source, points };
  const area = createLassoSelectionArea([
    { x: 640, y: 99 },
    { x: 650, y: 99 },
    { x: 650, y: 100 },
    { x: 640, y: 100 },
  ]);
  // Broadphase bounds may be conservative; the painted capsules remain distant.
  const candidateBounds = { minX: -1, minY: -12, maxX: 1290, maxY: 101 };
  const edgeCheck = vi.spyOn(geometryBounds, "boundsIntersect");
  const union = vi.spyOn(pressureUnion, "iteratePressureUnion");
  try {
    const steps = elementMatchesSelectionAreaSteps(area, stroke, "touched", candidateBounds);
    let step = steps.next();
    let previousEdges = edgeCheck.mock.calls.length;
    let previousReads = work.indexedReads;
    while (!step.done && step.value !== 32) {
      step = steps.next();
      expect(edgeCheck.mock.calls.length - previousEdges).toBeLessThanOrEqual(128);
      expect(work.indexedReads - previousReads).toBeLessThanOrEqual(65 * 9);
      previousEdges = edgeCheck.mock.calls.length;
      previousReads = work.indexedReads;
    }
    expect(step.done).toBe(false);
    const cancelledEdges = edgeCheck.mock.calls.length;
    const cancelledReads = work.indexedReads;
    steps.return(false);
    expect(steps.next().done).toBe(true);
    expect(edgeCheck.mock.calls.length).toBe(cancelledEdges);
    expect(work.indexedReads).toBe(cancelledReads);
    expect(union).not.toHaveBeenCalled();

    edgeCheck.mockClear();
    work.indexedReads = 0;
    const complete = elementMatchesSelectionAreaSteps(area, stroke, "touched", candidateBounds);
    let result = complete.next();
    while (!result.done) result = complete.next();
    expect(result.value).toBe(false);
    expect(edgeCheck.mock.calls.length).toBeGreaterThan(129);
    expect(edgeCheck.mock.calls.length).toBeLessThan(6_000);
    expect(work.indexedReads).toBeLessThan(3_000);
    expect(union).not.toHaveBeenCalled();
  } finally {
    edgeCheck.mockRestore();
    union.mockRestore();
  }
});
