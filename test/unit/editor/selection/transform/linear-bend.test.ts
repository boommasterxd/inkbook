import { describe, expect, it } from "vitest";

import { quadraticPoint, rotatePointClockwise } from "../../../../../src/domain/geometry/public";
import { type ArrowElementV1, type LineElementV1 } from "../../../../../src/domain/schema/public";
import { type StraightHighlighterElementV1 } from "../../../../../src/domain/schema/types";
import { validateInkElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../../src/editor/selection/public";
import { editLinearBendFromCurvePoint } from "../../../../../src/editor/selection/transform/linear-bend";
import { editLinearEndpoint } from "../../../../../src/editor/selection/transform/linear-transforms";
import { straightHighlighter } from "../../../domain/schema/fixtures";

const line = (): LineElementV1 => ({
  bend: null,
  createdAt: 1,
  end: { x: 10, y: 0 },
  endConnection: null,
  endNode: "none",
  id: "00000000-0000-4000-8000-000000000001",
  kind: "line",
  pivot: { x: 5, y: 0 },
  rotation: 0,
  start: { x: 0, y: 0 },
  startConnection: null,
  startNode: "none",
  style: {
    outlineColor: { type: "theme-text" },
    outlineOpacity: 1,
    outlineStyle: "solid",
    outlineWidth: 4,
  },
});

describe("linear bend handles", () => {
  it("maps a dragged handle to the visible quadratic midpoint", () => {
    const target = { x: 5, y: 5 };
    const bent = editLinearBendFromCurvePoint(line(), target) as LineElementV1;

    expect(bent.bend).toEqual({ x: 5, y: 10 });
    expect(quadraticPoint(bent.start, bent.bend!, bent.end, 0.5)).toEqual(target);
    expect(validateInkElementV1(bent).ok).toBe(true);
  });

  it("preserves visible endpoints and the dragged curve point when rotated", () => {
    const rotated = { ...line(), rotation: 90 };
    const previousStart = worldPoint(rotated, rotated.start);
    const previousEnd = worldPoint(rotated, rotated.end);
    const target = { x: 0, y: 0 };
    const bent = editLinearBendFromCurvePoint(rotated, target) as LineElementV1;
    const worldStart = worldPoint(bent, bent.start);
    const worldEnd = worldPoint(bent, bent.end);
    const worldControl = worldPoint(bent, bent.bend!);
    const handle = quadraticPoint(worldStart, worldControl, worldEnd, 0.5);

    expect(worldStart).toEqual(previousStart);
    expect(worldEnd).toEqual(previousEnd);
    expect(handle.x).toBeCloseTo(target.x, 3);
    expect(handle.y).toBeCloseTo(target.y, 3);
    expect(validateInkElementV1(bent).ok).toBe(true);
  });

  it("preserves rotated endpoints when the bend snaps straight", () => {
    const rotated = { ...line(), rotation: 45 };
    const previousStart = worldPoint(rotated, rotated.start);
    const previousEnd = worldPoint(rotated, rotated.end);
    const target = {
      x: previousStart.x * 0.65 + previousEnd.x * 0.35,
      y: previousStart.y * 0.65 + previousEnd.y * 0.35,
    };

    const straightened = editLinearBendFromCurvePoint(rotated, target, 0.001) as LineElementV1;

    expect(straightened.bend).toBeNull();
    expect(worldPoint(straightened, straightened.start).x).toBeCloseTo(previousStart.x, 3);
    expect(worldPoint(straightened, straightened.start).y).toBeCloseTo(previousStart.y, 3);
    expect(worldPoint(straightened, straightened.end).x).toBeCloseTo(previousEnd.x, 3);
    expect(worldPoint(straightened, straightened.end).y).toBeCloseTo(previousEnd.y, 3);
  });

  it("uses the same curve-point contract in the handle session", () => {
    const element = {
      ...line(),
      end: { x: 450, y: 150 },
      pivot: { x: 375, y: 150 },
      start: { x: 300, y: 150 },
    };
    const store = new ElementStore([element]);
    const session = new SelectionHandleSession({
      action: { elementId: element.id, kind: "linear-bend" },
      elements: [element],
      planner: store,
      startPointer: { x: 375, y: 150 },
    });

    const preview = session.update({ x: 375, y: 200 });
    const bent = preview.exactElements[0] as LineElementV1;

    expect(quadraticPoint(bent.start, bent.bend!, bent.end, 0.5)).toEqual({ x: 375, y: 200 });
  });

  it("edits a straight highlighter bend through its handle session", () => {
    const source = straightHighlighter();
    const session = new SelectionHandleSession({
      action: { elementId: source.id, kind: "linear-bend" },
      elements: [source],
      planner: new ElementStore([source]),
      startPointer: { x: 150, y: 200 },
    });

    const bent = session.update({ x: 150, y: 220 }).exactElements[0] as
      StraightHighlighterElementV1 | undefined;

    expect(bent?.kind).toBe("straight-highlighter");
    expect(bent?.bend).toEqual({ x: 150, y: 240 });
    expect(quadraticPoint(bent!.start, bent!.bend!, bent!.end, 0.5)).toEqual({ x: 150, y: 220 });
    expect(validateInkElementV1(bent!).ok).toBe(true);
  });
});

describe("linear bend straightening", () => {
  it.each(["line", "arrow"] as const)(
    "keeps a straightened %s straight after an endpoint edit",
    (kind) => {
      const element = {
        ...line(),
        bend: { x: 50, y: 80 },
        end: { x: 100, y: 0 },
        kind,
        pivot: { x: 50, y: 40 },
      };
      const store = new ElementStore([element]);
      const bendSession = new SelectionHandleSession({
        action: { elementId: element.id, kind: "linear-bend" },
        elements: [element],
        planner: store,
        startPointer: { x: 50, y: 40 },
      });

      const straightened = bendSession.update({ x: 35, y: 3 }).exactElements[0] as
        LineElementV1 | ArrowElementV1;
      expect(straightened.bend).toBeNull();
      const extended = editLinearEndpoint(straightened, "end", { x: 140, y: 60 }) as
        LineElementV1 | ArrowElementV1;

      expect(extended.bend).toBeNull();
      expect(extended.pivot).toEqual({ x: 70, y: 30 });
      expect(validateInkElementV1(extended).ok).toBe(true);
    },
  );

  it("normalizes an older collinear bend before moving an endpoint", () => {
    const legacyStraight = { ...line(), bend: { x: 4, y: 0 }, pivot: { x: 5, y: 0 } };

    const edited = editLinearEndpoint(legacyStraight, "start", { x: -20, y: 30 }) as LineElementV1;

    expect(edited.bend).toBeNull();
  });
});

function worldPoint(element: LineElementV1, point: { readonly x: number; readonly y: number }) {
  return rotatePointClockwise(point, element.pivot, element.rotation);
}
