import { expect, it, vi } from "vitest";
import { RemoteScenePaths } from "../../../../src/rendering/scene/remote-scene-paths";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import type {
  PreparedScenePathEntry,
  ScenePathPreparationObserver,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  MAX_PREPARED_SCENE_PATH_BYTES,
  preparedScenePathBytes,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { SceneEntrantPriority } from "../../../../src/rendering/scene/scene-entrant-priority";
import { MountSlice } from "../../../../src/rendering/scene/mount-slice";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { upcomingScenePathIds } from "../../../../src/rendering/scene/upcoming-scene-paths";
import type { PendingReconciliation } from "../../../../src/rendering/scene/reconciliation-state";
import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

it("reads complete progress while the operation waits and retargets only retained geometry", async () => {
  const records = ["first", "second", "third", "fourth"].map(record);
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  let observer!: ScenePathPreparationObserver;
  let finish!: (paths: readonly PreparedScenePathEntry[]) => void;
  let signal!: AbortSignal;
  const retarget = vi.fn();
  const prepared = vi.fn();
  const wake = vi.fn();
  const remote = new RemoteScenePaths(
    {
      get: (id) => indexed.get(id),
      query: () => undefined,
      prepareScenePaths: (ids, cancellation, progress) => {
        signal = cancellation;
        observer = progress!;
        observer.setRetarget(retarget);
        return new Promise((resolve) => {
          finish = resolve;
          expect(ids.length).toBeLessThanOrEqual(256);
        });
      },
    },
    { onPrepared: prepared, onReady: wake },
  );
  expect(remote.read(records[0]!, () => [])).toBe("pending");
  finish(paths("first"));
  await Promise.resolve();
  expect(remote.read(records[0]!, () => [])).toEqual(paths("first")[0]!.parts);
  expect(remote.read(records[1]!, () => ["third", "fourth"])).toBe("pending");
  observer.onProgress(paths("second", "third"));
  expect(remote.waiting).toBe(true);
  expect(remote.readyCount).toBe(2);
  expect(remote.read(records[1]!, () => [])).toEqual(paths("second")[0]!.parts);
  expect(remote.readyCount).toBe(1);
  remote.cancel((id) => id === "third");
  expect(retarget).toHaveBeenLastCalledWith(["third"]);
  expect(signal.aborted).toBe(false);
  observer.onProgress(paths("fourth"));
  expect(prepared).toHaveBeenCalledTimes(3);
  expect(remote.read(records[2]!, () => [])).toEqual(paths("third")[0]!.parts);
  remote.cancel();
  expect(signal.aborted).toBe(true);
  expect(remote.readyCount).toBe(0);
  expect(remote.memoryUsage()).toBe(0);
  finish(paths("second", "third", "fourth"));
  await Promise.resolve();
  expect(prepared).toHaveBeenCalledTimes(3);
  expect(wake).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "keeps lookahead readiness from valid progress after a shrinking retarget, ready=%s",
  async (ready) => {
    const records = ["first", "second", "third", "fourth", "fifth"].map(record);
    const indexed = new Map(records.map((entry) => [entry.id, entry]));
    let observer!: ScenePathPreparationObserver;
    let finish!: (value: readonly PreparedScenePathEntry[]) => void;
    const requests: string[][] = [];
    const retarget = vi.fn();
    const remote = new RemoteScenePaths({
      get: (id) => indexed.get(id),
      query: () => undefined,
      prepareScenePaths: (ids, _signal, progress) => {
        requests.push([...ids]);
        observer = progress!;
        observer.setRetarget(retarget);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    remote.read(records[0]!, () => []);
    remote.cancel(() => true);
    finish(paths("first"));
    await Promise.resolve();
    remote.read(records[0]!, () => []);
    remote.read(records[1]!, () => ["third", "fourth"]);
    if (ready) observer.onProgress(paths("third"));
    remote.cancel((id) => id === "third");
    if (!ready) observer.onProgress(paths("third"));
    remote.read(records[2]!, () => []);
    finish([]);
    await Promise.resolve();
    remote.read(records[3]!, () => ["fifth"]);
    expect(requests).toEqual([["first"], ["second", "third", "fourth"], ["fourth", "fifth"]]);
    expect(retarget.mock.calls).toHaveLength(4);
    remote.cancel();
    finish([]);
    await Promise.resolve();
    expect(remote.memoryUsage()).toBe(0);
  },
);

it("resets first-contour readiness when retargeting retains no ready contour", async () => {
  const records = ["first", "second", "third", "fourth"].map(record);
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  const provider = deferredPathRequests(indexed);
  const remote = new RemoteScenePaths(provider.store);
  remote.read(records[0]!, () => []);
  provider.complete(paths("first"));
  await Promise.resolve();
  remote.read(records[0]!, () => []);
  remote.read(records[1]!, () => ["third"]);
  remote.cancel((id) => id === "third");
  provider.complete(paths("second"));
  await Promise.resolve();
  remote.read(records[3]!, () => ["third"]);
  expect(provider.requests).toEqual([["first"], ["second", "third"], ["fourth"]]);
  remote.cancel();
  provider.complete([]);
});

it("immediately removes a failed delivery while retaining another batch's ready contour", async () => {
  const records = ["first", "second", "third"].map(record);
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  const provider = deferredPathRequests(indexed);
  const remote = new RemoteScenePaths(provider.store, {
    onPrepared: (entry) => {
      if (entry.id === "second") throw new Error("Adoption failed.");
    },
  });
  remote.read(records[0]!, () => ["second", "third"]);
  provider.complete(paths("first"));
  await Promise.resolve();
  provider.complete(paths("second", "third"));
  await Promise.resolve();
  await Promise.resolve();
  expect(remote.waiting).toBe(false);
  expect(remote.readyCount).toBe(1);
  expect(remote.read(records[1]!, () => [])).toBeUndefined();
  expect(remote.readyCount).toBe(1);
  expect(remote.read(records[0]!, () => [])).toEqual(paths("first")[0]!.parts);
  expect(remote.readyCount).toBe(0);
  expect(remote.memoryUsage()).toBe(0);
  remote.cancel();
});

it("refills before consumption, orders the exact viewport prefix and shares contour bytes", async () => {
  const records = ["first", "overscan", "visible", "warm"].map(record);
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  const requests: { ids: readonly string[]; observer: ScenePathPreparationObserver }[] = [];
  const signals: AbortSignal[] = [];
  let finish!: (result: readonly PreparedScenePathEntry[]) => void;
  const prepared = vi.fn();
  const remote = new RemoteScenePaths(
    {
      get: (id) => indexed.get(id),
      query: () => undefined,
      prepareScenePaths: (ids, signal, observer) => {
        requests.push({ ids, observer: observer! });
        signals.push(signal);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    {
      isCached: (entry) => entry.id === "warm",
      isViewport: (entry) => entry.id !== "overscan",
      onPrepared: prepared,
    },
  );
  expect(remote.read(records[0]!, () => ["overscan", "visible", "warm"])).toBe("pending");
  const first = { id: "first", parts: [{ d: "M0 0Z".repeat(10_000), paint: "fill" as const }] };
  finish([first]);
  await Promise.resolve();
  expect(requests.map((request) => request.ids)).toEqual([["first"], ["visible", "overscan"]]);
  expect(requests[1]!.observer.visibleCount).toBe(1);
  expect(requests[1]!.observer.maxBytes).toBe(
    MAX_PREPARED_SCENE_PATH_BYTES - preparedScenePathBytes(first.id, first.parts),
  );
  expect(remote.memoryUsage()).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES + 256 * 128);
  remote.cancel();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  requests[1]!.observer.onProgress(paths("visible"));
  finish(paths("visible", "overscan"));
  await Promise.resolve();
  expect(prepared).toHaveBeenCalledTimes(1);
  expect(remote.memoryUsage()).toBe(0);
});

it("refills at half-pool capacity while retaining the prepared publication tail", async () => {
  const records = Array.from({ length: 602 }, (_, index) => record(String(index)));
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  const cached = new Set<string>();
  const provider = deferredPathRequests(indexed);
  const { requests } = provider;
  const remote = new RemoteScenePaths(provider.store, {
    isCached: (entry) => cached.has(entry.id),
    onPrepared: (entry) => {
      cached.add(entry.id);
    },
  });
  const upcoming = () => records.map((entry) => entry.id);
  remote.read(records[0]!, upcoming);
  provider.complete(paths("0"));
  await Promise.resolve();
  expect(requests.map((ids) => ids.length)).toEqual([1, 255]);
  provider.complete(paths(...requests[1]!));
  await Promise.resolve();
  remote.release("0", upcoming);
  for (const id of requests[1]!.slice(0, 126)) remote.release(id, upcoming);
  expect(requests).toHaveLength(2);
  expect(remote.readyCount).toBe(129);
  remote.release(requests[1]![126]!, upcoming);
  expect(requests.map((ids) => ids.length)).toEqual([1, 255, 128]);
  expect(remote.readyCount).toBe(128);
  expect(requests[2]![0]).toBe("256");
  expect(remote.memoryUsage()).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES + 256 * 128);
  for (const id of requests[1]!.slice(127)) remote.release(id, upcoming);
  expect(requests).toHaveLength(3);
  expect(remote.readyCount).toBe(0);
  provider.complete(paths(...requests[2]!));
  await Promise.resolve();
  expect(requests.map((ids) => ids.length)).toEqual([1, 255, 128, 128]);
  expect(remote.readyCount).toBe(128);
  remote.cancel();
  provider.complete([]);
  await Promise.resolve();
  expect(remote.memoryUsage()).toBe(0);
  expect(remote.readyCount).toBe(0);
});

it("resumes cache-heavy collection at shared admission and rejects its cancelled cursor", async () => {
  const records = Array.from({ length: 602 }, (_, index) => record(String(index)));
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  let blocked = false;
  let resume!: () => void;
  const scheduler = new TestWorkScheduler({
    shouldYield: () => blocked,
    checkpoint: () =>
      new Promise((resolve) => {
        resume = resolve;
      }),
  });
  let reads = 0;
  let finish!: (result: readonly PreparedScenePathEntry[]) => void;
  const prepare = vi.fn(
    () =>
      new Promise<readonly PreparedScenePathEntry[]>((resolve) => {
        finish = resolve;
      }),
  );
  const remote = new RemoteScenePaths(
    {
      get: (id) => {
        if (++reads === 12) blocked = true;
        return indexed.get(id);
      },
      query: () => undefined,
      prepareScenePaths: prepare,
    },
    { scheduler, isCached: (entry) => Number(entry.id) > 0 && Number(entry.id) < 601 },
  );
  remote.read(records[0]!, () => records.slice(1).map((entry) => entry.id));
  finish(paths("0"));
  await Promise.resolve();
  expect(reads).toBe(12);
  expect(prepare).toHaveBeenCalledTimes(1);
  remote.cancel((id) => id === "0");
  const cancelledReads = reads;
  blocked = false;
  resume();
  await Promise.resolve();
  expect(reads).toBe(cancelledReads);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(remote.read(records[0]!, () => [])).toEqual(paths("0")[0]!.parts);
  remote.cancel();
  expect(remote.memoryUsage()).toBe(0);
});

it("does no lookahead or executor work for one thousand cached IDs without remote ownership", async () => {
  const first = record("first");
  const get = vi.fn(() => first);
  const prepare = vi.fn(() => Promise.resolve(paths("first")));
  const remote = new RemoteScenePaths({ get, query: () => undefined, prepareScenePaths: prepare });
  remote.read(first, () => []);
  await Promise.resolve();
  expect(remote.read(first, () => [])).toEqual(paths("first")[0]!.parts);
  const reads = get.mock.calls.length;
  const upcoming = vi.fn(() => ["first"]);
  for (let index = 0; index < 1_000; index++) remote.release(`cached-${index}`, upcoming);
  expect(get).toHaveBeenCalledTimes(reads);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(upcoming).not.toHaveBeenCalled();
  remote.cancel();
  expect(remote.memoryUsage()).toBe(0);
});

it("restarts a paused heap frontier after cached mounting and a priority retarget", async () => {
  const records = Array.from({ length: 10 }, (_, index) => ({
    ...record(String(index)),
    rank: index,
  }));
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  const mounted = new Set<string>();
  const cached = new Set(["1", "2", "3", "5"]);
  const requests: string[][] = [];
  let finish!: (result: readonly PreparedScenePathEntry[]) => void;
  let block = false;
  let resume!: () => void;
  const scheduler = new TestWorkScheduler({
    shouldYield: () => block,
    checkpoint: () =>
      new Promise((resolve) => {
        resume = resolve;
      }),
  });
  const store = {
    get: (id: string) => {
      if (id === "1") block = true;
      return indexed.get(id);
    },
    query: () => undefined,
    prepareScenePaths: (ids: readonly string[]) => {
      requests.push([...ids]);
      return new Promise<readonly PreparedScenePathEntry[]>((resolve) => {
        finish = resolve;
      });
    },
  };
  const priority = new SceneEntrantPriority(
    indexed.keys(),
    { ...store, get: (id) => indexed.get(id) },
    mounted,
    createInstrumentation(),
    undefined,
  );
  priority.build(new MountSlice(Infinity, () => 0));
  const pending = {
    delta: { ids: [], index: 0, deferred: [], priority },
    entrants: new Map(),
  } as unknown as PendingReconciliation;
  const remote = new RemoteScenePaths(store, {
    scheduler,
    isCached: (entry) => cached.has(entry.id),
    onPrepared: (entry) => {
      cached.add(entry.id);
    },
  });
  remote.read(records[0]!, () => upcomingScenePathIds(pending, mounted));
  finish(paths("0"));
  await Promise.resolve();
  expect(requests).toEqual([["0"]]);
  for (let index = 0; index < 2; index++) {
    const id = priority.take()!;
    mounted.add(id);
    priority.release(id);
  }
  priority.retarget([], ["6"], undefined);
  priority.build(new MountSlice(Infinity, () => 0));
  block = false;
  resume();
  await Promise.resolve();
  expect(requests).toEqual([["0"], ["4", "7", "8", "9"]]);
  finish(paths("4", "7", "8", "9"));
  await Promise.resolve();
  for (const id of requests[1]!)
    expect(remote.read(indexed.get(id)!, () => [])).toEqual(paths(id)[0]!.parts);
  remote.cancel();
  expect(remote.memoryUsage()).toBe(0);
});

it("admits required collection and adoption alongside a recurring full-budget frame consumer", async () => {
  const records = ["first", "second", "third"].map(record);
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const cached = new Set<string>();
  const requests: string[][] = [];
  let reads = 0;
  let consumerRuns = 0;
  const consume = () => {
    consumerRuns++;
    host.time += host.budget;
    scheduler.requestFrame(consume, "frame");
  };
  scheduler.requestFrame(consume, "frame");
  scheduler.deadline();
  host.time = host.budget;
  const remote = new RemoteScenePaths(
    {
      get: (id) => {
        reads++;
        host.time += host.budget;
        return indexed.get(id);
      },
      query: () => undefined,
      prepareScenePaths: (ids) => {
        requests.push([...ids]);
        return Promise.resolve(paths(...ids));
      },
    },
    {
      scheduler,
      isCached: (entry) => cached.has(entry.id),
      onPrepared: (entry) => {
        cached.add(entry.id);
      },
    },
  );
  remote.read(records[0]!, () => ["second", "third"]);
  await Promise.resolve();
  try {
    for (let frame = 0; frame < 12 && cached.size < 3; frame++) {
      host.time += host.frameInterval;
      host.frame();
      await Promise.resolve();
      while (host.hasTimer(0)) host.timer(0);
      await Promise.resolve();
    }
    expect(consumerRuns).toBeGreaterThan(1);
    expect(requests).toEqual([["first"], ["second", "third"]]);
    expect(cached.size).toBe(3);
    expect(reads).toBe(5);
    for (const entry of records)
      expect(remote.read(entry, () => [])).toEqual(paths(entry.id)[0]!.parts);
  } finally {
    remote.cancel();
    scheduler.dispose();
  }
  expect(remote.memoryUsage()).toBe(0);
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});

function deferredPathRequests(indexed: ReadonlyMap<string, SceneElementRecord>) {
  const requests: string[][] = [];
  let resolve!: (value: readonly PreparedScenePathEntry[]) => void;
  return {
    requests,
    complete: (value: readonly PreparedScenePathEntry[]) => resolve(value),
    store: {
      get: (id: string) => indexed.get(id),
      query: () => undefined,
      prepareScenePaths: (ids: readonly string[]) => {
        requests.push([...ids]);
        return new Promise<readonly PreparedScenePathEntry[]>((complete) => {
          resolve = complete;
        });
      },
    },
  };
}

function record(id: string): SceneElementRecord {
  return {
    id,
    element: { ...createTestStroke(), id },
    geometryVersion: 0,
    paintVersion: 0,
    band: "content",
    rank: 0,
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
  };
}

function paths(...ids: string[]): readonly PreparedScenePathEntry[] {
  return ids.map((id) => ({ id, parts: [{ d: "M0 0Z", paint: "fill" }] }));
}
