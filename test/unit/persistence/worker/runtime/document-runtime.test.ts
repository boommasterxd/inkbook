import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import { describe, expect, it } from "vitest";

import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import {
  CURRENT_METADATA_REWRITES,
  rewriteDocumentMetadata,
} from "../../../../fixtures/persistence/metadata-rewrite";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../src/persistence/worker/runtime/public";
import { createProductionDocumentRuntime } from "../../../../../src/persistence/worker/runtime/production-document-runtime";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/document-model";
import {
  executor,
  expectClipboardEncodeSuccess,
  rectangle,
  rectangleDocument,
  snapshot,
  unlockedRuntime,
  unlockIdentity,
} from "./fixtures";

describe("document worker runtime", () => {
  it.each(CURRENT_METADATA_REWRITES)(
    "rejects noncanonical or unbound metadata in the production load as $expectedCode",
    async ({ expectedCode, mutate, updateHash }) => {
      const serialized = serializeInkbookDocument(snapshot());
      if (!serialized.ok) throw new Error(serialized.error.code);
      const runtime = createProductionDocumentRuntime(executor, {
        yieldControl: () => Promise.resolve(),
      });

      await expect(
        runtime.execute({
          identity: unlockIdentity,
          input: rewriteDocumentMetadata(serialized.value.svg, mutate, updateHash),
          type: "unlock",
        }),
      ).resolves.toMatchObject({ code: expectedCode, type: "runtime-failure" });
    },
  );

  it("publishes validated unlock data in bounded ordered batches before the terminal header", async () => {
    const document = rectangleDocument(257);
    const serialized = serializeInkbookDocument(document);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime(executor);
    const batches: (readonly string[])[] = [];
    const result = await runtime.execute(
      { identity: unlockIdentity, input: serialized.value.svg, type: "unlock" },
      {
        unlockBatch: async (batch) => {
          await Promise.resolve();
          batches.push(batch.elements.map(({ id }) => id));
        },
      },
    );

    expect(batches.map(({ length }) => length)).toEqual([256, 1]);
    expect(batches.flat()).toEqual(document.elements.map(({ id }) => id));
    expect(result).toMatchObject({
      snapshot: { batchCount: 2, elementCount: 257, revision: 0 },
      type: "unlock-success",
    });
  });

  it("stages validated batches early but rejects a later static-integrity failure", async () => {
    const serialized = serializeInkbookDocument(rectangleDocument(257));
    if (!serialized.ok) throw new Error(serialized.error.code);
    const malformed = serialized.value.svg.replace("</g></svg>", "<script/></g></svg>");
    const runtime = new DocumentWorkerRuntime(executor);
    const batches: number[] = [];

    const result = await runtime.execute(
      { identity: unlockIdentity, input: malformed, type: "unlock" },
      {
        unlockBatch: (batch) => {
          batches.push(batch.batchIndex);
        },
      },
    );

    expect(batches).toEqual([0, 1]);
    expect(result).toMatchObject({ code: "invalid-svg", type: "runtime-failure" });
    expect(runtime.instrumentation).toMatchObject({ cacheElements: 0 });
  });
});

