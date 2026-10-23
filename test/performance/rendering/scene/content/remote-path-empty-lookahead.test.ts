import { expect, it, vi } from "vitest";
import { MAX_PREPARED_SCENE_PATH_BYTES } from "../../../../../src/domain/geometry/prepared-scene-paths";
import { RemoteScenePaths } from "../../../../../src/rendering/scene/content/remote-scene-paths";
import { createTestStroke } from "../../../../fixtures/persistence/worker-snapshot";
import { createGatedTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { createSceneRecord } from "../../../../fixtures/rendering/scene";

it.each([false, true])(
  "bounds cache-heavy empty collection and releases parked viewport work, cancelled=%s",
  async (cancelled) => {
    const records = Array.from({ length: 10_000 }, (_, index) =>
      createSceneRecord({ ...createTestStroke(), id: `warm-${index}` }),
    );
    const required = createSceneRecord({ ...createTestStroke(), id: "required" });
    const indexed = new Map([...records, required].map((record) => [record.id, record]));
    const gate = createGatedTestWorkScheduler();
    const ready = vi.fn();
    const cached = new Set(records.slice(1).map((record) => record.id));
    let reads = 0;
    const prepare = vi.fn((ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => ({ id, parts: [{ d: "M0 0Z", paint: "fill" as const }] }))),
    );
    const remote = new RemoteScenePaths(
      {
        get: (id) => {
          if (++reads === 2) gate.block();
          return indexed.get(id);
        },
        query: () => undefined,
        prepareScenePaths: prepare,
      },
      {
        scheduler: gate.scheduler,
        isCached: (record) => cached.has(record.id),
        onPrepared: (record) => cached.add(record.id),
        onReady: ready,
      },
    );
    remote.read(records[0]!, () => records.slice(1).map((record) => record.id));
    await Promise.resolve();
    expect(reads).toBe(2);
    expect(remote.read(required, () => [])).toBe("pending");
    expect(remote.memoryUsage()).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_BYTES + 128);
    if (cancelled) remote.cancel();
    gate.resume();
    await Promise.resolve();
    expect(reads).toBe(cancelled ? 2 : records.length);
    expect(remote.waiting).toBe(false);
    expect(ready).toHaveBeenCalledTimes(cancelled ? 1 : 2);
    expect(prepare).toHaveBeenCalledOnce();
    if (!cancelled) {
      expect(remote.read(required, () => [])).toBe("pending");
      await Promise.resolve();
      expect(remote.read(required, () => [])).toEqual([{ d: "M0 0Z", paint: "fill" }]);
      expect(prepare.mock.calls.map(([ids]) => ids)).toEqual([["warm-0"], ["required"]]);
      expect(reads).toBe(records.length + 1);
    }
    remote.cancel();
    expect(remote.memoryUsage()).toBe(0);
    expect(remote.readyCount).toBe(0);
  },
);
