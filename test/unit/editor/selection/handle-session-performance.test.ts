import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import {
  createSelectionFrameAtRotation,
  selectionFramePoint,
  SelectionHandleSession,
} from "../../../../src/editor/selection/public";
import { arrow, coordinateSystem } from "../../domain/schema/fixtures";
import { rectangle } from "../../domain/store/fixtures";
import { maximumStroke } from "../../../performance/editor/maximum-stroke-fixture";

function replacementPlan(replacements: readonly InkElementV1[]) {
  return { elements: replacements, replacements };
}

describe("SelectionHandleSession performance contracts", () => {
  it("defers a long pressure-stroke resize to canonical per-element materialization", () => {
    const stroke = maximumStroke(0);
    const session = pressureSession(stroke);

    const preview = session.update({ x: 5_000, y: 150 });

    expect(preview).toMatchObject({
      exactElements: [],
      exactPreviewTruncated: true,
      transform: { kind: "scale" },
    });
    const commit = session.prepareCommit();
    expect(commit.status).toBe("ready");
    if (commit.status !== "ready") throw new TypeError("Expected an exact pressure commit.");
    const replacement = commit.replacements[0];
    if (replacement?.kind !== "stroke") throw new TypeError("Expected a pressure stroke.");
    expect(replacement.style.pressureEnabled).toBe(true);
    expect(replacement.points).not.toEqual(stroke.points);
  });

  it("captures immutable canonical resize snapshots while newer pointer samples arrive", () => {
    const stroke = maximumStroke(0);
    const session = pressureSession(stroke);
    expect(session.createScalePreviewMaterializer()).toBeUndefined();
    session.update({ x: 5_000, y: 150 });
    const materialize = session.createScalePreviewMaterializer()!;
    const expected = materialize(stroke);
    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new TypeError("Expected an exact pressure commit.");
    expect(expected).toEqual(commit.replacements[0]);

    session.update({ x: 6_000, y: 180 }, { uniformScale: true });
    expect(materialize(stroke)).toEqual(expected);
    expect(session.createScalePreviewMaterializer()!(stroke)).not.toEqual(expected);
    session.cancel();
    expect(session.createScalePreviewMaterializer()).toBeUndefined();
  });

  it("materializes pressure strokes and fixed-size nodes consistently inside a rotated group", () => {
    const elements = [maximumStroke(0), arrow(), coordinateSystem()];
    const frame = createSelectionFrameAtRotation(elements, 30)!;
    const startPointer = selectionFramePoint(frame, "bottom-right");
    const session = new SelectionHandleSession({
      action: {
        anchor: selectionFramePoint(frame, "top-left"),
        kind: "scale",
        position: "bottom-right",
        rotation: 30,
      },
      elements,
      planner: {
        countReverseDependencies: () => 0,
        planReplacements: replacementPlan,
        planReplacementsTimeSliced: async (replacements) => replacementPlan(replacements),
      },
      startPointer,
    });
    session.update({ x: startPointer.x + 100, y: startPointer.y + 100 });
    const materialize = session.createScalePreviewMaterializer()!;
    const previewElements = elements.map(materialize);
    const committed = session.prepareCommit();
    if (committed.status !== "ready") throw new TypeError("Expected a bounded commit.");
    expect(previewElements).toEqual(committed.replacements);
  });
});

describe("SelectionHandleSession work budgets", () => {
  it.each([
    { pointCount: 256, pressureEnabled: true },
    { pointCount: 257, pressureEnabled: true },
    { pointCount: 256, pressureEnabled: false },
    { pointCount: 257, pressureEnabled: false },
  ])(
    "defers stroke materialization at $pointCount samples with pressure $pressureEnabled",
    ({ pointCount, pressureEnabled }) => {
      const source = maximumStroke(0);
      const stroke = {
        ...source,
        points: source.points.slice(0, pointCount * 3),
        style: { ...source.style, pressureEnabled },
      };
      const preview = pressureSession(stroke).update({ x: pointCount + 100, y: 150 });

      expect(preview.exactPreviewTruncated).toBe(true);
      expect(preview.exactElements).toHaveLength(0);
    },
  );

  it("time-slices materialization, fixed-anchor measurement, and correction", async () => {
    const shapes = Array.from({ length: 1_001 }, (_, index) =>
      rectangle(`00000000-0000-4000-8001-${index.toString().padStart(12, "0")}`, index * 250, 0),
    );
    const session = new SelectionHandleSession({
      action: {
        anchor: { x: 0, y: 0 },
        kind: "scale",
        position: "bottom-right",
        rotation: 0,
      },
      elements: shapes,
      planner: {
        countReverseDependencies: () => 0,
        planReplacements: replacementPlan,
        planReplacementsTimeSliced: async (replacements) => replacementPlan(replacements),
      },
      startPointer: { x: 1_000, y: 0 },
    });
    session.update({ x: 500, y: 0 });
    let yields = 0;
    const recordYield = async () => {
      yields += 1;
    };

    const prepared = await session.prepareCommitTimeSliced({
      shouldYield: () => true,
      yieldControl: recordYield,
    });

    expect({ status: prepared.status, yields }).toEqual({
      status: "ready",
      yields: shapes.length * 3,
    });
  });
});

function pressureSession(stroke: ReturnType<typeof maximumStroke>): SelectionHandleSession {
  return new SelectionHandleSession({
    action: {
      anchor: { x: 0, y: 0 },
      kind: "scale",
      position: "bottom-right",
      rotation: 0,
    },
    elements: [stroke],
    planner: {
      countReverseDependencies: () => 0,
      planReplacements: replacementPlan,
      planReplacementsTimeSliced: async (replacements) => replacementPlan(replacements),
    },
    startPointer: { x: stroke.points.length / 3 - 1, y: 100 },
  });
}
