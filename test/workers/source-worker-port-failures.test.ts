/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact worker and source-map boundaries are intentional. */
import { describe, expect, it, vi } from "vitest";

import { validateAndNormalizeSourceMapCompositionRequestV1 } from "../../src/application/source-coordination/map-composition-fallback";
import type { NormalizedSourceMapCompositionRequestV1 } from "../../src/application/source-coordination/work-ports";
import {
  WORKER_PROTOCOL_VERSION,
  type ByteWorkerRequest,
  type WorkerRevision,
} from "../../src/workers/scheduler/protocol";
import type { LaunchedBrowserWorker } from "../../src/workers/scheduler/browser-worker-adapter";
import { ByteWorkerScheduler } from "../../src/workers/scheduler/scheduler";
import { SchedulerSourceDigestWorkPortV1 } from "../../src/workers/source-digest-port";
import { SchedulerSourceMapWorkPortV1 } from "../../src/workers/source-map-port";
import { ManualSlices } from "./scheduler/support";

const REVISION: WorkerRevision = Object.freeze({ scene: 2, layout: 3 });

class ControlledWorker extends EventTarget {
  readonly posted: ByteWorkerRequest[] = [];
  terminate = vi.fn<() => void>();

  postMessage(message: ByteWorkerRequest): void {
    this.posted.push(message);
  }

  respond(requestId: number, payload: unknown, byteLength = 32): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "structured-complete",
          requestId,
          revision: REVISION,
          byteLength,
          payload,
        },
      }),
    );
  }

  acknowledgeCancellation(requestId: number): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "cancelled",
          requestId,
        },
      }),
    );
  }
}

interface Harness {
  readonly scheduler: ByteWorkerScheduler;
  readonly slices: ManualSlices;
  readonly worker: ControlledWorker;
}

function harness(workerAvailable = true): Harness {
  const worker = new ControlledWorker();
  const slices = new ManualSlices();
  return {
    worker,
    slices,
    scheduler: new ByteWorkerScheduler({
      launchWorker: (): LaunchedBrowserWorker | undefined =>
        workerAvailable
          ? ({
              worker,
              dispose: (): void => worker.terminate(),
            } as unknown as LaunchedBrowserWorker)
          : undefined,
      clock: { now: (): number => 0 },
      slices,
      isCurrent: (): boolean => true,
      processFallbackByte: (value): number => value,
      maxOutstandingBytes: 16_777_216,
      maxReservedBytes: 67_108_864,
    }),
  };
}

