import { describe, expect, it } from "vitest";

import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import {
  IncrementalDocumentSerializer,
  serializeInkbookDocument,
} from "../../../../src/persistence/serialization/public";
import {
  packElements,
  unpackElements,
} from "../../../../src/persistence/worker/runtime/element-wire-codec";
import {
  createAllElementSnapshot,
  createDottedRectangleSnapshot,
  createSnapshot,
  uuid,
} from "./fixtures";

describe("incremental document fragments", () => {
  it("assembles byte-identical full output", () => {
    const snapshot = createAllElementSnapshot();
    const expected = serializeInkbookDocument(snapshot);
    const serializer = new IncrementalDocumentSerializer();

    expect(serializer.reset(snapshot).ok).toBe(true);
    const actual = serializer.serialize();

    expect(actual).toEqual(expected);
    expect(serializer.instrumentation.fragmentBuilds).toBe(snapshot.elements.length);
  });

  it("rebuilds only one changed element and reuses every other fragment", () => {
    const snapshot = createAllElementSnapshot();
    const { buildsBefore, serializer } = warmedSerializer(snapshot);
    const original = snapshot.elements[1];
    if (original?.kind !== "stroke") throw new Error("Missing stroke fixture.");
    const changed = { ...original, createdAt: 20, points: [...original.points] };
    changed.points[0] = changed.points[0]! + 1;

    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        changedElements: [changed],
        modelRevision: 8,
      }),
    ).toEqual({ ok: true, value: undefined });
    const actual = serializer.serialize({ hash: () => "incremental" });
    const expected = serializeInkbookDocument(
      {
        ...snapshot,
        revision: 8,
        elements: snapshot.elements.map((element) =>
          element.id === changed.id ? changed : element,
        ),
      },
      { hash: () => "incremental" },
    );

    expect(actual).toEqual(expected);
    expect(serializer.instrumentation.fragmentBuilds - buildsBefore).toBe(1);
  });

  it("applies order-only changes without rebuilding element fragments", () => {
    const snapshot = createAllElementSnapshot();
    const { buildsBefore, serializer } = warmedSerializer(snapshot);
    const highlight = [snapshot.elements[0]!.id];
    const content = snapshot.elements
      .slice(1)
      .map(({ id }) => id)
      .reverse();

    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        modelRevision: 8,
        orderChanges: { content, highlight },
      }).ok,
    ).toBe(true);
    const result = serializer.serialize({ hash: () => "ordered" });

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.snapshot.elements.map(({ id }) => id)).toEqual([
        ...highlight,
        ...content,
      ]);
    expect(serializer.instrumentation.fragmentBuilds).toBe(buildsBefore);
  });

  it("adopts unchanged cached fragments across full resets", () => {
    const snapshot = createAllElementSnapshot();
    const { buildsBefore, serializer } = warmedSerializer(snapshot);

    expect(serializer.reset(structuredClone(snapshot)).ok).toBe(true);
    expect(serializer.serialize({ hash: () => "reset" }).ok).toBe(true);

    expect(serializer.instrumentation.fragmentBuilds).toBe(buildsBefore);
  });
});

