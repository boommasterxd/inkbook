import { afterEach, expect, it, vi } from "vitest";

import { adoptUtf8Output } from "../../../src/persistence/scheduling/utf8-adoption";
import { inspectTrustedSvgOutput } from "../../../src/persistence/scheduling/trusted-svg-output";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import { createTestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import { SharedFrameScheduler } from "../../../src/domain/scheduling/shared-frame-scheduler";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";
import { InputActivityGate } from "../../../src/persistence/worker/runtime/input-activity-gate";
import { createMainThreadRequestCheckpoint } from "../../../src/persistence/worker/runtime/slice-scheduler";
import type { DocumentRuntimeRequest } from "../../../src/persistence/worker/runtime/types";

afterEach(() => vi.restoreAllMocks());

const exportRequest = {
  baseModelRevision: 0,
  exportGeneration: 1,
  modelRevision: 1,
  sessionId: "checkpoint",
  type: "export-incremental" as const,
  workerEpoch: 1,
};

it("admits export delivery and scene synchronization while repeated scene frames defer optional work", async () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const controller = new AbortController();
  const options = {
    inputGate: new InputActivityGate(() => false),
    navigationGate: new InputActivityGate(() => false),
    scheduler,
  };
  const identity = {
    operationId: 1,
    purpose: "background" as const,
    sessionId: "checkpoint",
    workerEpoch: 1,
  };
  const complete: string[] = [];
  const continuations: Promise<void>[] = [];
  const enqueue = (request: DocumentRuntimeRequest, name: string) => {
    const checkpoint = createMainThreadRequestCheckpoint(options, controller.signal, request);
    const pending = checkpoint();
    expect(pending).toBeDefined();
    continuations.push(
      pending!.then(
        () => {
          complete.push(name);
          host.time += host.budget;
        },
        () => undefined,
      ),
    );
  };
  let sceneWrites = 0;
  const sceneFrame = () => {
    sceneWrites += 1;
    host.time += host.budget;
    scheduler.requestFrame(sceneFrame);
  };
  scheduler.requestFrame(sceneFrame);
  host.time = scheduler.deadline();
  try {
    enqueue(
      {
        basisRevision: 1,
        identity,
        ids: ["00000000-0000-4000-8000-000000000001"],
        speculative: true,
        type: "prepare-scene-paths",
      },
      "warming",
    );
    enqueue(exportRequest, "export");
    const synchronize = {
      baseModelRevision: 0,
      identity,
      modelRevision: 1,
      type: "model-sync-incremental" as const,
    };
    enqueue(synchronize, "scene-sync");
    enqueue({ ...synchronize, identity: { ...identity, purpose: "clipboard" } }, "clipboard-sync");
    for (let frame = 0; frame < 4; frame += 1) {
      host.time += host.frameInterval;
      host.frame();
      await Promise.resolve();
      while (host.hasTimer(0)) {
        host.timer(0);
        await Promise.resolve();
      }
    }
    expect(complete).toEqual(["export", "scene-sync"]);
    expect(sceneWrites).toBeGreaterThanOrEqual(2);
  } finally {
    controller.abort();
    scheduler.dispose();
    await Promise.all(continuations);
  }
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});

it("rechecks input and navigation that begin while export delivery awaits central admission", async () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const controller = new AbortController();
  let input = false;
  let navigation = false;
  const inputGate = new InputActivityGate(() => input);
  const navigationGate = new InputActivityGate(() => navigation);
  host.time = scheduler.deadline();
  let continued = false;
  const checkpoint = createMainThreadRequestCheckpoint(
    { inputGate, navigationGate, scheduler },
    controller.signal,
    exportRequest,
  );
  const pending = checkpoint()!.then(
    () => {
      continued = true;
    },
    () => undefined,
  );
  try {
    expect(host.pendingFrames).toBe(1);
    input = true;
    navigation = true;
    host.time += host.frameInterval;
    host.frame();
    await Promise.resolve();
    await Promise.resolve();
    expect(continued).toBe(false);
    expect(host.pendingFrames).toBe(0);
    input = false;
    inputGate.notifyInactive();
    await Promise.resolve();
    await Promise.resolve();
    expect(continued).toBe(false);
    navigation = false;
    navigationGate.notifyInactive();
    await pending;
    expect(continued).toBe(true);
  } finally {
    controller.abort();
    scheduler.dispose();
    await pending;
  }
  expect(host.pendingTimers).toBe(0);
});

