import { expect, it, vi } from "vitest";
import { RemoteScenePaths } from "../../../../src/rendering/scene/remote-scene-paths";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import type {
  PreparedScenePathEntry,
  ScenePathPreparationObserver,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { MAX_PREPARED_SCENE_PATH_BYTES } from "../../../../src/domain/geometry/prepared-scene-paths";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import {
  createGatedTestWorkScheduler,
  type TestWorkScheduler,
} from "../../../fixtures/persistence/work-scheduler";
import { createSceneRecord } from "../../../fixtures/rendering/scene";

it("checks immutable cache ownership without changing LRU order or hit counts", () => {
  const cache = new ScenePathCache(2);
  const first = record("first");
  const second = record("second");
  const parts = paths("first")[0]!.parts;
  cache.completePreparation(first.element, parts);
  cache.completePreparation(second.element, paths("second")[0]!.parts);
  const before = cache.statistics();
  expect(cache.ownsPrepared(first.element, parts)).toBe(true);
  expect(cache.ownsPrepared(second.element, parts)).toBe(false);
  expect(cache.ownsPrepared(first.element, paths("first")[0]!.parts)).toBe(false);
  expect(cache.statistics()).toEqual(before);
  cache.completePreparation(record("third").element, paths("third")[0]!.parts);
  expect(cache.ownsPrepared(first.element, parts)).toBe(false);
  cache.release();
});

it("does not claim a replacement array when the same geometry keeps its earlier cached parts", () => {
  const cache = new ScenePathCache();
  const entry = record("first");
  const original = paths(entry.id)[0]!.parts;
  const replacement = [{ d: "M1 1Z", paint: "fill" as const }];
  cache.completePreparation(entry.element, original);
  cache.completePreparation(entry.element, replacement);
  expect(cache.read(entry.element)).toBe(original);
  expect(cache.ownsPrepared(entry.element, original)).toBe(true);
  expect(cache.ownsPrepared(entry.element, replacement)).toBe(false);
  cache.retain(entry.id, entry.geometryVersion, replacement);
  expect(cache.take(entry.id, entry.geometryVersion)).toBe(original);
  expect(cache.statistics().entries).toBe(1);
  expect(cache.ownsPrepared(entry.element, original)).toBe(true);
  expect(cache.ownsPrepared(entry.element, replacement)).toBe(false);
  cache.release();
});

it.each(["eviction", "retention", "geometry", "parts"] as const)(
  "keeps remote ownership when the local handoff proof fails after %s changes",
  async (change) => {
    const fixture = await handoffFixture();
    const { remote, records, indexed, cache, progress } = fixture;
    const delivered = paths("second", "third");
    progress().onProgress(delivered);
    expect(remote.readyCount).toBe(2);
    if (change === "eviction") for (const entry of records.slice(1)) cache.invalidate(entry.id);
    if (change === "retention") cache.setRetentionEnabled(false);
    if (change === "geometry")
      for (const entry of records.slice(1))
        indexed.set(entry.id, { ...entry, geometryVersion: entry.geometryVersion + 1 });
    if (change === "parts") {
      cache.release();
      for (const entry of records.slice(1))
        cache.completePreparation(entry.element, paths(entry.id)[0]!.parts);
    }
    fixture.finish([]);
    await Promise.resolve();
    expect(remote.waiting).toBe(false);
    expect(remote.readyCount).toBe(2);
    for (const entry of records.slice(1)) {
      const parts = remote.read(indexed.get(entry.id)!, () => []);
      expect(parts).toEqual(change === "geometry" ? undefined : paths(entry.id)[0]!.parts);
    }
    fixture.release();
    expect(remote.memoryUsage()).toBe(0);
  },
);

it("retargets in-flight membership before handing off accepted terminal contours", async () => {
  const fixture = await handoffFixture();
  const retarget = vi.fn();
  fixture.progress().setRetarget(retarget);
  fixture.progress().onProgress(paths("second"));
  fixture.remote.cancel((id) => id === "second");
  expect(retarget).toHaveBeenLastCalledWith(["second"]);
  fixture.progress().onProgress(paths("third"));
  expect(fixture.cache.read(fixture.records[2]!.element)).toBeUndefined();
  fixture.finish([]);
  await Promise.resolve();
  expect(fixture.remote.readyCount).toBe(0);
  expect(fixture.remote.memoryUsage()).toBe(0);
  fixture.release();
});

it("rejects cumulative progress overflow even when the first contour entered the local cache", async () => {
  const fixture = await handoffFixture();
  const parts = [{ d: "M0 0Z".repeat(220_000), paint: "fill" as const }];
  expect(parts[0]!.d.length * 2).toBeLessThan(MAX_PREPARED_SCENE_PATH_BYTES);
  fixture.progress().onProgress([{ id: "second", parts }]);
  expect(fixture.remote.readyCount).toBe(1);
  expect(fixture.cache.ownsPrepared(fixture.records[1]!.element, parts)).toBe(true);
  fixture.progress().onProgress([{ id: "third", parts }]);
  expect(fixture.remote.readyCount).toBe(0);
  expect(fixture.remote.waiting).toBe(false);
  expect(fixture.cache.read(fixture.records[2]!.element)).toBeUndefined();
  expect(fixture.remote.read(fixture.records[2]!, () => [])).toBeUndefined();
  fixture.finish([]);
  await Promise.resolve();
  fixture.release();
  expect(fixture.remote.memoryUsage()).toBe(0);
});

it.each([false, true])(
  "shares central admission while handing off ready contours, cancelled=%s",
  async (cancelled) => {
    const gate = createGatedTestWorkScheduler();
    const fixture = await handoffFixture(gate.scheduler);
    fixture.progress().onProgress(paths("second", "third"));
    gate.block();
    fixture.finish([]);
    await Promise.resolve();
    expect(fixture.remote.waiting).toBe(true);
    expect(fixture.remote.readyCount).toBe(2);
    if (cancelled) fixture.remote.cancel();
    gate.resume();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.remote.waiting).toBe(false);
    expect(fixture.remote.readyCount).toBe(0);
    expect(fixture.remote.memoryUsage()).toBe(0);
    fixture.release();
  },
);

