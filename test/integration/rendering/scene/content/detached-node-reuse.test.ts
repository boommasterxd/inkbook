import { expect, it, vi } from "vitest";
import { createSceneFixture, createSceneRecord } from "../../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import { stroke } from "../../../../unit/domain/schema/fixtures";
import { FakeSceneStore, fakeNode } from "../../../../unit/rendering/scene/fakes";

it.each(["pen", "highlighter"] as const)(
  "detaches and reuses the complete %s root without changing its children or paint",
  (tool) => {
    const element = stroke(1, tool);
    const record = createSceneRecord(element);
    const store = new FakeSceneStore();
    store.records.set(record.id, record);
    const viewport = { height: 500, left: 0, top: 0, width: 500 };
    const { document, renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, viewport);
    scheduler.runAll();
    const band = fakeNode(renderer.svg).nodes[1]!.nodes[tool === "highlighter" ? 3 : 4]!;
    const original = [...band.nodes];
    const children = original.map((node) => [...node.nodes]);
    const paint = original.map((node) => new Map(node.attributes));
    const create = vi.spyOn(document, "createElementNS");
    try {
      renderer.resetInstrumentation();
      renderer.setViewport({ ...viewport, top: 10_000 });
      scheduler.runAll();
      expect(renderer.mountedCount).toBe(0);
      expect(band.nodes).toHaveLength(0);
      expect(original.every((node) => node.parent === undefined)).toBe(true);
      expect(renderer.instrumentation()).toMatchObject({ domExits: 1, detachedCacheEntries: 1 });
      renderer.resetInstrumentation();
      renderer.setViewport(viewport);
      scheduler.runAll();
      expect(band.nodes).toEqual(original);
      expect(original.map((node) => node.nodes)).toEqual(children);
      expect(original.map((node) => node.attributes)).toEqual(paint);
      expect(create).not.toHaveBeenCalled();
      expect(renderer.instrumentation()).toMatchObject({
        domEntrants: 1,
        domRootsPublished: original.length,
        geometryBuilds: 0,
        detachedCacheEntries: 0,
      });
    } finally {
      create.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.memoryUsage().pathCacheBytes).toBe(0);
    expect(fakeNode(renderer.svg).parent).toBeUndefined();
  },
);
