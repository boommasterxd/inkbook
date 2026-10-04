import { expect, it, vi } from "vitest";
import type {
  PreparedScenePathEntry,
  ScenePathPreparationObserver,
} from "../../../../src/domain/geometry/prepared-scene-paths";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { observePointReads } from "../../../fixtures/rendering/point-reads";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { FakeSceneStore, fakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

it("publishes completed remote contours before terminal completion without rescanning or polling", async () => {
  const { store, pointReads } = streamedStore();
  const requests: string[][] = [];
  let observer: ScenePathPreparationObserver | undefined;
  let complete!: () => void;
  let terminal = false;
  const parts = (ids: readonly string[]): PreparedScenePathEntry[] =>
    ids.map((id) => ({
      id,
      parts: [{ d: `M${store.records.get(id)!.rank} 0Z`, paint: "fill" }],
    }));
  store.prepareScenePaths = (ids, _signal, progress) => {
    requests.push([...ids]);
    if (requests.length === 1) return Promise.resolve(parts(ids));
    observer = progress;
    return new Promise((resolve) => {
      complete = () => {
        terminal = true;
        resolve([]);
      };
    });
  };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    width: 100,
    left: 0,
    top: 0,
  });
  scheduler.runAll();
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  renderer.setViewport({ height: 100, width: 100, left: 500, top: 0 });
  scheduler.runAll();
  await Promise.resolve();
  await Promise.resolve();
  scheduler.runAll();
  expect(requests.map((ids) => ids.length)).toEqual([1, 129]);
  expect(renderer.mountedCount).toBe(1);
  expect(scheduler.pendingCount).toBe(0);
  const get = vi.spyOn(store, "get");
  let frameRoots = 0;
  const insert = content.insertBefore.bind(content);
  const insertion = vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
    frameRoots += node.fragment ? node.nodes.length : 1;
    return insert(node, successor);
  });
  const publish = (ids: readonly string[]) => {
    get.mockClear();
    observer!.onProgress(parts(ids));
    while (scheduler.pendingCount > 0) {
      frameRoots = 0;
      scheduler.runNext();
      expect(frameRoots).toBeLessThanOrEqual(64);
    }
    expect(get.mock.calls.length).toBeLessThanOrEqual(ids.length * 6 + 8);
    expect(requests).toHaveLength(2);
    expect(terminal).toBe(false);
  };
  try {
    publish(requests[1]!.slice(0, 1));
    expect(renderer.mountedCount).toBe(2);
    publish(requests[1]!.slice(1, 66));
    expect(renderer.mountedCount).toBe(67);
    expect(renderer.instrumentation().geometryBuilds).toBe(1_000);
    publish(requests[1]!.slice(66));
    expect(renderer.mountedCount).toBe(130);
    expect(scheduler.pendingCount).toBe(0);
    expect(pointReads()).toBe(0);
    expect(
      content.nodes
        .slice(1_000)
        .map((node) => node.nodes[0]?.attributes.get("d") ?? node.attributes.get("d")),
    ).toEqual(Array.from({ length: 130 }, (_, index) => `M${1_000 + index} 0Z`));
    complete();
    await Promise.resolve();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(130);
  } finally {
    insertion.mockRestore();
    get.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});

function streamedStore() {
  const store: FakeSceneStore & Pick<SceneStorePort, "prepareScenePaths"> = new FakeSceneStore();
  for (let rank = 0; rank < 1_000; rank++) {
    const record = fakeRectangleRecord(`warm-${rank}`, rank, 20);
    store.records.set(record.id, record);
  }
  let pointReads = 0;
  for (let rank = 1_000; rank < 1_130; rank++) {
    const points = [500, 20, 0.5, 510, 20 + rank / 10_000, 1];
    Object.freeze(points);
    const element = {
      ...createTestStroke(),
      id: `cold-${rank}`,
      pivot: { x: 505, y: 20 },
      points: observePointReads(points, () => {
        pointReads++;
      }),
    };
    store.records.set(element.id, {
      id: element.id,
      element,
      rank,
      band: "content",
      geometryVersion: 1,
      paintVersion: 1,
      bounds: { minX: 500, minY: 20, maxX: 510, maxY: 21 },
    });
  }
  return { store, pointReads: () => pointReads };
}
