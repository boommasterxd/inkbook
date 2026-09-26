import { describe, expect, it, vi } from "vitest";
import { ViewportPreviewSelection } from "../../../../src/rendering/scene/preview-transform-selection";
import { SpatialQueryScratch, UniformSpatialIndex } from "../../../../src/domain/spatial/index";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { SceneElementPreviews } from "../../../../src/rendering/scene/scene-element-previews";
import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import { fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

describe("viewport preview candidate work", () => {
  it("queries actual indexed neighborhoods without rereading a 10000-element selection on camera updates", () => {
    const elements = Array.from(
      { length: 10000 },
      (_, index) =>
        fakeRectangleRecord(
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          index,
          (index % 100) * 1000,
          Math.floor(index / 100) * 1000,
        ).element,
    );
    const store = new ElementStore(elements);
    const port = new ElementSceneStore(store);
    let visits = 0;
    const originalQuery = store.query.bind(store);
    vi.spyOn(store, "query").mockImplementation((bounds, scratch) => {
      const count = originalQuery(bounds, scratch);
      visits = scratch.candidateVisitCount;
      return count;
    });
    const get = vi.spyOn(port, "get");
    const query = vi.spyOn(port, "query");
    const previews = new SceneElementPreviews(
      { previewMemoryUsage: () => 0 } as SceneContentRenderer,
      port,
    );
    const ids = elements.map(({ id }) => id);

    for (const index of [0, 5000, 9999]) {
      get.mockClear();
      store.resetInstrumentation();
      const viewport = { height: 100, left: 0, top: Math.floor(index / 100) * 1000, width: 100 };
      const camera = { x: -(index % 100) * 1000, zoom: 1 };
      const selected = previews.selectProgressiveIds(ids, viewport, camera);
      expect(selected).toContain(ids[index]);
      expect(get.mock.calls.length).toBeLessThanOrEqual(3);
      // One nearby rectangle can occupy four cells across grid boundaries.
      expect(visits).toBeLessThanOrEqual(4);
      expect(previews.selectProgressiveIds(ids, viewport, camera)).toBe(selected);
      expect(store.instrumentation.fullStoreScans).toBe(0);
    }
    expect(query).toHaveBeenCalledTimes(3);
    // Retained source slots, UUID bytes, membership entries and at most three selected slots.
    expect(previews.memoryUsage()).toBeLessThanOrEqual(10000 * 112 + 24);
    expect(previews.memoryUsage()).toBeGreaterThanOrEqual(10000 * 112);
    previews.clearProgressive();
    expect(previews.memoryUsage()).toBe(0);
    get.mockClear();
    expect(
      previews.selectProgressiveIds(
        ids,
        { height: 100, left: 0, top: 50000, width: 100 },
        { x: 0, zoom: 1 },
      ),
    ).toEqual([ids[5000]]);
    expect(get).toHaveBeenCalledOnce();
    previews.release();
    expect(previews.memoryUsage()).toBe(0);
    port.release();
  });
});

it("bounds candidate retention and sorting when all 10000 selected elements overlap the viewport", () => {
  const records = new Map(
    Array.from({ length: 10000 }, (_, index) => {
      const id = String(index).padStart(5, "0");
      return [id, fakeRectangleRecord(id, index, 30)] as const;
    }),
  );
  const ids = [...records.keys()].reverse();
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...records.values()].map(({ id, bounds }) => ({ id, bounds })));
  const scratch = new SpatialQueryScratch<string>();
  const get = vi.fn((id: string) => records.get(id));
  const selection = new ViewportPreviewSelection();
  const sort = vi.spyOn(Array.prototype, "sort");
  try {
    const selected = selection.select(
      ids,
      {
        get,
        query: (bounds, sink) => {
          const count = index.query(bounds, scratch);
          for (let position = 0; position < count; position += 1) sink.add(scratch.at(position));
        },
      },
      { height: 100, left: 0, top: 0, width: 100 },
      { x: 0, zoom: 1 },
    );
    expect(get).toHaveBeenCalledTimes(10000);
    expect(scratch.candidateVisitCount).toBe(10000);
    expect(selected).toHaveLength(256);
    expect(selected[0]).toBe("00000");
    const sortedArrays = sort.mock.contexts as unknown as readonly (readonly unknown[])[];
    expect(sortedArrays.length).toBe(1);
    expect(sortedArrays[0]?.length).toBeLessThanOrEqual(470);
    expect(selection.memoryUsage()).toBeLessThanOrEqual(10000 * 50 + 256 * 8);
  } finally {
    sort.mockRestore();
    selection.clear();
    scratch.release();
  }
  expect(selection.memoryUsage()).toBe(0);
});