describe("document worker model operations", () => {
  it("releases the model and fragment cache when cleared", () => {
    const model = new DocumentModelRuntime();
    model.initialize(snapshot());
    expect(model.modelRevision).toBe(0);

    model.clear();

    expect(model.modelRevision).toBeNull();
    expect(() => model.encodeClipboard(0, [rectangle().id])).toThrow("basis-revision-mismatch");
  });

  it("applies incremental model state atomically and exports complete SVG output", async () => {
    const runtime = await unlockedRuntime();
    const result = await runtime.execute({
      ...executor,
      baseModelRevision: 0,
      changedElements: [rectangle(180)],
      exportGeneration: 1,
      modelRevision: 1,
      type: "export-incremental",
    });

    expect(result.type).toBe("export-success");
    if (result.type !== "export-success") return;
    const parsed = await parseInkbookDocumentForTest(decodeOutput(result.output));
    expect(parsed.ok && parsed.value.snapshot).toMatchObject({
      revision: 1,
      elements: [{ id: rectangle().id, x: 180 }],
    });

    const zeroDelta = await runtime.execute({
      ...executor,
      baseModelRevision: 1,
      exportGeneration: 2,
      modelRevision: 1,
      type: "export-incremental",
    });
    expect(zeroDelta).toMatchObject({ modelRevision: 1, type: "export-success" });
    expect(runtime.instrumentation).toMatchObject({
      retainedCompleteOutputBytes: 0,
      unacknowledgedExports: 1,
    });
    runtime.acknowledgeExport({ ...executor, exportGeneration: 1, modelRevision: 1 }, false);
    expect(runtime.instrumentation.unacknowledgedExports).toBe(1);
    runtime.acknowledgeExport({ ...executor, exportGeneration: 2, modelRevision: 1 }, true);
    expect(runtime.instrumentation.unacknowledgedExports).toBe(0);
  });

  it("rejects invalid order without advancing the worker baseline", async () => {
    const runtime = await unlockedRuntime();
    const invalid = await runtime.execute({
      ...executor,
      baseModelRevision: 0,
      exportGeneration: 1,
      modelRevision: 1,
      orderChanges: { content: [] },
      type: "export-incremental",
    });
    expect(invalid).toMatchObject({ error: { code: "invalid-order" }, type: "export-failure" });

    const valid = await runtime.execute({
      ...executor,
      baseModelRevision: 0,
      changedElements: [rectangle(140)],
      exportGeneration: 2,
      modelRevision: 1,
      type: "export-incremental",
    });
    expect(valid.type).toBe("export-success");
  });
});

describe("document worker model synchronization", () => {
  it("prewarms the serializer cache without a duplicate fragment cache and clears counters", async () => {
    const model = new DocumentModelRuntime();
    model.initialize(snapshot());
    expect(model.instrumentation).toMatchObject({
      cacheElements: 0,
      fragmentBuilds: 0,
      prewarmedBytes: 0,
      prewarmedElements: 0,
    });

    await model.prewarmOne({
      checkpoint: async () => undefined,
      signal: new AbortController().signal,
    });
    expect(model.instrumentation).toMatchObject({
      cacheElements: 1,
      fragmentBuilds: 1,
      prewarmedElements: 1,
    });
    model.synchronize({
      baseModelRevision: 0,
      changedElements: [rectangle(180)],
      identity: { ...executor, operationId: 2, purpose: "clipboard" },
      modelRevision: 1,
      type: "model-sync-incremental",
    });
    expect(model.instrumentation).toMatchObject({
      cacheElements: 1,
      prewarmedBytes: 0,
      prewarmedElements: 0,
    });

    model.clear();
    expect(model.instrumentation).toMatchObject({ cacheElements: 0, prewarmedElements: 0 });
  });

  it("synchronizes clipboard state without output and supports a later zero-delta export", async () => {
    const runtime = await unlockedRuntime();
    const identity = { ...executor, operationId: 2, purpose: "clipboard" as const };

    await expect(
      runtime.execute({
        baseModelRevision: 0,
        changedElements: [rectangle(220)],
        identity,
        modelRevision: 1,
        type: "model-sync-incremental",
      }),
    ).resolves.toEqual({ identity, modelRevision: 1, type: "model-sync-success" });
    await expectClipboardEncodeSuccess(runtime, 1);

    const exported = await runtime.execute({
      ...executor,
      baseModelRevision: 1,
      exportGeneration: 1,
      modelRevision: 1,
      type: "export-incremental",
    });
    expect(exported.type).toBe("export-success");
    if (exported.type !== "export-success") return;
    expect(await parseInkbookDocumentForTest(decodeOutput(exported.output))).toMatchObject({
      ok: true,
      value: { snapshot: { elements: [{ x: 220 }], revision: 1 } },
    });
  });

  it("keeps the prior model after a rejected synchronization delta", async () => {
    const runtime = await unlockedRuntime();
    const identity = { ...executor, operationId: 2, purpose: "clipboard" as const };
    await expect(
      runtime.execute({
        baseModelRevision: 9,
        changedElements: [rectangle(220)],
        identity,
        modelRevision: 1,
        type: "model-sync-incremental",
      }),
    ).resolves.toMatchObject({ code: "base-revision-mismatch", type: "runtime-failure" });

    await expectClipboardEncodeSuccess(runtime, 0);
  });
});

