import { expect, it } from "vitest";

import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import { createRetainedCapacityRectangle } from "./fixtures";

it("updates retained serializer capacity without rescanning unchanged geometry", () => {
  const elements = Array.from({ length: 20_000 }, (_, index) =>
    createRetainedCapacityRectangle(index + 1),
  );
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(createSnapshot(elements)).ok).toBe(true);
  const target = elements[0]!;

  for (let revision = 8; revision < 108; revision += 1) {
    const offset = revision % 2;
    const result = serializer.applyDelta({
      baseModelRevision: revision - 1,
      changedElements: [{ ...target, pivot: { x: 150 + offset, y: 150 }, x: 100 + offset }],
      modelRevision: revision,
    });
    expect(result).toEqual({ ok: true, value: undefined });
  }
  expect(serializer.instrumentation).toMatchObject({
    fullValidationRuns: 1,
    incrementalValidationRuns: 100,
    fragmentBuilds: 100,
    cacheElements: 1,
  });
});

it.each([1_000, 20_000])(
  "reads changed geometry only when updating capacity among %i elements",
  (size) => {
    const elements = Array.from({ length: size }, (_, index) =>
      createRetainedCapacityRectangle(index + 1),
    );
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.reset(createSnapshot(elements)).ok).toBe(true);
    const retained = serializer.currentSnapshot()!.elements;
    let unchangedReads = 0;
    let changedReads = 0;
    for (const element of retained) {
      if (element.kind !== "rectangle") throw new Error("Expected retained rectangles.");
      const width = element.width;
      Object.defineProperty(element, "width", {
        enumerable: true,
        get() {
          unchangedReads += 1;
          return width;
        },
      });
    }
    for (let revision = 8; revision < 11; revision += 1) {
      const changed = new Proxy(
        { ...elements[0]!, x: 100 + (revision % 2), pivot: { x: 150 + (revision % 2), y: 150 } },
        {
          get(target, key, receiver) {
            if (key === "width") changedReads += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
        },
      );
      expect(
        serializer.applyDelta({
          baseModelRevision: revision - 1,
          changedElements: [changed],
          modelRevision: revision,
        }),
      ).toEqual({ ok: true, value: undefined });
    }

    expect(unchangedReads).toBe(0);
    expect(changedReads).toBeGreaterThan(0);
    expect(changedReads).toBeLessThanOrEqual(3 * 32);
    expect(serializer.instrumentation).toMatchObject({
      fullValidationRuns: 1,
      incrementalValidationRuns: 3,
      fragmentBuilds: 3,
      cacheElements: 1,
    });
  },
);
