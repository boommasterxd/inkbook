import { describe, expect, it } from "vitest";

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
  it("rejects invalid changed elements and out-of-page bounds atomically", () => {
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
    expect(change(serializer, outsidePage)).toMatchObject({
      error: { code: "snapshot-invalid", validationError: { code: "invalid-range" } },
      ok: false,
    });
    expect(serializer.serialize()).toMatchObject({
      ok: true,
      value: { snapshot: { revision: snapshot.revision } },
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
  it("uses full snapshot validation for page and connection relation changes", () => {
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
    expect(serializer.instrumentation.fullValidationRuns).toBe(initialFullRuns + 1);
    expect(
      serializer.applyDelta({
        baseModelRevision: snapshot.revision,
        modelRevision: snapshot.revision + 1,
        page: { ...snapshot.page, writingLineHeight: 49 },
      }),
    ).toMatchObject({ error: { code: "snapshot-invalid" }, ok: false });
    expect(serializer.instrumentation.fullValidationRuns).toBe(initialFullRuns + 2);
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
