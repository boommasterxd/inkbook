import { expect, it } from "vitest";

import { WORKER_ADMISSION_BYTES } from "../../../src/workers/scheduler/protocol";
import {
  ByteWorkerScheduler,
  type StructuredWorkerWork,
} from "../../../src/workers/scheduler/scheduler";
import type { WorkerFallbackProcessor } from "../../../src/workers/scheduler/scheduler-types";
import { ManualSlices } from "./support";

const REVISION = { scene: 1, layout: 1 };

function work(inputBytes: number): StructuredWorkerWork<number> {
  return {
    kind: "persistence-encode",
    payload: { wireVersion: 1 },
    inputBytes,
    revision: REVISION,
    priority: "background",
    mode: "idle",
    maxOutputBytes: inputBytes,
    scratchBytes: 0,
    createFallbackProcessor: (): WorkerFallbackProcessor<number> => ({
      processNext: (): boolean => true,
      complete: (): number => inputBytes,
    }),
    normalizeResult: (value): number => Number(value),
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
    maxOutstandingBytes: WORKER_ADMISSION_BYTES,
  });
  const submission = scheduler.submitStructured(work(WORKER_ADMISSION_BYTES));
  slices.flushAll();

  await expect(submission.result).resolves.toBe(WORKER_ADMISSION_BYTES);
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
  });
  const submission = scheduler.submitStructured(work(1));

  await expect(submission.result).rejects.toBe(failure);
  scheduler.dispose();
});
