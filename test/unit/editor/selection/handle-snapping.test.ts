import { describe, expect, it } from "vitest";

import { quadraticPoint, rotatePointClockwise } from "../../../../src/domain/geometry/public";
import type {
  ArrowElementV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  LinearElementV1,
  LineElementV1,
  PointV1,
} from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  editLinearBend,
  oppositeElementHandlePoint,
  SelectionHandleSession,
  type SelectionHandlePreview,
} from "../../../../src/editor/selection/public";
import type { SelectionSnapPorts } from "../../../../src/editor/selection/handle-types";
import { connectedLine, coordinateSystem, IDS, rectangle } from "../../domain/store/fixtures";
import { straightHighlighter } from "../../domain/schema/fixtures";

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

function storeSnapPorts(store: ElementStore, zoom: number): SelectionSnapPorts {
  const targetId = IDS.target;
  return {
    pointerType: "mouse" as const,
    spatial: { query: (_bounds, sink) => sink.add(targetId) },
    targets: {
      get: (id: string) => {
        if (id !== targetId) return null;
        const anchors = store.getSemanticAnchors(id);
        const rank = store.getRank(id);
        return anchors === null || rank === undefined ? null : { anchors, rank: rank.rank };
      },
    },
    zoom,
  };
}

function rotatedRectangle(rotation: number, id: string = IDS.target): BoxShapeElementV1 {
  return { ...rectangle(id), rotation };
}

function linear(kind: "arrow" | "line" = "line"): ArrowElementV1 | LineElementV1 {
  return { ...connectedLine(), kind, startConnection: null };
}

function bentLinear(
  bend: PointV1,
  kind: "arrow" | "line" | "straight-highlighter" = "line",
): LinearElementV1 {
  const source =
    kind === "straight-highlighter"
      ? {
          ...straightHighlighter(),
          end: { x: 400, y: 100 },
          pivot: { x: 250, y: 100 },
          start: { x: 100, y: 100 },
        }
      : linear(kind);
  return editLinearBend(source, bend) as LinearElementV1;
}

function endpointPreview(
  source: LinearElementV1,
  zoom: number,
  options: {
    readonly planner?: ElementStore;
    readonly snap?: SelectionSnapPorts;
    readonly pointer?: PointV1;
  } = {},
): SelectionHandlePreview {
  const session = new SelectionHandleSession({
    action: { elementId: source.id, endpoint: "end", kind: "linear-endpoint" },
    elements: [source],
    planner: options.planner ?? new ElementStore([source]),
    snap: options.snap ?? snapPorts(zoom),
    startPointer: source.end,
  });
  return session.update(options.pointer ?? { x: 500, y: 104 });
}

