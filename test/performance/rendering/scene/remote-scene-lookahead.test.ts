import { expect, it, vi } from "vitest";
import { RemoteScenePaths } from "../../../../src/rendering/scene/remote-scene-paths";
import { MAX_PREPARED_SCENE_PATH_IDS } from "../../../../src/domain/geometry/prepared-scene-paths";
import type { ScenePathPreparationObserver } from "../../../../src/domain/geometry/prepared-scene-paths";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";

it("preserves capacity lookahead through repeated unchanged retargets with one active request", async () => {
  const records = Array.from({ length: 1_024 }, (_, rank) => ({
    id: `stroke-${rank}`,
    element: { ...createTestStroke(), id: `stroke-${rank}` },
    geometryVersion: 0,
    paintVersion: 0,
    band: "content" as const,
    rank,
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
  }));
  const indexed = new Map(records.map((record) => [record.id, record]));
  const retarget = vi.fn();
  const requested: string[][] = [];
  let observer!: ScenePathPreparationObserver;
  let finish!: () => void;
  let active = 0;
  const remote = new RemoteScenePaths({
    get: (id) => indexed.get(id),
    query: () => undefined,
    prepareScenePaths: (ids, signal, progress) => {
      expect(++active).toBe(1);
      requested.push([...ids]);
      observer = progress!;
      observer.setRetarget(retarget);
      const abort = () => {
        active--;
      };
      signal.addEventListener("abort", abort, { once: true });
      return new Promise((resolve) => {
        finish = () => {
          signal.removeEventListener("abort", abort);
          if (!signal.aborted) active--;
          resolve([]);
        };
      });
    },
  });
  for (const rank of [0, 1, 257, 513]) {
    const record = records[rank]!;
    const upcoming = () => records.slice(rank + 1).map((entry) => entry.id);
    expect(remote.read(record, upcoming)).toBe("pending");
    for (let retargetIndex = 0; retargetIndex < 12; retargetIndex++) remote.cancel(() => true);
    observer.onProgress([{ id: record.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
    expect(remote.read(record, upcoming)).toEqual([{ d: "M0 0Z", paint: "fill" }]);
    finish();
    await Promise.resolve();
  }
  // Unreturned IDs retain their local-fallback slots instead of evicting valid overlap.
  expect(requested.map((ids) => ids.length)).toEqual([1, 256, 1, 1]);
  expect(Math.max(...requested.map((ids) => ids.length))).toBe(MAX_PREPARED_SCENE_PATH_IDS);
  expect(retarget).toHaveBeenCalledTimes(4);
  expect(active).toBe(0);
  const next = records[769]!;
  expect(remote.read(next, () => [])).toBe("pending");
  expect(active).toBe(1);
  remote.cancel();
  observer.onProgress([{ id: next.id, parts: [{ d: "M0 0Z", paint: "fill" }] }]);
  finish();
  await Promise.resolve();
  expect(active).toBe(0);
  expect(remote.waiting).toBe(false);
  expect(remote.memoryUsage()).toBe(0);
});
