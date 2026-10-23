import { expect, it, vi } from "vitest";
import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import * as strokeSamples from "../../../../src/domain/elements/public";
import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/model/document-model";
import { ModelPointReferences } from "../../../../src/persistence/worker/runtime/bridge/model-point-references";
import {
  encodeRuntimeRequestChunked,
  decodeRuntimeRequestChunked,
} from "../../../../src/persistence/worker/runtime/wire/wire-codec";
import type {
  FullModelSyncRuntimeRequest,
  IncrementalModelSyncRuntimeRequest,
} from "../../../../src/persistence/worker/runtime/types";
import * as sampleCodec from "../../../../src/persistence/serialization/metadata/stroke-sample-codec";
import { elementRenderBand } from "../../../../src/persistence/serialization/output/element-fragments";
import { executor, unlockIdentity } from "../../../unit/persistence/worker/runtime/fixtures";
import { createStandardPersistenceFixture } from "../fixtures";

it("restores 10,000 confirmed deleted strokes with no sample copy, wire scan, transfer or re-encoding", async () => {
  const fixture = createStandardPersistenceFixture(0);
  for (const element of fixture.elements) {
    if (element.kind === "stroke") Object.freeze(element.points);
  }
  const sender = new ModelPointReferences();
  const receiver = new ModelPointReferences(true);
  const native = new DocumentModelRuntime(true);
  const fallback = new DocumentModelRuntime();
  const options = { checkpoint: () => undefined, signal: new AbortController().signal };
  const full: FullModelSyncRuntimeRequest = {
    baseModelRevision: null,
    identity: unlockIdentity,
    modelRevision: 0,
    snapshot: fixture,
    type: "model-sync-full",
  };
  const packed = await encodeRuntimeRequestChunked(full, {
    ...options,
    reusePoints: sender.encoder(full),
  });
  expect(packed.transfer).toHaveLength(10_000);
  expect(
    packed.transfer.reduce<number>(
      (bytes, buffer) => bytes + (buffer as ArrayBuffer).byteLength,
      0,
    ),
  ).toBe(12_000_000);
  const decoded = await decodeRuntimeRequestChunked(packed.value, options);
  const success = (revision: number) => ({
    identity: unlockIdentity,
    modelRevision: revision,
    type: "model-sync-success" as const,
  });
  sender.accept(full, success(0));
  receiver.accept(decoded, success(0));
  native.synchronize(decoded as FullModelSyncRuntimeRequest);
  fallback.synchronize(full);
  await compareModelExports(native, fallback, 0);
  const copy = vi.spyOn(sampleCopy, "copySampleRange");
  const scan = vi.spyOn(strokeSamples, "assertStrokeSamplesV1");
  const encoding = vi.spyOn(sampleCodec, "encodeStrokeSamplesSteps");
  try {
    for (const revision of [1, 3]) {
      const removal: IncrementalModelSyncRuntimeRequest = {
        baseModelRevision: revision - 1,
        identity: unlockIdentity,
        modelRevision: revision,
        removedIds: fixture.elements.map((element) => element.id),
        type: "model-sync-incremental",
      };
      const removed = await encodeRuntimeRequestChunked(removal, {
        ...options,
        reusePoints: sender.encoder(removal),
      });
      const removedRequest = await decodeRuntimeRequestChunked(removed.value, options);
      native.synchronize(removedRequest as IncrementalModelSyncRuntimeRequest);
      fallback.synchronize(removal);
      receiver.accept(removedRequest, success(revision));
      sender.accept(removal, success(revision));
      expect(sender.instrumentation).toEqual(receiver.instrumentation);
      expect(sender.instrumentation.retiredPointElements).toBe(10_000);
      expect(sender.instrumentation.retiredPointBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      const restore = restoreRequest(fixture, revision);
      const restored = await encodeRuntimeRequestChunked(restore, {
        ...options,
        reusePoints: sender.encoder(restore),
      });
      expect(restored.transfer).toHaveLength(0);
      const restoredRequest = await decodeRuntimeRequestChunked(
        restored.value,
        options,
        receiver.resolver(revision, executor),
      );
      receiver.accept(restoredRequest, success(revision + 1));
      sender.accept(restore, success(revision + 1));
      native.synchronize(restoredRequest as IncrementalModelSyncRuntimeRequest);
      fallback.synchronize(restore);
      await compareModelExports(native, fallback, revision + 1);
      for (const model of [native, fallback])
        expect(model.instrumentation).toMatchObject({
          sampleEncodingBuilds: 10_000,
          sampleEncodingHits: revision === 1 ? 10_000 : 20_000,
          retiredPointComparisons: 0,
        });
      expect(sender.instrumentation.retiredPointBytes).toBe(0);
    }
    expect(copy).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(encoding).not.toHaveBeenCalled();
  } finally {
    copy.mockRestore();
    scan.mockRestore();
    encoding.mockRestore();
    sender.clear();
    receiver.clear();
    native.clear();
    fallback.clear();
  }
}, 120_000);

async function compareModelExports(
  native: DocumentModelRuntime,
  fallback: DocumentModelRuntime,
  revision: number,
) {
  const request = {
    ...executor,
    baseModelRevision: revision,
    modelRevision: revision,
    exportGeneration: revision + 1,
    type: "export-incremental" as const,
  };
  const [first, second] = await Promise.all([native.export(request), fallback.export(request)]);
  expect(first.ok).toBe(true);
  expect({ ...second, output: undefined }).toEqual({ ...first, output: undefined });
}

function restoreRequest(
  fixture: InkSnapshotV1,
  revision: number,
): IncrementalModelSyncRuntimeRequest {
  return {
    baseModelRevision: revision,
    identity: unlockIdentity,
    modelRevision: revision + 1,
    changedElements: fixture.elements,
    orderChanges: {
      content: fixture.elements
        .filter((element) => elementRenderBand(element) === "content")
        .map((element) => element.id),
      highlight: fixture.elements
        .filter((element) => elementRenderBand(element) === "highlight")
        .map((element) => element.id),
    },
    type: "model-sync-incremental",
  };
}
