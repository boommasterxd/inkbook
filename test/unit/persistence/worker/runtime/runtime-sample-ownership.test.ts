import { expect, it, vi } from "vitest";
import type { InkSnapshotV1 } from "../../../../../src/domain/schema/public";
import { validateRuntimeInkSnapshotV1 } from "../../../../../src/domain/schema/snapshot-validation";
import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/document-runtime";
import { createProductionDocumentRuntime } from "../../../../../src/persistence/worker/runtime/production-document-runtime";
import { adoptTransferredStrokeSamples } from "../../../../../src/persistence/worker/runtime/runtime-elements";
import {
  decodeRuntimeRequest,
  encodeRuntimeRequest,
} from "../../../../../src/persistence/worker/runtime/wire-codec";
import { hydrateRuntimeStroke } from "../../../../fixtures/domain/runtime-stroke-store";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { executor, snapshot, STROKE } from "./fixtures";

function mutableRuntimeSnapshot(): InkSnapshotV1 {
  return {
    ...snapshot(),
    elements: [
      { ...STROKE, points: adoptTransferredStrokeSamples(new Float64Array(STROKE.points)) },
    ],
  };
}

async function fullExport(model: DocumentModelRuntime, input: InkSnapshotV1) {
  const result = await model.export({
    ...executor,
    baseModelRevision: null,
    exportGeneration: 1,
    modelRevision: input.revision,
    snapshot: input,
    type: "export-full",
  });
  if (!result.ok) throw new Error(result.code);
  return result;
}

it.each([false, true])(
  "privately snapshots mutable caller samples before a full reset (fresh buffer: %s)",
  async (freshBuffer) => {
    const model = new DocumentModelRuntime();
    const input = mutableRuntimeSnapshot();
    const before = await fullExport(model, input);
    const stroke = input.elements[0]!;
    if (stroke.kind !== "stroke") throw new Error("Missing stroke.");
    stroke.points[0] = 11;
    const next = freshBuffer
      ? {
          ...input,
          elements: [
            { ...stroke, points: adoptTransferredStrokeSamples(new Float64Array(stroke.points)) },
          ],
        }
      : input;
    const after = await fullExport(model, next);
    const fresh = await fullExport(new DocumentModelRuntime(), next);
    expect(after.hash).not.toBe(before.hash);
    expect(after.hash).toBe(fresh.hash);
    expect(after.output).toEqual(fresh.output);
    model.clear();
  },
);

it("privately snapshots incremental caller samples before later full recovery", async () => {
  const model = new DocumentModelRuntime();
  const input = mutableRuntimeSnapshot();
  await fullExport(model, input);
  const changed = {
    ...input.elements[0]!,
    points: adoptTransferredStrokeSamples(new Float64Array([11, 10, 0.5, 20, 20, 1])),
  };
  const delta = await model.export({
    ...executor,
    baseModelRevision: 0,
    changedElements: [changed],
    exportGeneration: 2,
    modelRevision: 1,
    type: "export-incremental",
  });
  if (!delta.ok) throw new Error(delta.code);
  changed.points[0] = 12;
  const next = {
    ...input,
    revision: 1,
    elements: [
      { ...changed, points: adoptTransferredStrokeSamples(new Float64Array(changed.points)) },
    ],
  };
  const recovered = await fullExport(model, next);
  const fresh = await fullExport(new DocumentModelRuntime(), next);
  expect(recovered.hash).not.toBe(delta.hash);
  expect(recovered.hash).toBe(fresh.hash);
  model.clear();
});

it("keeps validated public resets conservative despite valid sample derivations", async () => {
  const serializer = new IncrementalDocumentSerializer();
  const input = mutableRuntimeSnapshot();
  const reset = () => {
    const validation = validateRuntimeInkSnapshotV1(input);
    if (!validation.ok) throw new Error(validation.error.code);
    expect(serializer.resetValidatedRuntime(input, validation.derivations).ok).toBe(true);
    const current = serializer.currentSnapshot()!.elements[0]!;
    const source = input.elements[0]!;
    expect(current.kind === "stroke" && current.points).not.toBe(
      source.kind === "stroke" && source.points,
    );
  };
  reset();
  const before = await serializer.serializeRuntimeChunked({});
  const stroke = input.elements[0]!;
  if (stroke.kind !== "stroke") throw new Error("Missing stroke.");
  stroke.points[0] = 11;
  reset();
  const after = await serializer.serializeRuntimeChunked({});
  if (!before.ok || !after.ok) throw new Error("Serialization failed.");
  expect(after.value.hash).not.toBe(before.value.hash);
  expect(after.value.hash).toBe((await fullExport(new DocumentModelRuntime(), input)).hash);
  serializer.clear();
});

it.each([false, true])(
  "borrows wire buffers only at the production transfer boundary (production: %s)",
  async (production) => {
    const request = {
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: { ...snapshot(), elements: [STROKE] },
      type: "export-full" as const,
    };
    const packed = encodeRuntimeRequest(request);
    const decoded = decodeRuntimeRequest(
      structuredClone(packed.value, { transfer: [...packed.transfer] }),
    );
    if (decoded.type !== "export-full") throw new Error("Missing full request.");
    const source = decoded.snapshot.elements[0]!;
    const points = source.kind === "stroke" && source.points;
    const reset = vi.spyOn(IncrementalDocumentSerializer.prototype, "resetRuntime");
    const slicedReset = vi.spyOn(IncrementalDocumentSerializer.prototype, "resetRuntimeSliced");
    const runtime = production
      ? createProductionDocumentRuntime(executor, { workScheduler: createTestWorkScheduler() })
      : new DocumentWorkerRuntime(executor);
    try {
      expect(await runtime.execute(decoded)).toMatchObject({ type: "export-success" });
      const canonical = (production ? slicedReset.mock.calls : reset.mock.calls)[0]![0]
        .elements[0]!;
      if (canonical.kind !== "stroke") throw new Error("Missing runtime stroke.");
      if (production) expect(canonical.points).toBe(points);
      else expect(canonical.points).not.toBe(points);
    } finally {
      reset.mockRestore();
      slicedReset.mockRestore();
      runtime.terminate();
    }
  },
);

it("borrows exclusively owned immutable store samples in the fallback", async () => {
  const { stroke, points } = await hydrateRuntimeStroke(STROKE);
  const runtime = new DocumentWorkerRuntime(executor);
  const reset = vi.spyOn(IncrementalDocumentSerializer.prototype, "resetRuntime");
  try {
    expect(
      await runtime.execute({
        ...executor,
        baseModelRevision: null,
        exportGeneration: 1,
        modelRevision: 0,
        snapshot: { ...snapshot(), elements: [stroke] },
        type: "export-full",
      }),
    ).toMatchObject({ type: "export-success" });
    const canonical = reset.mock.calls[0]![0].elements[0]!;
    expect(canonical.kind === "stroke" && canonical.points).toBe(points);
  } finally {
    reset.mockRestore();
    runtime.terminate();
  }
});
