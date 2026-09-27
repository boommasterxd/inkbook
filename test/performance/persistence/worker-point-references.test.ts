import { describe, expect, it } from "vitest";
import { ModelPointReferences } from "../../../src/persistence/worker/runtime/model-point-references";
import {
  encodeRuntimeRequestChunked,
  decodeRuntimeRequest,
} from "../../../src/persistence/worker/runtime/wire-codec";
import {
  STROKE,
  snapshot,
  executor,
  unlockIdentity,
} from "../../unit/persistence/worker/runtime/fixtures";
import type {
  FullModelSyncRuntimeRequest,
  IncrementalModelSyncRuntimeRequest,
} from "../../../src/persistence/worker/runtime/types";

describe("worker translation sample work", () => {
  it("transfers no sample buffers and reads no samples when moving ten thousand strokes", async () => {
    let pointReads = 0;
    const points = [...STROKE.points];
    for (let index = 0; index < points.length; index += 1) {
      const value = points[index]!;
      Object.defineProperty(points, index, {
        get: () => {
          pointReads += 1;
          return value;
        },
      });
    }
    Object.freeze(points);
    const elements = Array.from({ length: 10_000 }, (_, index) => ({
      ...STROKE,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      points,
    }));
    const full: FullModelSyncRuntimeRequest = {
      baseModelRevision: null,
      identity: unlockIdentity,
      modelRevision: 0,
      snapshot: { ...snapshot(), elements },
      type: "model-sync-full",
    };
    const cache = new ModelPointReferences();
    const options = { checkpoint: () => Promise.resolve(), signal: new AbortController().signal };
    const initial = await encodeRuntimeRequestChunked(full, {
      ...options,
      reusePoints: cache.encoder(full),
    });
    expect(initial.transfer).toHaveLength(10_000);
    expect(pointReads).toBeGreaterThan(0);
    cache.accept(full, { identity: unlockIdentity, modelRevision: 0, type: "model-sync-success" });
    pointReads = 0;
    const moved: IncrementalModelSyncRuntimeRequest = {
      baseModelRevision: 0,
      identity: unlockIdentity,
      modelRevision: 1,
      changedElements: elements.map((element) => ({
        ...element,
        offset: { x: 1, y: 2 },
        pivot: { x: 21, y: 22 },
      })),
      type: "model-sync-incremental",
    };
    const encoded = await encodeRuntimeRequestChunked(moved, {
      ...options,
      reusePoints: cache.encoder(moved),
    });
    expect(encoded.transfer).toHaveLength(0);
    const decoded = decodeRuntimeRequest(encoded.value, cache.resolver(0, executor));
    expect(decoded.type).toBe("model-sync-incremental");
    if (decoded.type !== "model-sync-incremental") throw new Error("Unexpected request.");
    expect(decoded.changedElements).toHaveLength(10_000);
    for (const element of decoded.changedElements!) {
      expect(element.kind === "stroke" && element.points).toBe(points);
    }
    expect(pointReads).toBe(0);
    cache.clear();
    expect(() => decodeRuntimeRequest(encoded.value, cache.resolver(0, executor))).toThrow(
      "acknowledged",
    );
  });
});
