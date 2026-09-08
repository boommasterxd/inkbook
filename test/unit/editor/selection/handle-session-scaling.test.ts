import { describe, expect, it } from "vitest";

import {
  calculateElementBounds,
  canonicalPoint,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import type {
  BoxAnchorV1,
  BoxShapeElementV1,
  StrokeElementV1,
  TableElementV1,
} from "../../../../src/domain/schema/public";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  createSelectionFrameAtRotation,
  oppositeBoxAnchor,
  selectionFramePoint,
  SelectionHandleSession,
} from "../../../../src/editor/selection/public";

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

function secondTable(): TableElementV1 {
  return {
    ...table(),
    createdAt: 3,
    id: "00000000-0000-4000-8000-000000000004",
    pivot: { x: 500, y: 150 },
    x: 400,
  };
}

interface TableGroupScaleOptions {
  readonly firstRotation?: number;
  readonly frameRotation?: number;
  readonly secondRotation?: number;
  readonly uniformScale?: boolean;
}

function tableGroupScaleFixture(options: TableGroupScaleOptions = {}) {
  const first = { ...table(), rotation: options.firstRotation ?? 0 };
  const second = { ...secondTable(), rotation: options.secondRotation ?? 0 };
  const elements = [first, second];
  const frameRotation = options.frameRotation ?? 0;
  const frame = createSelectionFrameAtRotation(elements, frameRotation);
  if (frame === null) throw new Error("Expected a group selection frame.");
  const anchor = selectionFramePoint(frame, "middle-left");
  const startPointer = selectionFramePoint(frame, "middle-right");
  const session = new SelectionHandleSession({
    action: { anchor, kind: "scale", position: "middle-right", rotation: frameRotation },
    elements,
    planner: new ElementStore(elements),
    startPointer,
    ...(options.uniformScale === undefined ? {} : { uniformScale: options.uniformScale }),
  });
  return { first, frame, second, session, startPointer };
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
  delta: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
) {
  return { anchor, delta, factors, kind: "scale" as const, rotation: 0 };
}

describe("single-element generic handle scaling", () => {
  it.each<BoxAnchorV1>([
    "top-left",
    "top-center",
    "top-right",
    "middle-right",
    "bottom-right",
    "bottom-center",
    "bottom-left",
    "middle-left",
  ])("keeps the opposite %s anchor fixed in preview and commit", (position) => {
    const source = table();
    const frame = createSelectionFrameAtRotation([source], source.rotation);
    if (frame === null) throw new Error("Expected a table selection frame.");
    const anchor = selectionFramePoint(frame, oppositeBoxAnchor(position));
    const startPointer = selectionFramePoint(frame, position);
    const factors = {
      x: position.includes("left") || position.includes("right") ? 1.4 : 1,
      y: position.startsWith("top") || position.startsWith("bottom") ? 1.3 : 1,
    };
    const pointer = {
      x: anchor.x + (startPointer.x - anchor.x) * factors.x,
      y: anchor.y + (startPointer.y - anchor.y) * factors.y,
    };
    const session = new SelectionHandleSession({
      action: { anchor, kind: "scale", position, rotation: source.rotation },
      elements: [source],
      planner: new ElementStore([source]),
      startPointer,
    });

    const preview = session.update(pointer);
    const previewFrame = createSelectionFrameAtRotation(preview.exactElements, source.rotation);
    if (previewFrame === null) throw new Error("Expected an exact preview frame.");
    expectFixedOppositeSide(frame, previewFrame, position);
    expect(selectionFramePoint(previewFrame, position).x).toBeCloseTo(pointer.x, 2);
    expect(selectionFramePoint(previewFrame, position).y).toBeCloseTo(pointer.y, 2);

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a table scale commit.");
    const committedFrame = createSelectionFrameAtRotation(commit.replacements, source.rotation);
    if (committedFrame === null) throw new Error("Expected a committed selection frame.");
    expectFixedOppositeSide(frame, committedFrame, position);
  });
});

