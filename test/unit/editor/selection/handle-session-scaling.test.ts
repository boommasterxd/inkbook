import { describe, expect, it } from "vitest";

import { canonicalPoint, rotatePointClockwise } from "../../../../src/domain/geometry/public";
import type {
  BoxShapeElementV1,
  StrokeElementV1,
  TableElementV1,
} from "../../../../src/domain/schema/public";
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

function fractionalBoxShape(): BoxShapeElementV1 {
  const x = 100.001;
  const y = 70.002;
  const width = 101.003;
  const height = 53.007;
  return {
    createdAt: 2,
    height,
    id: "00000000-0000-4000-8000-000000000003",
    kind: "rectangle",
    pivot: canonicalPoint({ x: x + width / 2, y: y + height / 2 }),
    rotation: 90,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    width,
    x,
    y,
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

describe("fractional box handle scaling", () => {
  it("keeps fractional rotated side-handle frames live and derives the box pivot canonically", () => {
    const source = fractionalBoxShape();
    const localAnchor = { x: source.x, y: source.pivot.y };
    const localStart = { x: source.x + source.width, y: source.pivot.y };
    const anchor = rotatePointClockwise(localAnchor, source.pivot, source.rotation);
    const start = rotatePointClockwise(localStart, source.pivot, source.rotation);
    const frames = [1.37, 1.372].map((factor) =>
      rotatePointClockwise(
        { x: source.x + source.width * factor, y: source.pivot.y },
        source.pivot,
        source.rotation,
      ),
    );
    const session = new SelectionHandleSession({
      action: { anchor, kind: "scale", position: "middle-right" },
      elements: [source],
      planner: new ElementStore([source]),
      startPointer: start,
    });

    const previews = frames.map((pointer) => session.update(pointer));
    expect(
      previews.every(
        ({ exactElements, transform }) => transform !== null && exactElements.length === 1,
      ),
    ).toBe(true);
    expect(previews.map(({ exactElements }) => exactElements[0]?.pivot)).toEqual([
      { x: 150.503, y: 115.191 },
      { x: 150.503, y: 115.291 },
    ]);

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a fractional box scale commit.");
    const replacement = commit.replacements[0];
    if (replacement?.kind !== "rectangle") throw new Error("Expected a rectangle replacement.");
    expect(replacement.pivot).toEqual(
      canonicalPoint({
        x: replacement.x + replacement.width / 2,
        y: replacement.y + replacement.height / 2,
      }),
    );
    expect(validateInkElementV1(replacement).ok).toBe(true);
  });
});
