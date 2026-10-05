import { expect, it, vi } from "vitest";
import { RemoteScenePaths } from "../../../../src/rendering/scene/remote-scene-paths";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import type {
  PreparedScenePathEntry,
  ScenePathPreparationObserver,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";

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
  expect(remote.read(records[1]!, () => [])).toEqual(paths("second")[0]!.parts);
  remote.cancel((id) => id === "third");
  expect(retarget).toHaveBeenLastCalledWith(["third"]);
  expect(signal.aborted).toBe(false);
  observer.onProgress(paths("fourth"));
  expect(prepared).toHaveBeenCalledTimes(3);
  expect(remote.read(records[2]!, () => [])).toEqual(paths("third")[0]!.parts);
  remote.cancel();
  expect(signal.aborted).toBe(true);
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
  const requests: string[][] = [];
  let finish!: (value: readonly PreparedScenePathEntry[]) => void;
  const remote = new RemoteScenePaths({
    get: (id) => indexed.get(id),
    query: () => undefined,
    prepareScenePaths: (ids) => {
      requests.push([...ids]);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  remote.read(records[0]!, () => []);
  finish(paths("first"));
  await Promise.resolve();
  remote.read(records[0]!, () => []);
  remote.read(records[1]!, () => ["third"]);
  remote.cancel((id) => id === "third");
  finish(paths("second"));
  await Promise.resolve();
  remote.read(records[3]!, () => ["third"]);
  expect(requests).toEqual([["first"], ["second", "third"], ["fourth"]]);
  remote.cancel();
  finish([]);
});

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