function decodeOutput(output: string | Uint8Array): string {
  if (typeof output === "string") return output;
  return new TextDecoder().decode(output);
}

describe("document worker request identity", () => {
  it("rejects stale executors and clipboard basis revisions", async () => {
    const runtime = await unlockedRuntime();
    await expect(
      runtime.execute({
        identity: { ...unlockIdentity, workerEpoch: 2 },
        input: "invalid",
        type: "verify-output",
      }),
    ).resolves.toMatchObject({ code: "stale-executor", type: "runtime-failure" });

    await expect(
      runtime.execute({
        basisRevision: 1,
        identity: { ...executor, operationId: 1, purpose: "clipboard" },
        selectedIds: [rectangle().id],
        type: "clipboard-encode",
      }),
    ).resolves.toMatchObject({ code: "basis-revision-mismatch", type: "runtime-failure" });
  });
});

describe("document worker clipboard planning", () => {
  it("plans a paste from the worker baseline with injected UUID generation", async () => {
    const serialized = serializeInkbookDocument(snapshot());
    if (!serialized.ok) throw new Error(serialized.error.code);
    const pastedId = "00000000-0000-4000-8000-000000000099";
    const runtime = new DocumentWorkerRuntime(executor, null, { createId: () => pastedId });
    await runtime.execute({
      identity: unlockIdentity,
      input: serialized.value.svg,
      type: "unlock",
    });
    const encoded = await runtime.execute({
      basisRevision: 0,
      identity: { ...unlockIdentity, purpose: "clipboard" },
      selectedIds: [rectangle().id],
      type: "clipboard-encode",
    });
    if (encoded.type !== "clipboard-encode-success" || !encoded.result.ok) {
      throw new Error("Clipboard encoding failed.");
    }

    const result = await runtime.execute({
      basisRevision: 0,
      candidates: { customText: encoded.result.value.customText },
      commandTimestamp: 50,
      identity: { ...unlockIdentity, operationId: 2, purpose: "clipboard" },
      invocation: { kind: "toolbar", visibleCanvasCenter: { x: 500, y: 500 } },
      type: "clipboard-plan-paste",
    });

    expect(result).toMatchObject({
      result: { ok: true, value: { elements: [{ createdAt: 50, id: pastedId }] } },
      type: "clipboard-plan-paste-success",
    });
  });
});

describe("document worker fallback clipboard codec", () => {
  it.each([
    [60, (1_000 / 60) * 0.55, 16 * 1024, 256, 64 * 1024],
    [90, (1_000 / 90) * 0.55, 12 * 1024, 192, 48 * 1024],
    [120, (1_000 / 120) * 0.55, 8 * 1024, 128, 32 * 1024],
    [144, (1_000 / 144) * 0.55, 6 * 1024, 96, 24 * 1024],
    [240, (1_000 / 240) * 0.55, 4 * 1024, 64, 16 * 1024],
  ])(
    "selects bounded fallback work units for %i Hz",
    (_rate, sliceMilliseconds, inputByteLimit, nodeLimit, outputByteLimit) => {
      const scheduler = new GestureAwareSliceScheduler({
        isInputActive: () => false,
        sliceMilliseconds,
        yieldControl: () => Promise.resolve(),
      });

      expect(scheduler.getSliceWorkProfile()).toEqual({
        inputByteLimit,
        nodeLimit,
        outputByteLimit,
      });
    },
  );

  it("uses sliced clipboard codecs without changing their canonical output", async () => {
    const model = new DocumentModelRuntime();
    const document = rectangleDocument(257);
    model.initialize(document);
    let checkpoints = 0;
    const context = {
      checkpoint: async () => {
        checkpoints += 1;
      },
      signal: new AbortController().signal,
    };

    const sliced = await model.encodeClipboardSliced(
      0,
      document.elements.map(({ id }) => id),
      context,
    );
    const synchronous = model.encodeClipboard(
      0,
      document.elements.map(({ id }) => id),
    );

    expect(sliced).toEqual(synchronous);
    expect(checkpoints).toBeGreaterThan(0);
  });
});

