import {
  calculateElementBounds,
  translateElementGeometry,
} from "../../../../src/domain/geometry/public";
import {
  MAX_ELEMENT_CELLS,
  spatialCellMembershipCount,
  type SpatialBounds,
} from "../../../../src/domain/spatial/index";
import {
  elementFactsSteps,
  validatedDeltaElementFactsSteps,
} from "../../../../src/persistence/serialization/incremental-validation";
import { completeSerializationSteps } from "../../../../src/persistence/serialization/serialization-model-preparation";
import { describe, expect, it, vi } from "vitest";
import * as geometry from "../../../../src/domain/geometry/public";
import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";

import type {
  BoxShapeElementV1,
  InkElementV1,
  InkSnapshotV1,
  StrokeElementV1,
} from "../../../../src/domain/schema/public";
import {
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../../src/persistence/serialization/public";
import { createAllElementSnapshot, createSnapshot, uuid } from "./fixtures";

describe("incremental serializer validation", () => {
  it("reuses validated local bounds for placed rotated strokes and rejects inconsistent hints", () => {
    const source = stroke(1);
    const placed = { ...source, offset: { x: 120.25, y: 250.125 }, rotation: 0.3 };
    const snapshot = createSnapshot([placed]);
    const validation = validateInkSnapshotV1(snapshot);
    if (!validation.ok) throw new Error(validation.error.message);
    const derivation = validation.derivations.elements[0]!;
    const builds = vi.spyOn(geometry, "calculateElementBounds");
    try {
      const facts = completeSerializationSteps(elementFactsSteps(placed, derivation));
      expect(builds).not.toHaveBeenCalled();
      expect(facts.strokeGeometry?.bounds).toBe(derivation.strokeLocalBounds);
      expect(facts.bottom).toBe(derivation.bounds.maxY);
      expect(() =>
        completeSerializationSteps(
          elementFactsSteps(placed, {
            ...derivation,
            strokeLocalBounds: {
              ...derivation.strokeLocalBounds!,
              minX: derivation.strokeLocalBounds!.minX + 1,
            },
          }),
        ),
      ).toThrow("placement");
    } finally {
      builds.mockRestore();
    }
  });

  it("rejects invalid changed elements while accepting viewport overflow", () => {
    const snapshot = createAllElementSnapshot();
    const serializer = initialized(snapshot);
    const stroke = snapshot.elements[1];
    if (stroke?.kind !== "stroke") throw new Error("Missing stroke fixture.");

    const unknownProperty = { ...stroke, unexpected: true };
    expect(change(serializer, unknownProperty)).toMatchObject({
      error: { code: "snapshot-invalid" },
      ok: false,
    });
    const outsidePage = { ...stroke, points: [-1, 100, 0.5, 50, 100, 0.5] };
    expect(change(serializer, outsidePage)).toEqual({ ok: true, value: undefined });
    expect(serializer.serialize()).toMatchObject({
      ok: true,
      value: { snapshot: { revision: snapshot.revision + 1 } },
    });
  });

  it("enforces aggregate stroke limits without rescanning unchanged point arrays", () => {
    const elements = Array.from({ length: 15_000 }, (_, index) => stroke(index + 1));
    const snapshot = createSnapshot(elements);
    const serializer = initialized(snapshot);
    const inserted = stroke(19_000);

    const result = serializer.applyDelta({
      baseModelRevision: snapshot.revision,
      changedElements: [inserted],
      modelRevision: snapshot.revision + 1,
      orderChanges: { content: [...elements.map(({ id }) => id), inserted.id] },
    });

    expect(result).toMatchObject({
      error: { code: "snapshot-invalid", validationError: { code: "stroke-limit-exceeded" } },
      ok: false,
    });
  });
});

describe("incremental serializer spatial capacity", () => {
  it("retains aggregate spatial memberships across accepted and rejected geometry deltas", () => {
    const dense = Array.from({ length: 1023 }, (_, index) => capacityRectangle(index + 1, 256));
    const remainder = capacityRectangle(1024, 254);
    const target = capacityRectangle(1025, 1);
    const snapshot = createSnapshot([...dense, remainder, target]);
    const serializer = initialized(snapshot);
    const exactLimitTarget = capacityRectangle(1025, 2);

    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        changedElements: [exactLimitTarget],
        modelRevision: 8,
      }),
    ).toEqual({ ok: true, value: undefined });
    const exactLimitSnapshot = {
      ...snapshot,
      elements: snapshot.elements.map((element) =>
        element.id === target.id ? exactLimitTarget : element,
      ),
      revision: 8,
    };
    expect(serializer.serialize()).toEqual(serializeInkbookDocument(exactLimitSnapshot));
    const buildsBeforeRejection = serializer.instrumentation.fragmentBuilds;
    const overLimitTarget = capacityRectangle(1025, 3);

    expect(
      serializer.applyDelta({
        baseModelRevision: 8,
        changedElements: [overLimitTarget],
        modelRevision: 9,
      }),
    ).toMatchObject({
      error: {
        code: "snapshot-invalid",
        validationError: { code: "spatial-index-limit-exceeded" },
      },
      ok: false,
    });
    expect(serializer.instrumentation.fragmentBuilds).toBe(buildsBeforeRejection);
    expect(serializer.serialize()).toEqual(serializeInkbookDocument(exactLimitSnapshot));

    const removedId = dense[0]!.id;
    const acceptedElements = exactLimitSnapshot.elements
      .filter(({ id }) => id !== removedId)
      .map((element) => (element.id === target.id ? overLimitTarget : element));
    expect(
      serializer.applyDelta({
        baseModelRevision: 8,
        changedElements: [overLimitTarget],
        modelRevision: 9,
        orderChanges: { content: acceptedElements.map(({ id }) => id) },
        removedIds: [removedId],
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(serializer.serialize()).toEqual(
      serializeInkbookDocument({ ...snapshot, elements: acceptedElements, revision: 9 }),
    );
  });
});

describe("incremental serializer relation validation", () => {
  it("validates page and connection changes without a full snapshot rescan", () => {
    const snapshot = createAllElementSnapshot();
    const serializer = initialized(snapshot);
    const initialFullRuns = serializer.instrumentation.fullValidationRuns;
    const line = snapshot.elements.find((element) => element.kind === "line");
    if (line?.kind !== "line") throw new Error("Missing line fixture.");
    const connected = {
      ...line,
      startConnection: {
        anchor: { kind: "box" as const, position: "top-left" as const },
        targetId: uuid(99),
      },
    };

    expect(change(serializer, connected)).toMatchObject({
      error: { code: "snapshot-invalid", validationError: { code: "invalid-connection-target" } },
      ok: false,
    });
    expect(serializer.instrumentation.fullValidationRuns).toBe(initialFullRuns);
    expect(
      serializer.applyDelta({
        baseModelRevision: snapshot.revision,
        modelRevision: snapshot.revision + 1,
        page: { ...snapshot.page, activeBufferLines: snapshot.page.activeBufferLines + 1 },
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(serializer.instrumentation.fullValidationRuns).toBe(initialFullRuns);
  });
});

function initialized(snapshot: InkSnapshotV1): IncrementalDocumentSerializer {
  const serializer = new IncrementalDocumentSerializer();
  const result = serializer.reset(snapshot);
  if (!result.ok) throw new Error(result.error.code);
  return serializer;
}

function change(serializer: IncrementalDocumentSerializer, element: InkElementV1 | object) {
  return serializer.applyDelta({
    baseModelRevision: 7,
    changedElements: [element as StrokeElementV1],
    modelRevision: 8,
  });
}

function stroke(index: number): StrokeElementV1 {
  return {
    createdAt: index,
    id: uuid(index),
    kind: "stroke",
    pivot: { x: 100, y: 100 },
    points: [100, 100, 0.5],
    rotation: 0,
    style: {
      color: { type: "theme-text" },
      opacity: 1,
      pressureEnabled: false,
      smoothing: 0.5,
      width: 2,
    },
    tool: "pen",
  };
}

function capacityRectangle(index: number, memberships: number): BoxShapeElementV1 {
  const height = memberships * 256 - 6;
  return {
    createdAt: index,
    height,
    id: uuid(index),
    kind: "rectangle",
    pivot: { x: 127, y: 2 + height / 2 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    width: 250,
    x: 2,
    y: 2,
  };
}

describe("recomputed delta bounds", () => {
  it("uses identical translated pressure bounds after local geometry placement", () => {
    const original: StrokeElementV1 = {
      ...stroke(1),
      points: [
        35, 251, 0.2, 36.21, 251.895, 0.242, 37.37, 252.776, 0.283, 38.434, 253.627, 0.324, 39.361,
        254.435, 0.365, 40.121, 255.187, 0.405, 40.692, 255.87, 0.444, 41.068, 256.473, 0.482,
        41.252, 256.986, 0.519, 41.262, 257.401, 0.555, 41.126, 257.711, 0.589, 40.884, 257.91,
        0.621, 40.58, 257.996, 0.652, 40.263, 257.968, 0.681, 39.984, 257.824, 0.708, 39.79,
        257.569, 0.733, 39.723, 257.206, 0.756, 39.817, 256.741, 0.776, 40.095, 256.182, 0.794,
        40.569, 255.538, 0.81, 41.236, 254.819, 0.823, 42.083, 254.037, 0.834, 43.083, 253.206,
        0.842, 44.201, 252.338, 0.847, 45.392, 251.448, 0.85, 46.608, 250.552, 0.85, 47.799,
        249.662, 0.847, 48.917, 248.794, 0.842, 49.917, 247.963, 0.834, 50.764, 247.181, 0.823,
        51.431, 246.462, 0.81, 51.905, 245.818, 0.794, 52.183, 245.259, 0.776, 52.277, 244.794,
        0.756, 52.21, 244.431, 0.733, 52.016, 244.176, 0.708, 51.737, 244.032, 0.681, 51.42,
        244.004, 0.652, 51.116, 244.09, 0.621, 50.874, 244.289, 0.589, 50.738, 244.599, 0.555,
        50.748, 245.014, 0.519, 50.932, 245.527, 0.482, 51.308, 246.13, 0.444, 51.879, 246.813,
        0.405, 52.639, 247.565, 0.365, 53.566, 248.373, 0.324, 54.63, 249.224, 0.283, 55.79,
        250.105, 0.242, 57, 251, 0.2,
      ],
      pivot: { x: 46, y: 251 },
      style: { ...stroke(1).style, width: 2, pressureEnabled: true },
    };
    const before = calculateElementBounds(original);
    const moved = translateElementGeometry(original, { x: 20, y: 12 });
    const hint = {
      minX: before.minX + 20,
      maxX: before.maxX + 20,
      minY: before.minY + 12,
      maxY: before.maxY + 12,
    };
    expect(hint).toEqual(calculateElementBounds(moved));
    expect(
      completeSerializationSteps(
        validatedDeltaElementFactsSteps(moved, derivation(moved.id, hint)),
      ),
    ).toEqual(completeSerializationSteps(elementFactsSteps(moved)));
    const serializer = initialized(createSnapshot([original]));
    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        modelRevision: 8,
        changedElements: [moved],
        changedElementDerivations: [derivation(moved.id, hint)],
      }),
    ).toEqual({ ok: true, value: undefined });
  });

  it("uses actual capacity and height for grossly understated but self-consistent hints", () => {
    const actual = capacityRectangle(1, 256);
    const hint = derivation(actual.id, { minX: 1, maxX: 2, minY: 1, maxY: 2 });
    expect(completeSerializationSteps(validatedDeltaElementFactsSteps(actual, hint))).toEqual(
      completeSerializationSteps(elementFactsSteps(actual)),
    );
    expect(
      completeSerializationSteps(validatedDeltaElementFactsSteps(actual, hint)).spatialMemberships,
    ).toBeGreaterThan(1);
    const dense = Array.from({ length: 1024 }, (_, index) => capacityRectangle(index + 1, 256));
    const target = capacityRectangle(1025, 1);
    const serializer = initialized(
      createSnapshot([...dense.slice(0, 1023), capacityRectangle(1024, 255), target]),
    );
    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        modelRevision: 8,
        changedElements: [capacityRectangle(1025, 2)],
        changedElementDerivations: [{ ...hint, elementId: target.id }],
      }),
    ).toMatchObject({
      ok: false,
      error: { validationError: { code: "spatial-index-limit-exceeded" } },
    });
  });
});

function derivation(elementId: string, bounds: SpatialBounds) {
  const memberships = spatialCellMembershipCount(bounds);
  return {
    elementId,
    bounds,
    spatialOverflow: memberships > MAX_ELEMENT_CELLS,
    spatialMemberships: memberships > MAX_ELEMENT_CELLS ? 0 : memberships,
  };
}