function rotationPreview(element: BoxShapeElementV1, zoom: number): SelectionHandlePreview {
  const store = new ElementStore([element]);
  const session = new SelectionHandleSession({
    action: {
      center: element.pivot,
      kind: "rotate",
      opposite: oppositeElementHandlePoint(element, "top-center"),
    },
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
    expect(preview.snapGuide).toMatchObject({ kind: "rotation" });
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
      action: { center, kind: "rotate", opposite: { x: center.x - 100, y: center.y } },
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

describe("linear endpoint angular snapping", () => {
  it("snaps a line endpoint to a right angle within the screen-space tolerance", () => {
    const source = linear();
    const preview = endpointPreview(source, 1);

    expect(preview.exactElements[0]).toMatchObject({ end: { x: 500.02, y: 100 } });
    expect(preview.snapGuide).toEqual({
      end: { x: 500.02, y: 100 },
      kind: "angular",
      start: { x: 100, y: 100 },
    });
  });

  it("narrows the endpoint angular snap range as zoom increases", () => {
    const source = linear();
    const preview = endpointPreview(source, 4);

    expect(preview.exactElements[0]).toMatchObject({ end: { x: 500, y: 104 } });
    expect(preview.snapGuide).toBeNull();
  });

  it("prioritizes a nearby shape anchor over an angular endpoint snap", () => {
    const source = linear();
    const target = rectangle(IDS.target, 500, 104);
    const store = new ElementStore([source, target]);
    const preview = endpointPreview(source, 1, {
      planner: store,
      snap: storeSnapPorts(store, 1),
    });

    expect(preview.exactElements[0]).toMatchObject({
      end: { x: 500, y: 104 },
      endConnection: { anchor: { kind: "box", position: "top-left" }, targetId: target.id },
    });
    expect(preview.snapGuide).toEqual({ kind: "anchor", point: { x: 500, y: 104 } });
  });

  it.each(["line", "arrow", "straight-highlighter"] as const)(
    "does not present a straight guide for a curved %s whose endpoint chord is axis-aligned",
    (kind) => {
      const source = bentLinear({ x: 250, y: 250 }, kind);
      const preview = endpointPreview(source, 1, { pointer: { x: 100, y: 500 } });
      const changed = preview.exactElements[0];

      expect(changed?.kind).toBe(kind);
      if (changed === undefined || !("end" in changed) || !("bend" in changed)) {
        throw new Error("Expected a linear preview.");
      }
      expect(changed.end).toEqual({ x: 100, y: 500 });
      expect(changed.bend).not.toBeNull();
      expect(preview.snapGuide).toBeNull();
    },
  );

  it("previews straightening transiently and stores it only when that frame is committed", () => {
    const source = bentLinear({ x: 250, y: 200 });
    const store = new ElementStore([source]);
    const session = new SelectionHandleSession({
      action: { elementId: source.id, endpoint: "end", kind: "linear-endpoint" },
      elements: [source],
      planner: store,
      snap: snapPorts(1),
      startPointer: source.end,
    });

    const straight = session.update({ x: 400, y: 300 });
    expect(straight.exactElements[0]).toMatchObject({ bend: null, end: { x: 400, y: 300 } });
    expect(straight.snapGuide).toEqual({
      end: { x: 400, y: 300 },
      kind: "angular",
      start: { x: 100, y: 100 },
    });
    expect(store.get(source.id)?.element).toMatchObject({ bend: { x: 250, y: 200 } });

    const curvedAgain = session.update({ x: 400, y: 350 });
    expect(curvedAgain.exactElements[0]).toMatchObject({ bend: { x: 250, y: 200 } });
    expect(curvedAgain.snapGuide).toBeNull();
    expect(store.get(source.id)?.element).toMatchObject({ bend: { x: 250, y: 200 } });

    session.update({ x: 400, y: 300 });
    const commit = session.prepareCommit();
    expect(commit.status).toBe("ready");
    if (commit.status !== "ready") throw new Error("Expected a ready endpoint commit.");
    expect(commit.replacements[0]).toMatchObject({ bend: null, end: { x: 400, y: 300 } });
    expect(store.get(source.id)?.element).toMatchObject({ bend: { x: 250, y: 200 } });
    store.replaceMany(commit.replacements);
    expect(store.get(source.id)?.element).toMatchObject({ bend: null, end: { x: 400, y: 300 } });
  });

  it("narrows endpoint straightening tolerance at higher zoom", () => {
    const source = bentLinear({ x: 250, y: 200 });

    expect(
      endpointPreview(source, 1, { pointer: { x: 400, y: 312 } }).exactElements[0],
    ).toMatchObject({ bend: null });
    expect(
      endpointPreview(source, 4, { pointer: { x: 400, y: 312 } }).exactElements[0],
    ).toMatchObject({ bend: { x: 250, y: 200 } });
  });
});

describe("coordinate axis angular snapping", () => {
  it("snaps an axis to the nearest 45-degree direction and exposes its guide", () => {
    const system = coordinateSystem();
    const session = new SelectionHandleSession({
      action: { axisIndex: 0, elementId: system.id, kind: "coordinate-axis" },
      elements: [system],
      planner: new ElementStore([system]),
      snap: snapPorts(1),
      startPointer: system.axes[0],
    });

    const preview = session.update({ x: 450, y: 451 });
    const changed = preview.exactElements[0];

    expect(changed?.kind).toBe("coordinate-system");
    if (changed?.kind !== "coordinate-system") throw new Error("Expected a coordinate system.");
    expect(changed.axes[0]?.x).toBeCloseTo(changed.axes[0]?.y, 3);
    expect(changed.axes[0]?.x).toBeCloseTo(450.501, 2);
    expect(preview.snapGuide).toEqual({
      end: changed.axes[0],
      kind: "angular",
      start: system.origin,
    });
  });
});

describe("coordinate origin angular snapping", () => {
  it.each(["2d", "3d"] as const)(
    "snaps a moved %s origin to 45-degree directions from every axis endpoint",
    (dimension) => {
      const source = coordinateSystem();
      const system =
        dimension === "2d"
          ? {
              ...source,
              axes: [source.axes[0], source.axes[1]] as [PointV1, PointV1],
              dimension,
            }
          : source;
      const preview = coordinateOriginPreview(system, { x: 503, y: 450 });
      const changed = preview.exactElements[0];

      expect(changed?.kind).toBe("coordinate-system");
      if (changed?.kind !== "coordinate-system") throw new Error("Expected a coordinate system.");
      expect(changed.origin.x).toBe(500);
      expect(changed.origin.y).toBeCloseTo(450.03, 2);
      expect(changed.pivot).toEqual(changed.origin);
      expect(preview.snapGuide).toMatchObject({
        end: changed.origin,
        kind: "angular",
        start: system.axes[0],
      });
    },
  );

  it("narrows coordinate-origin snapping at higher zoom", () => {
    const system = coordinateSystem();
    const preview = coordinateOriginPreview(system, { x: 503, y: 450 }, 4);

    expect(preview.exactElements[0]).toMatchObject({ origin: { x: 503, y: 450 } });
    expect(preview.snapGuide).toBeNull();
  });

  it("keeps rotated axis endpoints fixed while snapping the origin in world space", () => {
    const system = { ...coordinateSystem(), rotation: 90 };
    const originalWorldAxes = system.axes.map((axis) =>
      rotatePointClockwise(axis, system.pivot, system.rotation),
    );
    const preview = coordinateOriginPreview(system, { x: 303, y: 650 });
    const changed = preview.exactElements[0];
    if (changed?.kind !== "coordinate-system") throw new Error("Expected a coordinate system.");
    const changedWorldAxes = changed.axes.map((axis) =>
      rotatePointClockwise(axis, changed.pivot, changed.rotation),
    );

    expect(changed.origin.x).toBe(300);
    expect(changed.origin.y).toBeCloseTo(650.03, 2);
    changedWorldAxes.forEach((axis, index) => {
      expect(axis.x).toBeCloseTo(originalWorldAxes[index]!.x, 9);
      expect(axis.y).toBeCloseTo(originalWorldAxes[index]!.y, 9);
    });
    expect(preview.snapGuide).toMatchObject({
      end: changed.origin,
      kind: "angular",
      start: originalWorldAxes[0],
    });
  });
});

function coordinateOriginPreview(
  system: CoordinateSystemElementV1,
  pointer: PointV1,
  zoom = 1,
): SelectionHandlePreview {
  return new SelectionHandleSession({
    action: { elementId: system.id, kind: "coordinate-origin" },
    elements: [system],
    planner: new ElementStore([system]),
    snap: snapPorts(zoom),
    startPointer: system.origin,
  }).update(pointer);
}