describe("single-element generic scale behavior", () => {
  it("keeps a single selection proportional while Shift is held", () => {
    const source = table();
    const store = new ElementStore([source]);
    const session = new SelectionHandleSession({
      action: {
        anchor: { x: 100, y: 150 },
        kind: "scale",
        position: "middle-right",
        rotation: 0,
      },
      elements: [source],
      planner: store,
      startPointer: { x: 300, y: 150 },
      uniformScale: true,
    });

    const preview = session.update({ x: 500, y: 150 });
    expect(preview.transform).toEqual(
      scaleTransform({ x: 100, y: 150 }, { x: 2, y: 2 }, { x: 2, y: 0 }),
    );

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a scale commit.");
    expect(commit.replacements[0]).toMatchObject({
      columnWidth: 200,
      height: 200,
      headerHeight: 48,
      pivot: { x: 302, y: 150 },
      x: 102,
      y: 50,
    });
  });

  it("uses only the active side axis in both the live preview and commit", () => {
    const source = table();
    const store = new ElementStore([source]);
    const session = new SelectionHandleSession({
      action: {
        anchor: { x: 98, y: 150 },
        kind: "scale",
        position: "middle-right",
        rotation: 0,
      },
      elements: [source],
      planner: store,
      startPointer: { x: 302, y: 150 },
    });

    const preview = session.update({ x: 404, y: 230 });
    expect(preview.transform).toEqual(
      scaleTransform({ x: 98, y: 150 }, { x: 1.51, y: 1 }, { x: -1.02, y: 0 }),
    );

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a scale commit.");
    expect(commit.replacements[0]).toMatchObject({
      columnWidth: 151,
      headerHeight: 24,
      height: 100,
      pivot: { x: 251, y: 150 },
      x: 100,
      y: 100,
    });
  });
});

describe("single-element table scale boundaries", () => {
  it("clamps vertical shrinking at the outer table minimum without constraining its header", () => {
    const source: TableElementV1 = {
      ...table(),
      headerHeight: 30,
      height: 200,
      pivot: { x: 200, y: 200 },
    };
    const store = new ElementStore([source]);
    const session = new SelectionHandleSession({
      action: {
        anchor: { x: 200, y: 100 },
        kind: "scale",
        position: "bottom-center",
        rotation: 0,
      },
      elements: [source],
      planner: store,
      startPointer: { x: 200, y: 300 },
    });

    const preview = session.update({ x: 200, y: 200 });
    expect(preview.transform).toEqual(
      scaleTransform({ x: 200, y: 100 }, { x: 1, y: 0.5 }, { x: 0, y: 2 }),
    );

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a scale commit.");
    expect(commit.replacements[0]).toMatchObject({
      headerHeight: 15,
      height: 100,
      pivot: { x: 200, y: 152 },
      y: 102,
    });
    expect(validateInkElementV1(commit.replacements[0]).ok).toBe(true);
  });
});

