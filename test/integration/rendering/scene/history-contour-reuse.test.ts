import { beforeAll, expect, it, vi } from "vitest";
import * as geometry from "../../../../src/domain/geometry/element-path";
import * as intersections from "../../../../src/domain/geometry/pressure-boundary-intersections";
import * as pressureOutline from "../../../../src/domain/geometry/pressure-outline";
import { translatedStroke } from "../../../../src/domain/geometry/stroke-position";
import type { InkElementV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { createHistoryContourScene, drainHistoryFrames } from "../../../fixtures/rendering/scene";

let initialInputs: NonNullable<Parameters<typeof createHistoryContourScene>[0]>;

beforeAll(() => {
  const fixture = createHistoryContourScene();
  try {
    initialInputs = fixture.initialInputs();
  } finally {
    fixture.dispose();
  }
  fixture.scheduler.runAll();
  expect(fixture.scheduler.pendingCount).toBe(0);
});

it.each([
  ["unchanged", false],
  ["width", false],
  ["pressure", false],
  ["move", false],
  ["store-ready", false],
  ["width", true],
] as const)(
  "preserves %s history contours in a 10,000-stroke store (memory pressure: %s)",
  async (edit, memoryPressure) => {
    const fixture = createHistoryContourScene(initialInputs);
    const { store, renderer, scheduler } = fixture;
    expect(store.size).toBe(10_000);
    const ids = renderer.mountedIds("content").slice(0, 10);
    expect(ids).toHaveLength(10);
    expect(renderer.instrumentation().geometryBuilds).toBe(ids.length);
    const count = renderer.mountedCount;
    const build = vi.spyOn(geometry, "buildElementPathParts");
    const contour = vi.spyOn(intersections, "intersectPressureBoundaries");
    const outline = vi.spyOn(pressureOutline, "visitPreparedPressureOutline");
    try {
      if (memoryPressure) renderer.setActiveDocumentMemoryPressure(true);
      if (edit !== "unchanged") {
        for (const id of ids) {
          store.replace(id, editedStroke(store.get(id)!.element as InkElementV1, edit));
          if (edit === "store-ready") {
            const record = store.get(id)!;
            store.pressureGeometry(id, record.geometryVersion).publishPath!(
              geometry.buildElementPathParts(record.element as InkElementV1),
            );
          }
        }
        scheduler.runAll();
        if (edit === "store-ready") expect(build).toHaveBeenCalledTimes(ids.length);
        else if (edit !== "move") expect(outline).toHaveBeenCalled();
      }
      const original = ids.map((id) => store.get(id)!.element);
      outline.mockClear();
      contour.mockClear();
      build.mockClear();
      renderer.resetInstrumentation();
      const deletion = store.removeWithHistory(ids);
      if (deletion === null) throw new Error("Expected a removal transition.");
      scheduler.runAll();
      expect(renderer.mountedCount).toBe(count - ids.length);
      expect(build).not.toHaveBeenCalled();
      const restored = await fixture.prepareReplay(deletion.transition, "reverse");
      expect(restored.status).toBe("prepared");
      store.commitPreparedElementMutation(restored.token!);
      drainHistoryFrames(scheduler);
      expect(renderer.mountedCount).toBe(count);
      expect(ids.map((id) => store.get(id)!.element)).toEqual(original);
      ids.forEach((id, index) => expect(store.get(id)!.element).toBe(original[index]));
      const replay = await fixture.prepareReplay(deletion.transition, "forward");
      expect(replay.status).toBe("prepared");
      store.commitPreparedElementMutation(replay.token!);
      drainHistoryFrames(scheduler);
      expect(renderer.mountedCount).toBe(count - ids.length);
      expect(renderer.instrumentation().geometryBuilds).toBe(memoryPressure ? ids.length : 0);
      expect(build).not.toHaveBeenCalled();
      if (memoryPressure) expect(contour.mock.calls.length).toBeGreaterThan(0);
      else expect(contour.mock.calls.length).toBe(0);
      expect(outline.mock.calls.length).toBe(memoryPressure ? ids.length : 0);
      expect(renderer.instrumentation().detachedCacheEntries).toBe(0);
      expect(renderer.instrumentation().motionCacheEntries).toBe(0);
    } finally {
      build.mockRestore();
      contour.mockRestore();
      outline.mockRestore();
      fixture.dispose();
    }
    scheduler.runAll();
    expect(renderer.memoryUsage()).toEqual({ pathCacheBytes: 0, motionCacheBytes: 0 });
    expect(scheduler.pendingCount).toBe(0);
  },
);

function editedStroke(
  element: InkElementV1,
  edit: "width" | "pressure" | "move" | "store-ready",
): StrokeElementV1 {
  if (element.kind !== "stroke") throw new Error("Expected a stroke fixture.");
  if (edit === "move") return translatedStroke(element, { x: 1, y: 1 });
  return edit === "width" || edit === "store-ready"
    ? { ...element, style: { ...element.style, width: 8 } }
    : {
        ...element,
        points: Array.from(element.points, (value, index) => (index % 3 === 2 ? value / 2 : value)),
      };
}
