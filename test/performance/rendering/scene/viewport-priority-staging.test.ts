import { expect, it, vi } from "vitest";
import { SceneEntrantPriority } from "../../../../src/rendering/scene/scene-entrant-priority";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import {
  createSceneFixture,
  createViewportRectangleStore,
} from "../../../fixtures/rendering/scene";
import { observeSceneInsertions } from "../../../fixtures/rendering/scene-publication";
import { fakeNode } from "../../../unit/rendering/scene/fakes";

it("publishes the ordered viewport before building the 10,000-candidate overscan heap", () => {
  const store = createViewportRectangleStore(10_000, (rank) =>
    rank < SCENE_PUBLICATION_ROOTS_PER_FRAME ? 20 : 200,
  );
  const get = vi.spyOn(store, "get");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The observation wrapper calls the original with its actual receiver through apply.
  const buildOriginal = SceneEntrantPriority.prototype.build;
  let priorityReads = 0;
  let priorityPushes = 0;
  const build = vi.spyOn(SceneEntrantPriority.prototype, "build").mockImplementation(function (
    this: SceneEntrantPriority,
    ...args: Parameters<SceneEntrantPriority["build"]>
  ) {
    const reads = get.mock.calls.length;
    const generation = this.heapGeneration;
    const result = buildOriginal.apply(this, args);
    priorityReads += get.mock.calls.length - reads;
    priorityPushes += this.heapGeneration - generation;
    return result;
  });
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  let firstPushes = 0;
  const insert = observeSceneInsertions(content, (roots) => {
    if (firstPushes === 0) firstPushes = priorityPushes;
    expect(roots).toBeLessThanOrEqual(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    scheduler.time += 8;
  });
  try {
    scheduler.runNext();
    expect(priorityReads).toBe(10_000);
    expect(firstPushes).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(priorityPushes).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(content.nodes.length).toBeGreaterThan(0);
    expect(
      renderer.mountedIds("content").every((id) => store.records.get(id)!.bounds.maxY <= 100),
    ).toBe(true);
    renderer.setViewport({ ...viewport, top: 100_000 });
    scheduler.runAll(400);
    expect(content.nodes).toHaveLength(0);
    expect(renderer.mountedCount).toBe(0);
  } finally {
    insert.mockRestore();
    build.mockRestore();
    get.mockRestore();
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});