describe("incremental bounds derivation reuse", () => {
  it("reuses matching bounds, recomputes stale hints and rejects mismatched identities atomically", () => {
    const snapshot = createAllElementSnapshot();
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.reset(snapshot).ok).toBe(true);
    const original = snapshot.elements[1]!;
    if (original.kind !== "stroke") throw new Error("Missing stroke fixture.");
    const changed = { ...original, points: [...original.points] };
    changed.points[0] = changed.points[0]! + 1;
    const nextSnapshot = {
      ...snapshot,
      elements: snapshot.elements.map((element) => (element.id === changed.id ? changed : element)),
      revision: 8,
    };
    const validation = validateInkSnapshotV1(nextSnapshot);
    if (!validation.ok) throw new Error(validation.error.message);
    const derivation = validation.derivations.elements.find(
      ({ elementId }) => elementId === changed.id,
    )!;
    const reusesBefore = serializer.instrumentation.derivedBoundsReuses;

    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        changedElementDerivations: [derivation],
        changedElements: [changed],
        modelRevision: 8,
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(serializer.instrumentation.derivedBoundsReuses).toBe(reusesBefore + 1);

    const staleDerivation = {
      ...derivation,
      bounds: { ...derivation.bounds, maxX: derivation.bounds.maxX + 1 },
    };
    expect(
      serializer.applyDelta({
        baseModelRevision: 8,
        changedElementDerivations: [staleDerivation],
        changedElements: [changed],
        modelRevision: 9,
      }),
    ).toEqual({ ok: true, value: undefined });
    for (const invalidDerivation of [
      { ...derivation, elementId: uuid(99) },
      { ...derivation, spatialMemberships: derivation.spatialMemberships + 1 },
    ]) {
      expect(
        serializer.applyDelta({
          baseModelRevision: 9,
          changedElementDerivations: [invalidDerivation],
          changedElements: [changed],
          modelRevision: 10,
        }),
      ).toMatchObject({ error: { code: "invalid-delta" }, ok: false });
      expect(serializer.currentSnapshot()?.revision).toBe(9);
    }
  });
});

