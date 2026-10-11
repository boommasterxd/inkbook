import { describe, expect, it } from "vitest";
import { ModelPointReferences } from "../../../../../src/persistence/worker/runtime/model-point-references";
import {
  adoptTransferredStrokeSamples,
  copyElementsToRuntime,
} from "../../../../../src/persistence/worker/runtime/runtime-elements";
import {
  decodeRuntimeRequest,
  encodeRuntimeRequest,
  encodeRuntimeRequestChunked,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import type {
  FullModelSyncRuntimeRequest,
  IncrementalModelSyncRuntimeRequest,
  ModelSyncRuntimeRequest,
} from "../../../../../src/persistence/worker/runtime/types";
import { executor, snapshot, STROKE, unlockIdentity } from "./fixtures";

Object.freeze(STROKE.points);

const full: FullModelSyncRuntimeRequest = {
  baseModelRevision: null,
  identity: unlockIdentity,
  modelRevision: 0,
  snapshot: { ...snapshot(), elements: [STROKE] },
  type: "model-sync-full",
};
const incremental: IncrementalModelSyncRuntimeRequest = {
  baseModelRevision: 0,
  identity: unlockIdentity,
  modelRevision: 1,
  changedElements: [{ ...STROKE, pivot: { x: 21, y: 22 }, offset: { x: 1, y: 2 } }],
  type: "model-sync-incremental",
};
function confirmedCache() {
  const cache = new ModelPointReferences();
  full.snapshot.elements.forEach(cache.encoder(full));
  encodeRuntimeRequest(full);
  cache.accept(full, { identity: unlockIdentity, modelRevision: 0, type: "model-sync-success" });
  return cache;
}
async function encode(cache: ModelPointReferences, request: ModelSyncRuntimeRequest = incremental) {
  return encodeRuntimeRequestChunked(request, {
    checkpoint: () => Promise.resolve(),
    signal: new AbortController().signal,
    reusePoints: cache.encoder(request),
  });
}

describe("acknowledged worker point references", () => {
  it("reuses exact samples across move, undo and redo without transferring buffers", async () => {
    const cache = confirmedCache();
    for (const [index, element] of [
      incremental.changedElements![0]!,
      STROKE,
      incremental.changedElements![0]!,
    ].entries()) {
      const request = {
        ...incremental,
        baseModelRevision: index,
        modelRevision: index + 1,
        changedElements: [element],
      };
      const encoded = await encode(cache, request);
      expect(encoded.transfer).toEqual([]);
      const decoded = decodeRuntimeRequest(encoded.value, cache.resolver(index, executor));
      expect("changedElements" in decoded && decoded.changedElements?.[0]).toEqual(element);
      expect(
        "changedElements" in decoded &&
          decoded.changedElements?.[0]?.kind === "stroke" &&
          decoded.changedElements[0].points,
      ).toBe(STROKE.points);
      cache.accept(request, {
        identity: unlockIdentity,
        modelRevision: index + 1,
        type: "model-sync-success",
      });
    }
  });

  it("copies replacements, rejects stale references and retires removed IDs", async () => {
    const cache = confirmedCache();
    const replacement = {
      ...incremental,
      changedElements: [{ ...STROKE, points: [...STROKE.points] }],
    };
    expect((await encode(cache, replacement)).transfer).toHaveLength(1);
    const encoded = await encode(cache);
    expect(() => decodeRuntimeRequest(encoded.value)).toThrow("index");
    expect(() => decodeRuntimeRequest(encoded.value, cache.resolver(1, executor))).toThrow(
      "acknowledged",
    );
    expect(() =>
      decodeRuntimeRequest(encoded.value, cache.resolver(0, { ...executor, workerEpoch: 4 })),
    ).toThrow("acknowledged");
    cache.accept(
      { ...incremental, changedElements: [], removedIds: [STROKE.id] },
      { identity: unlockIdentity, modelRevision: 1, type: "model-sync-success" },
    );
    expect(() => cache.resolver(1, executor)(STROKE.id)).toThrow("acknowledged");
    cache.clear();
    expect(cache.encoder(incremental)(STROKE)).toBe(false);
  });

  it("does not acknowledge failed requests or cross-session bases", () => {
    const cache = confirmedCache();
    cache.accept(incremental, {
      identity: unlockIdentity,
      code: "cancelled",
      retryable: true,
      type: "runtime-failure",
    });
    expect(cache.encoder(incremental)(STROKE)).toBe(true);
    expect(
      cache.encoder({ ...incremental, identity: { ...unlockIdentity, sessionId: "other" } })(
        STROKE,
      ),
    ).toBe(false);
  });
});

describe("worker point ownership", () => {
  it("does not upgrade points frozen only after their original transfer", async () => {
    const stroke = { ...STROKE, points: [...STROKE.points] };
    const request = { ...full, snapshot: { ...full.snapshot, elements: [stroke] } };
    const cache = new ModelPointReferences();
    await encode(cache, request);
    stroke.points[0] = 11;
    Object.freeze(stroke.points);
    cache.accept(request, {
      identity: unlockIdentity,
      modelRevision: 0,
      type: "model-sync-success",
    });
    expect(
      (await encode(cache, { ...incremental, changedElements: [stroke] })).transfer,
    ).toHaveLength(1);
  });

  it("copies caller-owned mutable typed arrays even when their identity is unchanged", async () => {
    const points = new Float64Array(STROKE.points);
    const stroke = { ...STROKE, points: adoptTransferredStrokeSamples(points) };
    const cache = new ModelPointReferences();
    cache.accept(
      { ...full, snapshot: { ...full.snapshot, elements: [stroke] } },
      {
        identity: unlockIdentity,
        modelRevision: 0,
        type: "model-sync-success",
      },
    );
    points[0] = 11;
    const encoded = await encode(cache, { ...incremental, changedElements: [stroke] });
    expect(encoded.transfer).toHaveLength(1);
    const decoded = decodeRuntimeRequest(encoded.value);
    expect(
      decoded.type === "model-sync-incremental" &&
        decoded.changedElements?.[0]?.kind === "stroke" &&
        decoded.changedElements[0].points[0],
    ).toBe(11);
  });

  it("publishes unlock batches only after terminal success", () => {
    encodeRuntimeRequest(full);
    const cache = new ModelPointReferences();
    cache.stageUnlock({
      batchIndex: 0,
      derivations: [],
      elements: [STROKE],
      identity: unlockIdentity,
    });
    expect(cache.encoder(incremental)(STROKE)).toBe(false);
    cache.accept(
      { identity: unlockIdentity, input: "", type: "unlock" },
      {
        identity: unlockIdentity,
        lockedHeight: 100,
        outputHash: "hash",
        requiresCanonicalRewrite: false,
        snapshot: { ...snapshot(), batchCount: 1, elementCount: 1 },
        sourceVersion: 1,
        type: "unlock-success",
      },
    );
    expect(cache.encoder(incremental)(STROKE)).toBe(true);
  });

  it("shares fallback runtime buffers only for unchanged source sample identity", () => {
    const copies = new WeakMap();
    const first = copyElementsToRuntime([STROKE], copies)[0]!;
    const moved = copyElementsToRuntime(incremental.changedElements!, copies)[0]!;
    const replaced = copyElementsToRuntime([{ ...STROKE, points: [...STROKE.points] }], copies)[0]!;
    expect(first.kind === "stroke" && moved.kind === "stroke" && moved.points).toBe(
      first.kind === "stroke" && first.points,
    );
    expect(first.kind === "stroke" && replaced.kind === "stroke" && replaced.points).not.toBe(
      first.kind === "stroke" && first.points,
    );
  });
});

it("rejects frozen accessor samples without publishing a reusable reference", async () => {
  const points = [...STROKE.points];
  let reads = 0;
  Object.defineProperty(points, 0, {
    enumerable: true,
    get: () => {
      reads += 1;
      return 10;
    },
  });
  Object.freeze(points);
  const stroke = { ...STROKE, points };
  const request = { ...full, snapshot: { ...full.snapshot, elements: [stroke] } };
  const cache = new ModelPointReferences();
  await expect(encode(cache, request)).rejects.toThrow("data values");
  cache.accept(request, {
    identity: unlockIdentity,
    modelRevision: 0,
    type: "model-sync-success",
  });
  expect(cache.encoder({ ...incremental, changedElements: [stroke] })(stroke)).toBe(false);
  expect(reads).toBe(0);
  expect(() => cache.resolver(0, executor)(stroke.id)).toThrow("acknowledged");
});

describe("encoded point identity snapshots", () => {
  it("binds frozen samples to their encoded element ID before mutable records change", async () => {
    const first = { ...STROKE };
    const second = {
      ...STROKE,
      id: "00000000-0000-4000-8000-000000000003",
      points: [...STROKE.points],
    };
    Object.freeze(second.points);
    const request = { ...full, snapshot: { ...full.snapshot, elements: [first, second] } };
    const cache = new ModelPointReferences();
    await encode(cache, request);
    first.points = second.points;
    cache.accept(request, {
      identity: unlockIdentity,
      modelRevision: 0,
      type: "model-sync-success",
    });
    expect(
      (await encode(cache, { ...incremental, changedElements: [first] })).transfer,
    ).toHaveLength(1);
  });

  it("invalidates encoded replacements even if callers subsequently remove them from the request", async () => {
    const cache = confirmedCache();
    const changedElements = [{ ...STROKE, points: [...STROKE.points] }];
    const request = { ...incremental, changedElements };
    await encode(cache, request);
    changedElements.length = 0;
    cache.accept(request, {
      identity: unlockIdentity,
      modelRevision: 1,
      type: "model-sync-success",
    });
    expect(cache.encoder({ ...incremental, baseModelRevision: 1, modelRevision: 2 })(STROKE)).toBe(
      false,
    );
  });

  it("retires the IDs actually encoded when callers mutate the removed-ID array", async () => {
    const cache = confirmedCache();
    const removedIds = [STROKE.id];
    const request = { ...incremental, changedElements: [], removedIds };
    await encode(cache, request);
    removedIds.length = 0;
    cache.accept(request, {
      identity: unlockIdentity,
      modelRevision: 1,
      type: "model-sync-success",
    });
    expect(() => cache.resolver(1, executor)(STROKE.id)).toThrow("acknowledged");
  });
});
