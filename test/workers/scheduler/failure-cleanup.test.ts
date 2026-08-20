import { expect, it } from "vitest";

import { WORKER_ADMISSION_BYTES } from "../../../src/workers/scheduler/protocol";
import {
  ByteWorkerScheduler,
  type WorkerFallbackProcessor,
  type WorkerFallbackWork,
} from "../../../src/workers/scheduler/scheduler";
import { ManualSlices } from "./support";

const REVISION = { scene: 1, layout: 1 };

function copyingProcessor(work: WorkerFallbackWork): WorkerFallbackProcessor {
  return {
    processNext: (): boolean => true,
    complete: (): Uint8Array<ArrayBuffer> => new Uint8Array(work.input),
  };
}

it("uses fallback when the lazy worker launcher throws", async () => {
  const slices = new ManualSlices();
  const scheduler = new ByteWorkerScheduler({
    launchWorker: (): never => {
      throw new Error("worker launch failed");
    },
    clock: { now: (): number => 0 },
    slices,
    isCurrent: (): boolean => true,
    processFallbackByte: (value): number => value,
    createFallbackProcessor: copyingProcessor,
    maxOutstandingBytes: WORKER_ADMISSION_BYTES,
  });
  const submission = scheduler.submitWork({
    kind: "persistence-encode",
    input: new Uint8Array(WORKER_ADMISSION_BYTES),
    revision: REVISION,
    priority: "background",
    mode: "idle",
    maxOutputBytes: WORKER_ADMISSION_BYTES,
    scratchBytes: 0,
  });
  slices.flushAll();

  await expect(submission.result).resolves.toHaveLength(WORKER_ADMISSION_BYTES);
  scheduler.dispose();
});

it("rejects and releases fallback work when slice scheduling throws", async () => {
  const failure = new Error("slice scheduling failed");
  const scheduler = new ByteWorkerScheduler({
    launchWorker: (): undefined => undefined,
    clock: { now: (): number => 0 },
    slices: {
      schedule: (): never => {
        throw failure;
      },
    },
    isCurrent: (): boolean => true,
    processFallbackByte: (value): number => value,
  });
  const submission = scheduler.submit(
    new Uint8Array([1]),
    REVISION,
    "current",
    "active",
  );

  await expect(submission.result).rejects.toBe(failure);
  scheduler.dispose();
});