describe("incremental fragment cache lifecycle", () => {
  it("releases stale, removed, and cleared fragment revisions within the hard byte bound", () => {
    const snapshot = createAllElementSnapshot();
    const { serializer } = warmedSerializer(snapshot);
    const changed = { ...snapshot.elements[1]!, createdAt: 1234 };

    expect(serializer.reset({ ...snapshot, elements: [snapshot.elements[0]!, changed] }).ok).toBe(
      true,
    );
    expect(serializer.serialize().ok).toBe(true);
    expect(serializer.instrumentation.cacheElements).toBe(2);
    expect(serializer.instrumentation.cacheBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(
      serializer.applyDelta({
        baseModelRevision: snapshot.revision,
        modelRevision: snapshot.revision + 1,
        orderChanges: { content: [changed.id], highlight: [] },
        removedIds: [snapshot.elements[0]!.id],
      }).ok,
    ).toBe(true);
    expect(serializer.instrumentation.cacheElements).toBe(1);

    serializer.clear();
    expect(serializer.instrumentation).toMatchObject({ cacheBytes: 0, cacheElements: 0 });
  });
});

describe("incremental background boundaries", () => {
  it("releases cached background geometry on clear", () => {
    const snapshot = createAllElementSnapshot();
    const serializer = new IncrementalDocumentSerializer();
    serializer.reset(snapshot);
    expect(serializer.serialize().ok).toBe(true);
    const builds = serializer.instrumentation.backgroundBuilds;

    serializer.clear();
    serializer.reset(snapshot);
    expect(serializer.serialize().ok).toBe(true);
    expect(serializer.instrumentation.backgroundBuilds).toBe(builds + 1);
  });

  it("rejects dense dotted background output before building its geometry", async () => {
    const snapshot = createDottedRectangleSnapshot(990_000);
    const serializer = new IncrementalDocumentSerializer();

    expect(serializer.reset(snapshot).ok).toBe(true);
    expect(serializer.serialize()).toMatchObject({
      ok: false,
      error: { code: "static-output-limit-exceeded" },
    });
    await expect(serializer.serializeChunked()).resolves.toMatchObject({
      ok: false,
      error: { code: "static-output-limit-exceeded" },
    });
    expect(serializer.instrumentation.backgroundBuilds).toBe(0);
  });
});

describe("runtime stroke fragment serialization", () => {
  it("retains worker-owned stroke buffers while emitting public-schema JSON", () => {
    const snapshot = createAllElementSnapshot();
    const packed = packElements(snapshot.elements);
    const transferred = structuredClone(packed, {
      transfer: packed.pointBuffers.map(({ buffer }) => buffer as ArrayBuffer),
    });
    const elements = unpackElements(transferred);
    const runtimeSnapshot = { ...snapshot, elements };
    const stroke = runtimeSnapshot.elements.find((element) => element.kind === "stroke");
    if (stroke?.kind !== "stroke") throw new Error("Missing stroke fixture.");
    const transferredPoints = stroke.points;
    const serializer = new IncrementalDocumentSerializer();

    expect(validateInkSnapshotV1(runtimeSnapshot).ok).toBe(false);
    expect(serializer.resetRuntime(runtimeSnapshot).ok).toBe(true);
    const actual = serializer.serialize();
    const expected = serializeInkbookDocument(snapshot);

    expect(actual.ok).toBe(true);
    expect(expected.ok).toBe(true);
    if (!actual.ok || !expected.ok) throw new Error("Serialization failed.");
    expect(actual.value.svg).toBe(expected.value.svg);
    expect(actual.value.hash).toBe(expected.value.hash);
    const serializedStroke = actual.value.snapshot.elements.find(
      (element) => element.kind === "stroke",
    );
    expect(serializedStroke?.kind).toBe("stroke");
    if (serializedStroke?.kind !== "stroke") throw new Error("Missing serialized stroke.");
    expect(serializedStroke.points).toBe(transferredPoints);
    expect(serializedStroke.points).toBeInstanceOf(Float64Array);

    serializer.clear();
    expect(serializer.instrumentation).toMatchObject({ cacheBytes: 0, cacheElements: 0 });
    expect(serializer.serialize()).toMatchObject({ ok: false });
  });
});

describe("incremental document delta validation", () => {
  it("requires complete order for insertion and applies removal atomically", () => {
    const snapshot = createSnapshot();
    const serializer = new IncrementalDocumentSerializer();
    serializer.reset(snapshot);
    const rectangle = {
      kind: "rectangle" as const,
      id: uuid(50),
      createdAt: 50,
      rotation: 0,
      pivot: { x: 150, y: 150 },
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      style: {
        outlineColor: { type: "theme-text" as const },
        outlineWidth: 4 as const,
        outlineOpacity: 1,
        outlineStyle: "solid" as const,
        fillColor: null,
        fillOpacity: 0,
      },
    };

    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        changedElements: [rectangle],
        modelRevision: 8,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-order" } });
    expect(serializer.serialize()).toMatchObject({ ok: true, value: { snapshot } });

    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        changedElements: [rectangle],
        modelRevision: 8,
        orderChanges: { content: [rectangle.id] },
      }).ok,
    ).toBe(true);
    expect(
      serializer.applyDelta({
        baseModelRevision: 8,
        modelRevision: 9,
        orderChanges: { content: [] },
        removedIds: [rectangle.id],
      }).ok,
    ).toBe(true);
    expect(serializer.serialize()).toMatchObject({
      ok: true,
      value: { snapshot: { elements: [], revision: 9 } },
    });
  });

  it("rejects stale, overlapping, and schema-invalid deltas without changing state", () => {
    const snapshot = createAllElementSnapshot();
    const serializer = new IncrementalDocumentSerializer();
    serializer.reset(snapshot);
    const element = snapshot.elements[1]!;

    expect(serializer.applyDelta({ baseModelRevision: 6, modelRevision: 8 })).toMatchObject({
      ok: false,
      error: { code: "base-revision-mismatch" },
    });
    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        changedElements: [element],
        modelRevision: 8,
        removedIds: [element.id],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-delta" } });
    const invalid = { ...element, unexpected: true };
    expect(
      serializer.applyDelta({ baseModelRevision: 7, changedElements: [invalid], modelRevision: 8 }),
    ).toMatchObject({ ok: false, error: { code: "snapshot-invalid" } });
    expect(serializer.serialize()).toMatchObject({
      ok: true,
      value: { snapshot: { revision: 7 } },
    });
  });
});

function warmedSerializer(snapshot: ReturnType<typeof createAllElementSnapshot>): {
  readonly buildsBefore: number;
  readonly serializer: IncrementalDocumentSerializer;
} {
  const serializer = new IncrementalDocumentSerializer();
  serializer.reset(snapshot);
  serializer.serialize({ hash: () => "baseline" });
  return { buildsBefore: serializer.instrumentation.fragmentBuilds, serializer };
}