it("keeps export delivery behind live-input and navigation gates and cancels its frame admission", async () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const controller = new AbortController();
  let input = true;
  let navigation = true;
  const inputGate = new InputActivityGate(() => input);
  const navigationGate = new InputActivityGate(() => navigation);
  host.time = scheduler.deadline();
  const checkpoint = createMainThreadRequestCheckpoint(
    { inputGate, navigationGate, scheduler },
    controller.signal,
    exportRequest,
  );
  const pending = checkpoint();
  expect(host.pendingFrames).toBe(0);
  input = false;
  inputGate.notifyInactive();
  await Promise.resolve();
  expect(host.pendingFrames).toBe(0);
  navigation = false;
  navigationGate.notifyInactive();
  await Promise.resolve();
  await Promise.resolve();
  expect(host.pendingFrames).toBe(1);
  controller.abort(new Error("Cancelled export delivery."));
  await expect(pending).rejects.toThrow("Cancelled export delivery.");
  expect(host.pendingFrames).toBe(0);
  scheduler.dispose();
  expect(host.pendingTimers).toBe(0);
});

function createSliceProbe(initialBudget: number, afterSlice?: (count: number) => void) {
  let now = 0;
  let budget = initialBudget;
  let work = 0;
  const slices: number[] = [];
  const workScheduler = createTestWorkScheduler({
    shouldYield: () => now >= budget,
    checkpoint: async () => {
      if (now < budget) return;
      slices.push(work);
      work = 0;
      now = 0;
      budget = 1;
      afterSlice?.(slices.length);
    },
  });
  return {
    now: () => now,
    observeWork: () => {
      now += 1;
      work += 1;
    },
    slices,
    workScheduler,
  };
}

it("rechecks the live budget between actual hash chunks and preserves abort boundaries", async () => {
  const abort = new AbortController();
  const probe = createSliceProbe(2, (count) => {
    if (count === 3) abort.abort();
  });
  vi.spyOn(performance, "now").mockImplementation(probe.now);
  const update = Object.getOwnPropertyDescriptor(ChunkedSha256.prototype, "update")!
    .value as ChunkedSha256["update"];
  const chunks = vi.spyOn(ChunkedSha256.prototype, "update").mockImplementation(function (
    this: ChunkedSha256,
    bytes,
  ) {
    probe.observeWork();
    return update.call(this, bytes);
  });
  await expect(
    inspectTrustedSvgOutput(new Uint8Array(6 * 64 * 1024), undefined, {
      workScheduler: probe.workScheduler,
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(probe.slices).toEqual([2, 1, 1]);
  expect(chunks).toHaveBeenCalledTimes(4);
  expect(chunks.mock.calls.every(([bytes]) => bytes.byteLength === 64 * 1024)).toBe(true);
});

it("adapts UTF-8 decoding work after the owning display budget changes", async () => {
  const probe = createSliceProbe(3);
  vi.spyOn(performance, "now").mockImplementation(probe.now);
  const decode = Object.getOwnPropertyDescriptor(TextDecoder.prototype, "decode")!
    .value as TextDecoder["decode"];
  const chunks = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
    this: TextDecoder,
    bytes,
    options,
  ) {
    if (bytes !== undefined && bytes.byteLength > 0) probe.observeWork();
    return decode.call(this, bytes, options);
  });
  await expect(
    adoptUtf8Output(new TextEncoder().encode("abcdefgh"), {
      chunkBytes: 2,
      workScheduler: probe.workScheduler,
    }),
  ).resolves.toBe("abcdefgh");
  expect(probe.slices).toEqual([3, 1]);
  expect(chunks.mock.calls.filter(([bytes]) => bytes !== undefined)).toHaveLength(4);
});