describe("multi-element handle scaling", () => {
  it("uses a retained rotated group frame for side-handle scaling", () => {
    const { frame, session, startPointer } = tableGroupScaleFixture({
      firstRotation: 37,
      frameRotation: 37,
      secondRotation: 37,
    });
    const frameAxis = {
      x: frame.points[1].x - frame.points[0].x,
      y: frame.points[1].y - frame.points[0].y,
    };
    const axisLength = Math.hypot(frameAxis.x, frameAxis.y);
    const pointer = {
      x: startPointer.x + (frameAxis.x * 120) / axisLength,
      y: startPointer.y + (frameAxis.y * 120) / axisLength,
    };

    session.update(pointer);
    const { frame: committedFrame } = committedScaleFrame(session, 37);
    for (const index of [0, 3]) {
      expect(committedFrame.points[index]?.x).toBeCloseTo(frame.points[index]!.x, 2);
      expect(committedFrame.points[index]?.y).toBeCloseTo(frame.points[index]!.y, 2);
    }
  });

  it.each([0, 90])(
    "scales elements rotated by %s degrees along only the dragged selection-frame axis",
    (secondRotation) => {
      const { first, frame, second, session, startPointer } = tableGroupScaleFixture({
        secondRotation,
      });
      const preview = session.update({ x: startPointer.x + 150, y: startPointer.y + 90 });
      expect(preview.transform).toMatchObject({ factors: { y: 1 } });
      const { commit, frame: committedFrame } = committedScaleFrame(session, 0);

      expectFixedOppositeSide(frame, committedFrame, "middle-right");
      expect(commit.replacements[0]).toMatchObject({ height: first.height });
      expect(calculateElementBounds(commit.replacements[1]!).maxX).toBeGreaterThan(
        calculateElementBounds(second).maxX,
      );
    },
  );

  it("preserves the group aspect ratio only while Shift is held", () => {
    const { first, session, startPointer } = tableGroupScaleFixture({ uniformScale: true });

    const preview = session.update({ x: startPointer.x + 150, y: startPointer.y + 90 });
    if (preview.transform?.kind !== "scale") throw new Error("Expected a scale preview.");
    expect(preview.transform.factors.x).toBe(preview.transform.factors.y);
    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a uniform group scale commit.");
    if (commit.replacements[0]?.kind !== "table") throw new Error("Expected a table.");
    expect(commit.replacements[0].height).toBeGreaterThan(first.height);
  });
});

describe("single-element rotated handle scaling", () => {
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
      action: {
        anchor: { x: 50, y: -50 },
        kind: "scale",
        position: "middle-right",
        rotation: 90,
      },
      elements: [source],
      planner: new ElementStore([source]),
      startPointer: { x: 50, y: 50 },
    });

    const preview = session.update({ x: 50, y: 150 });
    expect(preview.transform).toEqual({
      anchor: { x: 50, y: -50 },
      delta: { x: 0, y: 2 },
      factors: { x: 2, y: 1 },
      kind: "scale",
      rotation: 90,
    });

    const commit = session.prepareCommit();
    if (commit.status !== "ready") throw new Error("Expected a rotated stroke scale commit.");
    expect(commit.replacements[0]).toMatchObject({
      pivot: { x: 50, y: 52 },
      points: [-50, 52, 0.5, 150, 52, 0.5],
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
      action: { anchor, kind: "scale", position: "middle-right", rotation: source.rotation },
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
      { x: 150.502, y: 117.191 },
      { x: 150.503, y: 117.293 },
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

function expectFixedOppositeSide(
  before: NonNullable<ReturnType<typeof createSelectionFrameAtRotation>>,
  after: NonNullable<ReturnType<typeof createSelectionFrameAtRotation>>,
  position: BoxAnchorV1,
): void {
  const fixedPointIndexes: Partial<Record<BoxAnchorV1, readonly number[]>> = {
    "bottom-center": [0, 1],
    "middle-left": [1, 2],
    "middle-right": [0, 3],
    "top-center": [2, 3],
  };
  const indexes = fixedPointIndexes[position];
  if (indexes === undefined) {
    expect(selectionFramePoint(after, oppositeBoxAnchor(position))).toEqual(
      selectionFramePoint(before, oppositeBoxAnchor(position)),
    );
    return;
  }
  for (const index of indexes) expect(after.points[index]).toEqual(before.points[index]);
}

function committedScaleFrame(session: SelectionHandleSession, rotation: number) {
  const commit = session.prepareCommit();
  if (commit.status !== "ready") throw new Error("Expected a group scale commit.");
  const frame = createSelectionFrameAtRotation(commit.replacements, rotation);
  if (frame === null) throw new Error("Expected a committed group frame.");
  return { commit, frame };
}
