import { describe, expect, it, vi } from "vitest";
import * as pressureWindows from "../../../../../src/domain/geometry/pressure/pressure-path-serialization";
import * as elementPaths from "../../../../../src/domain/geometry/element-path";
import { LiveStrokeBuilder } from "../../../../../src/editor/tools/live-stroke";
import { SvgSceneRenderer } from "../../../../../src/rendering/scene";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
} from "../../../../unit/rendering/scene/fakes";

const page = {
  activeBufferLines: 3,
  lockedBufferLines: 1,
  background: { type: "none" as const },
  innerWidth: 2000 as const,
  margin: 24.3 as const,
};

describe("live stroke canonical handoff", () => {
  it("mounts retained windows without rebuilding the stroke and publishes them to selection", () => {
    const store = new FakeSceneStore();
    const publishWindow = vi.fn();
    Object.assign(store, {
      pressureGeometry: () => ({ readWindow: () => undefined, publishWindow }),
    });
    const scheduler = new FakeScheduler();
    const renderer = new SvgSceneRenderer({
      container: asElement(new FakeNode(new FakeDocument(), "div")),
      store,
      workScheduler: scheduler.workScheduler,
      page,
      layout: { readViewport: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) },
    });
    renderer.setPage(page, 1000);
    scheduler.runAll();
    const stroke = indexedStroke(0);
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: stroke.style,
    });
    const preview = builder.appendBatch(
      Array.from({ length: 600 }, (_, index) => ({
        x: index,
        y: 20 + (index % 9),
        pressure: 0.5,
        time: index,
      })),
    );
    renderer.updateLiveStroke(preview, stroke.style, "pen");
    const prepare = vi.spyOn(pressureWindows, "preparePressureWindows");
    const fullBuild = vi.spyOn(elementPaths, "buildElementPathParts");
    try {
      const commit = builder.finish();
      const element = { ...stroke, points: commit.points };
      store.records.set(stroke.id, {
        id: stroke.id,
        element,
        geometryVersion: 1,
        paintVersion: 1,
        rank: 0,
        band: "content",
        bounds: { minX: 0, minY: 0, maxX: 610, maxY: 40 },
      });
      renderer.applyDelta({
        affected: [{ id: stroke.id, after: element, domains: ["geometry", "visibility", "order"] }],
      });
      renderer.commitLiveStroke(stroke.id, commit);
      expect(prepare).not.toHaveBeenCalled();
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual([stroke.id]);
      expect(fullBuild).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0]![0].length).toBeLessThanOrEqual(192);
      expect(publishWindow).toHaveBeenCalledTimes(commit.pressureWindows!.length);
      for (const [index, window] of publishWindow.mock.calls)
        expect(window).toBe(commit.pressureWindows![index as number]);
      const geometry = commit.geometry;
      expect(commit.geometry).toBe(geometry);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      renderer.destroy();
      prepare.mockRestore();
      fullBuild.mockRestore();
    }
  });
});
