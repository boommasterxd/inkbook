import { describe, expect, it } from "vitest";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../../../src/persistence/worker/runtime/public";
import { createTestWorkScheduler } from "../../../../../fixtures/persistence/work-scheduler";
import { serializeOneStrokeWorkerSnapshot } from "../../../../../fixtures/persistence/worker-bridge";

const identity = {
  sessionId: "export",
  workerEpoch: 1,
  operationId: 1,
  purpose: "preflight" as const,
};

describe("stateless worker export geometry", () => {
  it("returns compact bounds without activating a document model or retaining its samples", async () => {
    const runtime = new DocumentWorkerRuntime(identity);
    try {
      const result = await runtime.execute({
        type: "prepare-export-geometry",
        identity,
        input: serializeOneStrokeWorkerSnapshot().svg,
      });
      expect(result).toEqual({
        identity,
        intervals: [{ minY: 9, maxY: 21 }],
        type: "prepare-export-geometry-success",
      });
      expect(runtime.instrumentation).toMatchObject({
        cacheElements: 0,
        retainedJobs: 0,
        queuedJobs: 0,
        unacknowledgedExports: 0,
      });
    } finally {
      runtime.terminate();
    }
  });

  it("reports unusable metadata as a normal static fallback without retaining a model", async () => {
    const runtime = new DocumentWorkerRuntime(identity);
    try {
      const result = await runtime.execute({
        type: "prepare-export-geometry",
        identity,
        input: "<svg/>",
      });
      expect(result).toEqual({
        identity,
        intervals: undefined,
        type: "prepare-export-geometry-success",
      });
      expect(runtime.instrumentation).toMatchObject({ cacheElements: 0, retainedJobs: 0 });
    } finally {
      runtime.terminate();
    }
  });

  it("rejects terminated preparation while centrally admitted work is suspended", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new GestureAwareSliceScheduler({
      isInputActive: () => false,
      workScheduler: createTestWorkScheduler({ checkpoint: () => gate }),
    });
    const runtime = new DocumentWorkerRuntime(identity, scheduler);
    const result = runtime.execute({
      type: "prepare-export-geometry",
      identity,
      input: serializeOneStrokeWorkerSnapshot().svg,
    });
    const rejected = expect(result).rejects.toThrow();
    runtime.terminate();
    release();
    await rejected;
    expect(runtime.instrumentation).toMatchObject({
      cacheElements: 0,
      retainedJobs: 0,
      queuedJobs: 0,
    });
  });
});