async function handoffFixture(scheduler?: TestWorkScheduler) {
  const records = ["first", "second", "third"].map(record);
  const indexed = new Map(records.map((entry) => [entry.id, entry]));
  const cache = new ScenePathCache();
  let finish!: (result: readonly PreparedScenePathEntry[]) => void;
  let progress!: ScenePathPreparationObserver;
  const remote = new RemoteScenePaths(
    {
      get: (id) => indexed.get(id),
      query: () => undefined,
      prepareScenePaths: (_ids, _signal, observer) => {
        progress = observer!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    {
      ...(scheduler === undefined ? {} : { scheduler }),
      isCached: (entry) => cache.read(entry.element) !== undefined,
      onPrepared: (entry, parts) => cache.completePreparation(entry.element, parts),
      ownsPrepared: (entry, parts) => cache.ownsPrepared(entry.element, parts),
    },
  );
  remote.read(records[0]!, () => ["second", "third"]);
  finish(paths("first"));
  await Promise.resolve();
  return {
    remote,
    records,
    indexed,
    cache,
    progress: () => progress,
    finish: (result: readonly PreparedScenePathEntry[]) => finish(result),
    release: () => {
      remote.cancel();
      cache.release();
    },
  };
}

function record(id: string): SceneElementRecord {
  const element = createTestStroke();
  const points = [...element.points];
  Object.freeze(points);
  return createSceneRecord({ ...element, id, points });
}

function paths(...ids: string[]): readonly PreparedScenePathEntry[] {
  return ids.map((id) => ({ id, parts: [{ d: "M0 0Z", paint: "fill" }] }));
}