describe("production document worker scheduling", () => {
  it("slices production-worker export assembly and hashing", async () => {
    let now = 0;
    let yields = 0;
    const runtime = createProductionDocumentRuntime(executor, {
      now: () => (now += 9),
      yieldControl: async () => {
        yields += 1;
      },
    });

    const document = rectangleDocument(257);
    const canonical = serializeInkbookDocument(document);
    if (!canonical.ok) throw new Error(canonical.error.code);
    const result = await runtime.execute({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: document,
      type: "export-full",
    });

    expect(result.type).toBe("export-success");
    if (result.type !== "export-success") return;
    expect(result.output).toBeInstanceOf(Uint8Array);
    expect(decodeOutput(result.output)).toBe(canonical.value.svg);
    expect(result.outputHash).toBe(canonical.value.hash);
    expect(runtime.instrumentation).toMatchObject({
      retainedCompleteOutputBytes: 0,
      unacknowledgedExports: 1,
    });
    expect(yields).toBeGreaterThan(0);
    runtime.acknowledgeExport(result, true);
    runtime.terminate();
  });
});

describe("document worker fallback scheduling", () => {
  it("pauses fallback work while a live gesture is active", async () => {
    let active = true;
    let now = 0;
    let yields = 0;
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => active,
      now: () => (now += 9),
      yieldControl: async () => {
        yields += 1;
        active = false;
      },
    });
    const runtime = new DocumentWorkerRuntime(executor, scheduler);
    const result = await runtime.execute({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: snapshot(),
      type: "export-full",
    });

    expect(result.type).toBe("export-success");
    expect(yields).toBeGreaterThanOrEqual(2);
  });

  it("aborts a running fallback checkpoint and releases its pending job", async () => {
    let releaseYield = (): void => undefined;
    let now = 0;
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => false,
      now: () => (now += 9),
      yieldControl: () =>
        new Promise<void>((resolve) => {
          releaseYield = resolve;
        }),
    });
    const runtime = new DocumentWorkerRuntime(executor, scheduler);
    const pending = runtime.execute({
      ...executor,
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      snapshot: snapshot(),
      type: "export-full",
    });

    runtime.terminate();
    releaseYield();

    await expect(pending).rejects.toThrow("terminated");
  });

  it("cancels chunked fallback parsing before any unlock batch is published", async () => {
    const serialized = serializeInkbookDocument(rectangleDocument(257));
    if (!serialized.ok) throw new Error(serialized.error.code);
    let runtime: DocumentWorkerRuntime;
    let now = 0;
    let yields = 0;
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => false,
      now: () => (now += 9),
      yieldControl: async () => {
        yields += 1;
        if (yields === 3) runtime.terminate();
      },
    });
    runtime = new DocumentWorkerRuntime(executor, scheduler);
    const batches: number[] = [];
    const pending = runtime.execute(
      {
        identity: unlockIdentity,
        input: new TextEncoder().encode(serialized.value.svg),
        type: "unlock",
      },
      {
        unlockBatch: (batch) => {
          batches.push(batch.batchIndex);
        },
      },
    );

    await expect(pending).rejects.toThrow("terminated");
    expect(batches).toEqual([]);
    expect(yields).toBe(3);
  });
});
