import { describe, expect, it } from "vitest";

import { quadraticPoint } from "../../../../src/domain/geometry/public";
import type {
  ArrowElementV1,
  BoxShapeElementV1,
  LineElementV1,
  PointV1,
} from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  SelectionHandleSession,
  type SelectionHandlePreview,
} from "../../../../src/editor/selection/public";
import { connectedLine, IDS, rectangle } from "../../domain/store/fixtures";

function rotationPointer(center: PointV1, radius: number, degrees: number): PointV1 {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: center.x + Math.cos(radians) * radius,
    y: center.y + Math.sin(radians) * radius,
  };
}

function snapPorts(zoom: number) {
  return {
    pointerType: "mouse" as const,
    spatial: { query: () => undefined },
    targets: { get: () => null },
    zoom,
  };
}

function rotatedRectangle(rotation: number, id: string = IDS.target): BoxShapeElementV1 {
  return { ...rectangle(id), rotation };
}

function linear(kind: "arrow" | "line" = "line"): ArrowElementV1 | LineElementV1 {
  return { ...connectedLine(), kind, startConnection: null };
}

function rotationPreview(element: BoxShapeElementV1, zoom: number): SelectionHandlePreview {
  const store = new ElementStore([element]);
  const session = new SelectionHandleSession({
    action: { center: element.pivot, kind: "rotate" },
    elements: [element],
    planner: store,
    snap: snapPorts(zoom),
    startPointer: rotationPointer(element.pivot, 100, 0),
  });
  return session.update(rotationPointer(element.pivot, 100, 78));
}

describe("selection rotation snapping", () => {
  it("snaps to an absolute right angle instead of adding 90 degrees to stored rotation", () => {
    const source = rotatedRectangle(10);

    const preview = rotationPreview(source, 1);

    expect(preview.transform).toEqual({ center: source.pivot, degrees: 80, kind: "rotate" });
    expect(preview.exactElements[0]?.rotation).toBe(90);
    expect(preview.snapGuide).toMatchObject({ center: source.pivot, kind: "rotation" });
    expect(source.rotation).toBe(10);
  });

  it("derives the same absolute snap after reopening a persisted rotation", () => {
    const persisted = JSON.stringify(rotatedRectangle(10));
    const reopened = JSON.parse(persisted) as BoxShapeElementV1;

    expect(rotationPreview(reopened, 1).exactElements[0]?.rotation).toBe(90);
  });

  it("narrows the screen-space snap range at higher zoom", () => {
    const source = rotatedRectangle(10);

    expect(rotationPreview(source, 1).exactElements[0]?.rotation).toBe(90);
    expect(rotationPreview(source, 4).exactElements[0]?.rotation).toBeCloseTo(88, 8);
    expect(rotationPreview(source, 4).snapGuide).toBeNull();
  });

  it("uses the first selected element as the deterministic group reference", () => {
    const first = rotatedRectangle(10);
    const second = rotatedRectangle(-20, "00000000-0000-4000-8000-000000000088");
    const center = { x: 350, y: 150 };
    const store = new ElementStore([first, second]);
    const session = new SelectionHandleSession({
      action: { center, kind: "rotate" },
      elements: [first, second],
      planner: store,
      snap: snapPorts(1),
      startPointer: rotationPointer(center, 100, 0),
    });

    const preview = session.update(rotationPointer(center, 100, 78));

    expect(preview.transform).toEqual({ center, degrees: 80, kind: "rotate" });
    expect(preview.exactElements.map(({ rotation }) => rotation)).toEqual([90, 60]);
  });
});

describe("linear bend snapping", () => {
  it.each(["line", "arrow"] as const)(
    "centers a curved %s handle along the chord while preserving its normal distance",
    (kind) => {
      const source = linear(kind);
      const store = new ElementStore([source]);
      const session = new SelectionHandleSession({
        action: { elementId: source.id, kind: "linear-bend" },
        elements: [source],
        planner: store,
        snap: snapPorts(1),
        startPointer: { x: 250, y: 100 },
      });

      const bent = session.update({ x: 252, y: 150 }).exactElements[0] as
        ArrowElementV1 | LineElementV1;
      const curvePoint = quadraticPoint(bent.start, bent.bend!, bent.end, 0.5);

      expect(curvePoint).toEqual({ x: 250, y: 150 });
      expect(session.preview.snapGuide).toEqual({
        alignment: "symmetric",
        curvePoint: { x: 250, y: 150 },
        end: { x: 400, y: 100 },
        kind: "bend",
        start: { x: 100, y: 100 },
      });
    },
  );

  it("distinguishes a straight-line snap from symmetric bend alignment", () => {
    const source = linear();
    const session = new SelectionHandleSession({
      action: { elementId: source.id, kind: "linear-bend" },
      elements: [source],
      planner: new ElementStore([source]),
      snap: snapPorts(1),
      startPointer: { x: 250, y: 100 },
    });

    session.update({ x: 250, y: 103 });

    expect(session.preview.snapGuide).toEqual({
      alignment: "straight",
      curvePoint: { x: 250, y: 100 },
      end: { x: 400, y: 100 },
      kind: "bend",
      start: { x: 100, y: 100 },
    });
  });

  it("narrows the symmetric bend snap range at higher zoom", () => {
    const source = linear();
    const store = new ElementStore([source]);
    const session = new SelectionHandleSession({
      action: { elementId: source.id, kind: "linear-bend" },
      elements: [source],
      planner: store,
      snap: snapPorts(4),
      startPointer: { x: 250, y: 100 },
    });

    const bent = session.update({ x: 252, y: 150 }).exactElements[0] as LineElementV1;
    const curvePoint = quadraticPoint(bent.start, bent.bend!, bent.end, 0.5);

    expect(curvePoint).toEqual({ x: 252, y: 150 });
    expect(session.preview.snapGuide).toBeNull();
  });
});
