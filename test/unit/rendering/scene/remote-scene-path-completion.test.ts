import { expect, it, vi } from "vitest";
import { RemoteScenePaths } from "../../../../src/rendering/scene/content/remote-scene-paths";
import { createSceneRecord } from "../../../fixtures/rendering/scene";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { createGatedTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

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
