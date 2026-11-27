import { expect, it, vi } from "vitest";

import { fakeNode } from "../../../../unit/rendering/scene/fakes";
import {
  createInteractionFixture,
  createInteractionRenderer,
} from "../interaction-refresh-profile-fixture";

it("publishes 10,000 strokes in bounded SVG batches and releases the scene", () => {
  const { ids, store } = createInteractionFixture();
  const { renderer, scheduler } = createInteractionRenderer(store);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[5]!;
  const insertBefore = content.insertBefore.bind(content);
  let insertedRoots = 0;
  const insert = vi.spyOn(content, "insertBefore").mockImplementation((node, anchor) => {
    insertedRoots += node.fragment ? node.nodes.length : 1;
    return insertBefore(node, anchor);
  });

  try {
    renderer.setViewport({ top: 0, left: 0, width: 1_050, height: 1_050 });
    let frames = 0;
    let publishedRoots = 0;
    while (scheduler.pendingCount > 0) {
      expect(++frames).toBeLessThanOrEqual(100);
      insertedRoots = 0;
      scheduler.runNext();
      // The browser publication limit applies to live roots inside fragments as well.
      expect(insertedRoots).toBeLessThanOrEqual(384);
      publishedRoots += insertedRoots;
      scheduler.time += 1_000 / 120;
    }
    expect(publishedRoots).toBe(10_000);
    expect(renderer.mountedIds("content")).toEqual(ids);
    const publishedCenters = content.nodes.map((node) => {
      // Each test stroke is one dot with a radius below one unit on a ten-unit grid.
      const start = /^M(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/u.exec(node.attributes.get("d") ?? "");
      if (start === null) throw new Error("Expected a published dot path.");
      return {
        x: Math.round(Number(start[1]) / 10) * 10,
        y: Math.round(Number(start[2]) / 10) * 10,
      };
    });
    expect(publishedCenters).toEqual(ids.map((id) => store.get(id)?.element.pivot));
    expect(renderer.instrumentation()).toMatchObject({
      domEntrants: 10_000,
      geometryBuilds: 10_000,
      spatialQueries: 1,
    });
  } finally {
    insert.mockRestore();
    renderer.destroy();
  }
  expect(renderer.mountedCount).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});
