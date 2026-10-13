import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { elementMutationPayloadBytes } from "../../../../src/domain/store/mutation-payload";
import { MutationPreparationScheduler } from "../../../../src/domain/store/mutation-preparation-scheduler";
import {
  captureOwnedMutationHistory,
  createRetainedRecordPayload,
  prepareOwnedMutationHistory,
  restoreOwnedRecord,
  restoreOwnedRecordSteps,
} from "../../../../src/domain/store/owned-mutation-history";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import type { ElementRecord } from "../../../../src/domain/store/types";
import { finishGeometrySteps as drain } from "../../../fixtures/domain/geometry-steps";
import { connectedLine, highlighter } from "./fixtures";

function record(element: InkElementV1): ElementRecord {
  return Object.freeze({
    bounds: Object.freeze({ minX: 0, minY: 0, maxX: 200, maxY: 300 }),
    element,
    geometryVersion: 5,
    paintVersion: 6,
  });
}

describe("owned mutation history retention", () => {
  it("counts nullable references and actual record identity with the shared accumulator", () => {
    const retained = record(highlighter());
    const payload = createRetainedRecordPayload();
    expect(payload.bytes).toBe(64);
    payload.add(null);
    expect(payload.bytes).toBe(64);
    payload.add(retained);
    payload.add(retained);
    expect(payload.bytes).toBe(64 + 160 + 128 + elementMutationPayloadBytes(retained.element));
    payload.add({ ...retained, paintVersion: 7 });
    expect(payload.bytes).toBe(64 + 240 + 256 + 2 * elementMutationPayloadBytes(retained.element));
  });

  it("accounts for private records and leaves order-only records unretained", () => {
    const element = highlighter();
    const store = new ElementStore([element]);
    const original = store.get(element.id)!;
    const delta = store.remove([element.id])!;
    const retained = captureOwnedMutationHistory(delta);
    expect(retained.forward.size).toBe(0);
    expect(retained.reverse.get(element.id)).toBe(original);
    expect(retained.payloadBytes).toBe(464 + elementMutationPayloadBytes(original.element));
    const orderOnly = captureOwnedMutationHistory({
      ...delta,
      changes: [{ id: element.id, before: original, after: original, domains: ["order"] }],
    });
    expect(orderOnly.forward.size).toBe(0);
    expect(orderOnly.reverse.size).toBe(0);
    expect(orderOnly.payloadBytes).toBe(256);
  });

  it("discards incomplete ownership preparation on cancellation and can retry", async () => {
    const element = highlighter();
    const store = new ElementStore([element]);
    const delta = store.remove([element.id])!;
    let cancelled = false;
    expect(
      await prepareOwnedMutationHistory(
        delta,
        new MutationPreparationScheduler({
          isCancelled: () => cancelled,
          shouldYield: () => true,
          yieldControl: async () => {
            cancelled = true;
          },
        }),
      ),
    ).toBe("cancelled");
    const prepared = await prepareOwnedMutationHistory(
      delta,
      new MutationPreparationScheduler({
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    );
    expect(prepared).toEqual(captureOwnedMutationHistory(delta));
  });
});

describe("owned record restoration steps", () => {
  const versions = { geometryVersion: 11, paintVersion: 12 };

  it("preserves owned guards, current identity, bounds and domain versions", () => {
    const element = highlighter();
    const owned = record(element);
    expect(drain(restoreOwnedRecordSteps(element, undefined, undefined, versions))).toBeUndefined();
    expect(
      drain(restoreOwnedRecordSteps({ ...element, createdAt: 99 }, owned, owned, versions)),
    ).toBeUndefined();
    expect(drain(restoreOwnedRecordSteps(element, owned, owned, versions))).toBe(owned);
    const line = connectedLine();
    const cases = [
      { target: element, current: undefined, geometry: 11, paint: 12 },
      { target: element, current: record({ ...element, createdAt: 99 }), geometry: 5, paint: 6 },
      {
        target: element,
        current: record({ ...element, style: { ...element.style, opacity: 0.2 } }),
        geometry: 5,
        paint: 12,
      },
      {
        target: element,
        current: record({ ...element, points: [100, 300, 0.5, 250, 300, 0.5] }),
        geometry: 11,
        paint: 6,
      },
      { target: line, current: record({ ...line, startConnection: null }), geometry: 5, paint: 6 },
    ];
    for (const { target, current, geometry, paint } of cases) {
      const retained = record(target);
      const result = drain(restoreOwnedRecordSteps(target, current, retained, versions, 1));
      expect(result).toEqual(restoreOwnedRecord(target, current, retained, versions));
      expect(result).toMatchObject({ geometryVersion: geometry, paintVersion: paint });
      expect(result!.element).toBe(retained.element);
      expect(result!.bounds).toBe(retained.bounds);
      expect(Object.isFrozen(result)).toBe(true);
      expect(retained.geometryVersion).toBe(5);
      expect(retained.paintVersion).toBe(6);
    }
  });

  it("bounds retained stroke reads across all replay comparisons and stops on abandonment", () => {
    const samples = Array.from({ length: 30_000 }, (_, index) => (index % 3 === 2 ? 0.5 : index));
    let reads = 0;
    const points = () =>
      new Proxy([...samples], {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const element = { ...highlighter(), points: points() };
    const retained = record({ ...element, points: points() });
    const current = record({
      ...element,
      points: points(),
      style: { ...element.style, opacity: 0.2 },
    });
    const steps = restoreOwnedRecordSteps(element, current, retained, versions);
    let result;
    do {
      const previousReads = reads;
      result = steps.next();
      // The owned guard, current comparison and domain classification are three bounded phases.
      expect(reads - previousReads).toBeLessThanOrEqual(3 * 512);
    } while (!result.done);
    expect(reads).toBe(samples.length * 6);
    expect(result.value!.bounds).toBe(retained.bounds);
    expect(result.value).toMatchObject({ geometryVersion: 5, paintVersion: 12 });
    const stopped = restoreOwnedRecordSteps(element, current, retained, versions);
    stopped.next();
    const stoppedReads = reads;
    stopped.return(undefined);
    stopped.next();
    expect(reads).toBe(stoppedReads);
  });
});
