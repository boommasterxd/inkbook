import { expect, it, vi } from "vitest";
import { RemoteScenePaths } from "../../../../src/rendering/scene/content/remote-scene-paths";
import { createSceneRecord } from "../../../fixtures/rendering/scene";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { createGatedTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import type { ScenePathPreparation } from "../../../../src/domain/geometry/prepared-scene-paths";

it("declines unavailable preparation in the calling slice and retries after readiness changes", async () => {
  const first = createSceneRecord({ ...createTestStroke(), id: "first" });
  const second = createSceneRecord({ ...createTestStroke(), id: "second" });
  let available = false;
  const prepare = vi.fn<ScenePathPreparation>((ids) =>
    available ? Promise.resolve(ids.map((id) => ({ id, parts: [] }))) : undefined,
  );
  const ready = vi.fn();
  const remote = new RemoteScenePaths(
    {
      get: (id) => (id === first.id ? first : second),
      query: () => undefined,
      prepareScenePaths: prepare,
    },
    { onReady: ready },
  );
  expect(remote.read(first, () => [])).toBeUndefined();
  expect(remote.read(second, () => [])).toBeUndefined();
  expect(remote.waiting).toBe(false);
  expect(remote.memoryUsage()).toBe(0);
  expect(ready).not.toHaveBeenCalled();
  available = true;
  expect(remote.read(first, () => [])).toBe("pending");
  await Promise.resolve();
  expect(remote.read(first, () => [])).toEqual([]);
  expect(prepare).toHaveBeenCalledTimes(3);
  remote.cancel();
  expect(remote.memoryUsage()).toBe(0);
});

it("wakes a parked contour when deferred collection loses synchronous admission", async () => {
  const first = createSceneRecord({ ...createTestStroke(), id: "first" });
  const required = createSceneRecord({ ...createTestStroke(), id: "required" });
  const gate = createGatedTestWorkScheduler();
  const prepare = vi
    .fn<ScenePathPreparation>()
    .mockResolvedValueOnce([{ id: first.id, parts: [] }])
    .mockReturnValue(undefined);
  const ready = vi.fn();
  const remote = new RemoteScenePaths(
    {
      get: (id) => (id === first.id ? first : required),
      query: () => undefined,
      prepareScenePaths: prepare,
    },
    { scheduler: gate.scheduler, onPrepared: () => gate.block(), onReady: ready },
  );
  expect(remote.read(first, () => [required.id])).toBe("pending");
  await Promise.resolve();
  expect(remote.read(first, () => [required.id])).toEqual([]);
  expect(remote.read(required, () => [required.id])).toBe("pending");
  expect(ready).toHaveBeenCalledOnce();
  gate.resume();
  await Promise.resolve();
  expect(remote.waiting).toBe(false);
  expect(ready).toHaveBeenCalledTimes(2);
  expect(remote.read(required, () => [])).toBeUndefined();
  expect(prepare).toHaveBeenCalledTimes(2);
  remote.cancel();
  expect(remote.memoryUsage()).toBe(0);
});

it.each([false, true])(
  "wakes a required contour parked behind empty lookahead after shared admission, cancelled=%s",
  async (cancelled) => {
    const first = createSceneRecord({ ...createTestStroke(), id: "first" });
    const required = createSceneRecord({ ...createTestStroke(), id: "required" });
    const gate = createGatedTestWorkScheduler();
    const get = vi.fn((id: string) => (id === first.id ? first : required));
    const prepare = vi.fn(() => Promise.resolve([{ id: first.id, parts: [] }]));
    const ready = vi.fn();
    const remote = new RemoteScenePaths(
      { get, query: () => undefined, prepareScenePaths: prepare },
      {
        scheduler: gate.scheduler,
        onPrepared: () => gate.block(),
        onReady: ready,
      },
    );
    expect(remote.read(first, () => [])).toBe("pending");
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
    expect(remote.waiting).toBe(true);
    expect(remote.read(required, () => [])).toBe("pending");
    if (cancelled) remote.cancel();
    gate.resume();
    await Promise.resolve();
    expect(remote.waiting).toBe(false);
    expect(ready).toHaveBeenCalledTimes(cancelled ? 1 : 2);
    expect(prepare).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    remote.cancel();
    expect(remote.memoryUsage()).toBe(0);
  },
);
