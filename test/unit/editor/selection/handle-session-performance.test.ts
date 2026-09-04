import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/public";
import { rectangle } from "../../domain/store/fixtures";
import { maximumStroke } from "../../../performance/editor/maximum-stroke-fixture";

function replacementPlan(replacements: readonly InkElementV1[]) {
  return { elements: replacements, replacements };
}

describe("SelectionHandleSession performance contracts", () => {
  it("selects one stable transform fallback for a long pressure-stroke resize", () => {
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

  it.each([
    { pointCount: 256, truncated: false },
    { pointCount: 257, truncated: true },
  ])(
    "applies the pressure preview boundary at $pointCount samples",
    ({ pointCount, truncated }) => {
      const source = maximumStroke(0);
      const stroke = { ...source, points: source.points.slice(0, pointCount * 3) };
      const preview = pressureSession(stroke).update({ x: pointCount + 100, y: 150 });

      expect(preview.exactPreviewTruncated).toBe(truncated);
      expect(preview.exactElements).toHaveLength(truncated ? 0 : 1);
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
