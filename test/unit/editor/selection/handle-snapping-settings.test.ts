import { describe, expect, it } from "vitest";

import { quadraticPoint } from "../../../../src/domain/geometry/public";
import type { LineElementV1, PointV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  oppositeElementHandlePoint,
  SelectionHandleSession,
  type SelectionSnapFeatures,
} from "../../../../src/editor/selection/public";
import type { SelectionSnapPorts } from "../../../../src/editor/selection/handle-types";
import { connectedLine, IDS, rectangle } from "../../domain/store/fixtures";
import { table } from "../../domain/schema/fixtures";

function featuresWithout(feature: keyof SelectionSnapFeatures): SelectionSnapFeatures {
  return {
    angles: feature !== "angles",
    bends: feature !== "bends",
    connections: feature !== "connections",
    structures: feature !== "structures",
  };
}

const ALL_FEATURES: SelectionSnapFeatures = {
  angles: true,
  bends: true,
  connections: true,
  structures: true,
};

function emptyPorts(features: SelectionSnapFeatures): SelectionSnapPorts {
  return {
    features,
    pointerType: "mouse",
    spatial: { query: () => undefined },
    targets: { get: () => null },
    zoom: 1,
  };
}

function line(): LineElementV1 {
  return { ...connectedLine(), startConnection: null };
}

function rotationPointer(center: PointV1, degrees: number): PointV1 {
  const radians = (degrees * Math.PI) / 180;
  return { x: center.x + Math.cos(radians) * 100, y: center.y + Math.sin(radians) * 100 };
}

function rotationSession(features: SelectionSnapFeatures) {
  const shape = { ...rectangle(), rotation: 10 };
  return {
    pointer: rotationPointer(shape.pivot, 78),
    session: new SelectionHandleSession({
      action: {
        center: shape.pivot,
        kind: "rotate",
        opposite: oppositeElementHandlePoint(shape, "top-center"),
        referenceRotation: shape.rotation,
      },
      elements: [shape],
      planner: new ElementStore([shape]),
      snap: emptyPorts(features),
      startPointer: rotationPointer(shape.pivot, 0),
    }),
  };
}

describe("selection handle snapping settings", () => {
  it("leaves rotation and endpoint directions free when angle snapping is disabled", () => {
    const { pointer, session } = rotationSession(featuresWithout("angles"));
    const rotation = session.update(pointer);
    expect(rotation.exactElements[0]?.rotation).toBeCloseTo(88, 8);
    expect(rotation.snapGuide).toBeNull();

    const source = line();
    const endpointSession = new SelectionHandleSession({
      action: { elementId: source.id, endpoint: "end", kind: "linear-endpoint" },
      elements: [source],
      planner: new ElementStore([source]),
      snap: emptyPorts(featuresWithout("angles")),
      startPointer: source.end,
    });
    const endpoint = endpointSession.update({ x: 500, y: 104 });
    expect(endpoint.exactElements[0]).toMatchObject({ end: { x: 500, y: 104 } });
    expect(endpoint.snapGuide).toBeNull();
  });

  it("keeps the visible bend handle under the pointer when bend snapping is disabled", () => {
    const source = line();
    const session = new SelectionHandleSession({
      action: { elementId: source.id, kind: "linear-bend" },
      elements: [source],
      planner: new ElementStore([source]),
      snap: emptyPorts(featuresWithout("bends")),
      startPointer: { x: 250, y: 100 },
    });

    const changed = session.update({ x: 252, y: 150 }).exactElements[0] as LineElementV1;
    expect(quadraticPoint(changed.start, changed.bend!, changed.end, 0.5)).toEqual({
      x: 252,
      y: 150,
    });
    expect(session.preview.snapGuide).toBeNull();
  });

  it("does not attach an endpoint when connection snapping is disabled", () => {
    const source = line();
    const target = rectangle(IDS.target, 500, 104);
    const store = new ElementStore([source, target]);
    const ports: SelectionSnapPorts = {
      features: featuresWithout("connections"),
      pointerType: "mouse",
      spatial: { query: (_bounds, sink) => sink.add(target.id) },
      targets: {
        get: (id) => {
          const rank = store.getRank(id)?.rank;
          const anchors = store.getSemanticAnchors(id);
          return anchors === null || rank === undefined ? null : { anchors, rank };
        },
      },
      zoom: 1,
    };
    const session = new SelectionHandleSession({
      action: { elementId: source.id, endpoint: "end", kind: "linear-endpoint" },
      elements: [source],
      planner: store,
      snap: ports,
      startPointer: source.end,
    });

    const preview = session.update({ x: 500, y: 104 });
    expect(preview.exactElements[0]).toMatchObject({ endConnection: null });
    expect(preview.snapGuide).toMatchObject({ kind: "angular" });
  });

  it("keeps a table separator at the pointer when structure snapping is disabled", () => {
    const source = table();
    const session = new SelectionHandleSession({
      action: { elementId: source.id, kind: "table-header" },
      elements: [source],
      planner: new ElementStore([source]),
      snap: emptyPorts(featuresWithout("structures")),
      startPointer: { x: source.x, y: source.y + source.headerHeight },
    });

    const preview = session.update({ x: source.x, y: source.y + source.headerHeight + 3 });
    expect(preview.exactElements[0]).toMatchObject({ headerHeight: source.headerHeight + 3 });
    expect(preview.snapGuide).toBeNull();
  });
});

describe("temporary handle snapping override", () => {
  it("updates snapping without restarting the active gesture", () => {
    const { pointer, session } = rotationSession(featuresWithout("angles"));

    expect(session.update(pointer).exactElements[0]?.rotation).toBeCloseTo(88, 8);
    const snapped = session.update(pointer, { snapFeatures: ALL_FEATURES });
    expect(snapped.exactElements[0]?.rotation).toBe(90);
    expect(snapped.snapGuide).toMatchObject({ kind: "rotation" });
    const free = session.update(pointer, { snapFeatures: featuresWithout("angles") });
    expect(free.exactElements[0]?.rotation).toBeCloseTo(88, 8);
    expect(free.snapGuide).toBeNull();
  });
});
