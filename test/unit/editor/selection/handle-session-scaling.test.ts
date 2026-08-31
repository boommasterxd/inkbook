import { describe, expect, it } from "vitest";

import type { StrokeElementV1, TableElementV1 } from "../../../../src/domain/schema/public";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/public";

function table(): TableElementV1 {
  return {
    columnWidth: 100,
    columns: 2,
    createdAt: 1,
    headerHeight: 24,
    height: 100,
    id: "00000000-0000-4000-8000-000000000001",
    kind: "table",
    pivot: { x: 200, y: 150 },
    rotation: 0,
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    x: 100,
    y: 100,
  };
}

function scaleTransform(
  anchor: { readonly x: number; readonly y: number },
  factors: { readonly x: number; readonly y: number },
) {
  return { anchor, factors, kind: "scale" as const, rotation: 0 };
}

describe("single-element generic handle scaling", () => {
  it("uses only the active side axis in both the live preview and commit", () => {
    const source = table();
    const store = new ElementStore([source]);
    const session = new SelectionHandleSession({
      action: { anchor: { x: 98, y: 150 }, kind: "scale", position: "middle-right" },
      elements: [source],
      planner: store,
      startPointer: { x: 302, y: 150 },
    });

    const preview = session.update({ x: 404, y: 230 });
    expect(preview.transform).toEqual(scaleTransform({ x: 98, y: 150 }, { x: 1.5, y: 1 }));

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a scale commit.");
    expect(commit.replacements[0]).toMatchObject({
      columnWidth: 150,
      headerHeight: 24,
      height: 100,
      pivot: { x: 251, y: 150 },
      x: 101,
      y: 100,
    });
  });

  it("clamps vertical shrinking at the table header minimum in preview and commit", () => {
    const source: TableElementV1 = {
      ...table(),
      headerHeight: 30,
      height: 200,
      pivot: { x: 200, y: 200 },
    };
    const store = new ElementStore([source]);
    const session = new SelectionHandleSession({
      action: { anchor: { x: 200, y: 100 }, kind: "scale", position: "bottom-center" },
      elements: [source],
      planner: store,
      startPointer: { x: 200, y: 300 },
    });

    const preview = session.update({ x: 200, y: 200 });
    expect(preview.transform).toEqual(scaleTransform({ x: 200, y: 100 }, { x: 1, y: 0.8 }));

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a scale commit.");
    expect(commit.replacements[0]).toMatchObject({
      headerHeight: 24,
      height: 160,
      pivot: { x: 200, y: 180 },
      y: 100,
    });
    expect(validateInkElementV1(commit.replacements[0]).ok).toBe(true);
  });

  it("keeps a rotated freehand stroke on the same preview axis after commit", () => {
    const source: StrokeElementV1 = {
      createdAt: 2,
      id: "00000000-0000-4000-8000-000000000002",
      kind: "stroke",
      pivot: { x: 50, y: 0 },
      points: [0, 0, 0.5, 100, 0, 0.5],
      rotation: 90,
      style: {
        color: { type: "theme-text" },
        opacity: 1,
        pressureEnabled: true,
        smoothing: 0.5,
        width: 4,
      },
      tool: "pen",
    };
    const session = new SelectionHandleSession({
      action: { anchor: { x: 50, y: -50 }, kind: "scale", position: "middle-right" },
      elements: [source],
      planner: new ElementStore([source]),
      startPointer: { x: 50, y: 50 },
    });

    const preview = session.update({ x: 50, y: 150 });
    expect(preview.transform).toEqual({
      anchor: { x: 50, y: -50 },
      factors: { x: 2, y: 1 },
      kind: "scale",
      rotation: 90,
    });

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a rotated stroke scale commit.");
    expect(commit.replacements[0]).toMatchObject({
      pivot: { x: 50, y: 50 },
      points: [-50, 50, 0.5, 150, 50, 0.5],
      rotation: 90,
    });
  });
});