async function flushMicrotasks(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function accepted(): unknown {
  return { wireVersion: 1, kind: "digest-accepted" };
}

function largeMapRequest(): NormalizedSourceMapCompositionRequestV1 {
  const spans = Array.from({ length: 8_000 }, (_, index) => ({
    oldFromUtf16: index * 2,
    oldToUtf16: index * 2,
    newFromUtf16: index * 3,
    newToUtf16: index * 3 + 1,
  }));
  const normalized = validateAndNormalizeSourceMapCompositionRequestV1({
    wireVersion: 1,
    priorUtf16Length: 16_000,
    replacementUtf16Length: 24_000,
    scratchByteLimit: 8_388_608,
    segments: [
      {
        priorUtf16Length: 16_000,
        replacementUtf16Length: 24_000,
        offsetMap: { spans },
      },
    ],
  });
  if (!normalized.ok) throw new Error("Expected large normalized map.");
  return normalized.value;
}

function smallMapRequest(
  spanCount = 1,
): NormalizedSourceMapCompositionRequestV1 {
  const spans = Array.from({ length: spanCount }, (_, index) => ({
    oldFromUtf16: index * 2,
    oldToUtf16: index * 2,
    newFromUtf16: index * 3,
    newToUtf16: index * 3 + 1,
  }));
  const normalized = validateAndNormalizeSourceMapCompositionRequestV1({
    wireVersion: 1,
    priorUtf16Length: spanCount * 2,
    replacementUtf16Length: spanCount * 3,
    scratchByteLimit: 8_388_608,
    segments: [
      {
        priorUtf16Length: spanCount * 2,
        replacementUtf16Length: spanCount * 3,
        offsetMap: { spans },
      },
    ],
  });
  if (!normalized.ok) throw new Error("Expected normalized map.");
  return normalized.value;
}

describe("source digest worker port failures", () => {
  it("owns input bytes and rejects updates or closure after input is closed", async () => {
    const test = harness();
    const port = new SchedulerSourceDigestWorkPortV1(
      test.scheduler,
      () => REVISION,
    );
    const submission = port.submit();
    const start = test.worker.posted[0];
    if (start?.kind !== "process-structured")
      throw new Error("Expected start.");
    test.worker.respond(start.requestId, accepted());
    const chunk = new Uint8Array([7]);
    const update = submission.update(chunk);
    chunk[0] = 9;
    await flushMicrotasks();
    const updateRequest = test.worker.posted[1];
    if (updateRequest?.kind !== "process-structured")
      throw new Error("Expected update.");
    expect((updateRequest.payload as { chunk: Uint8Array }).chunk).toEqual(
      new Uint8Array([7]),
    );
    test.worker.respond(updateRequest.requestId, accepted());
    await update;
    submission.closeInput();
    expect(() => submission.closeInput()).toThrow("input is closed");
    expect(() => submission.update(new Uint8Array())).toThrow(
      "input is closed",
    );
    await flushMicrotasks();
    const finish = test.worker.posted[2];
    if (finish?.kind !== "process-structured")
      throw new Error("Expected finish.");
    test.worker.respond(finish.requestId, {
      wireVersion: 1,
      kind: "digest-complete",
      result: { ok: true, value: "a".repeat(64) },
    });
    await expect(submission.completion).resolves.toMatchObject({ ok: true });
    test.scheduler.dispose();
  });

  it("rejects oversized chunks and keeps cancellation idempotent", async () => {
    const test = harness();
    const port = new SchedulerSourceDigestWorkPortV1(
      test.scheduler,
      () => REVISION,
    );
    const oversized = port.submit();
    expect(() => oversized.update(new Uint8Array(262_145))).toThrow(RangeError);
    oversized.cancel();
    oversized.cancel();
    expect(() => oversized.update(new Uint8Array())).toThrow("input is closed");
    expect(() => oversized.closeInput()).toThrow("input is closed");
    await expect(oversized.completion).rejects.toMatchObject({
      name: "AbortError",
    });
    test.scheduler.dispose();
  });

  it.each([
    null,
    { wireVersion: 2, kind: "digest-accepted" },
    { wireVersion: 1, kind: "unknown" },
    { wireVersion: 1, kind: "digest-complete", result: { ok: false } },
  ])(
    "fails closed for malformed worker digest response %#",
    async (response) => {
      const test = harness();
      const submission = new SchedulerSourceDigestWorkPortV1(
        test.scheduler,
        () => REVISION,
      ).submit();
      submission.closeInput();
      const request = test.worker.posted[0];
      if (request?.kind !== "process-structured")
        throw new Error("Expected request.");
      test.worker.respond(request.requestId, response);
      await expect(submission.completion).rejects.toBeInstanceOf(Error);
      test.scheduler.dispose();
    },
  );
});

describe("source digest worker completion and fallback", () => {
  it("rejects an accepted finish that does not publish a digest", async () => {
    const test = harness();
    const submission = new SchedulerSourceDigestWorkPortV1(
      test.scheduler,
      () => REVISION,
    ).submit();
    submission.closeInput();
    const start = test.worker.posted[0];
    if (start?.kind !== "process-structured")
      throw new Error("Expected start.");
    test.worker.respond(start.requestId, accepted());
    await flushMicrotasks();
    const finish = test.worker.posted[1];
    if (finish?.kind !== "process-structured")
      throw new Error("Expected finish.");
    test.worker.respond(finish.requestId, accepted());
    await expect(submission.completion).rejects.toThrow("without a digest");
    test.scheduler.dispose();
  });

  it("processes a multi-slice digest fallback and cancels after scheduler disposal", async () => {
    const fallback = harness(false);
    const submission = new SchedulerSourceDigestWorkPortV1(
      fallback.scheduler,
      () => REVISION,
    ).submit();
    const update = submission.update(new Uint8Array(20_000));
    submission.closeInput();
    for (let turn = 0; turn < 12; turn += 1) {
      fallback.slices.flushAll();
      await Promise.resolve();
    }
    await update;
    await expect(submission.completion).resolves.toMatchObject({ ok: true });
    fallback.scheduler.dispose();

    const disposed = harness();
    const cancelled = new SchedulerSourceDigestWorkPortV1(
      disposed.scheduler,
      () => REVISION,
    ).submit();
    disposed.scheduler.dispose();
    cancelled.cancel();
    await expect(cancelled.completion).rejects.toBeInstanceOf(Error);
  });
});

describe("source map worker port failures", () => {
  it("rejects invalid requests and resumes multi-unit fallback work", async () => {
    const invalid = harness(false);
    const port = new SchedulerSourceMapWorkPortV1(
      invalid.scheduler,
      "source-map-compose",
      () => REVISION,
    );
    expect(() =>
      port.submit({} as NormalizedSourceMapCompositionRequestV1),
    ).toThrow(TypeError);
    invalid.scheduler.dispose();

    const fallback = harness(false);
    const submission = new SchedulerSourceMapWorkPortV1(
      fallback.scheduler,
      "source-map-compose",
      () => REVISION,
    ).submit(smallMapRequest(10));
    fallback.slices.flushOne();
    expect(fallback.slices.modes).toContain("idle");
    fallback.slices.flushAll();
    await expect(submission.completion).resolves.toMatchObject({ ok: true });
    fallback.scheduler.dispose();
  });

  it.each([
    null,
    { ok: true, value: { spans: [{ invalid: true }] } },
    { ok: "true", value: {} },
    { ok: false, code: "unknown" },
  ])("fails closed for malformed source-map response %#", async (response) => {
    const test = harness();
    const submission = new SchedulerSourceMapWorkPortV1(
      test.scheduler,
      "source-map-compact",
      () => REVISION,
    ).submit(largeMapRequest());
    const request = test.worker.posted[0];
    if (request?.kind !== "process-structured")
      throw new Error("Expected map request.");
    test.worker.respond(request.requestId, response, 0);
    await expect(submission.completion).rejects.toBeInstanceOf(Error);
    test.scheduler.dispose();
  });

  it("accepts a closed command failure and forwards cancellation", async () => {
    const test = harness();
    const port = new SchedulerSourceMapWorkPortV1(
      test.scheduler,
      "source-map-compact",
      () => REVISION,
    );
    const failed = port.submit(largeMapRequest());
    const first = test.worker.posted[0];
    if (first?.kind !== "process-structured")
      throw new Error("Expected request.");
    test.worker.respond(
      first.requestId,
      { ok: false, code: "stale-source" },
      0,
    );
    await expect(failed.completion).resolves.toEqual({
      ok: false,
      code: "stale-source",
    });

    const cancelled = port.submit(largeMapRequest());
    const cancelRequest = test.worker.posted.at(-1);
    if (cancelRequest?.kind !== "process-structured") {
      throw new Error("Expected cancellable request.");
    }
    cancelled.cancel();
    test.worker.acknowledgeCancellation(cancelRequest.requestId);
    await expect(cancelled.completion).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(test.worker.posted.at(-1)?.kind).toBe("cancel");
    test.scheduler.dispose();
  });
});
