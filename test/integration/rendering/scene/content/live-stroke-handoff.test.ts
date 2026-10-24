import { describe, expect, it, vi } from "vitest";
import * as pressureJoins from "../../../../../src/domain/geometry/pressure/pressure-joins";
import * as elementPaths from "../../../../../src/domain/geometry/element-path";
import { LiveStrokeBuilder } from "../../../../../src/editor/tools/live-stroke";
import { indexedStroke, tightPressureLoopSamples } from "../../../../fixtures/editor/stroke";
import { createSceneFixture, createSceneRecord } from "../../../../fixtures/rendering/scene";
import { buildStrokePathParts } from "../../../../../src/domain/geometry/stroke-path";
import { FakeNode, FakeSceneStore, fakeNode } from "../../../../unit/rendering/scene/fakes";

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
    const { renderer, scheduler } = createSceneFixture(page, store);
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
    const prepare = vi.spyOn(pressureJoins, "preparePressureNib");
    const fullBuild = vi.spyOn(elementPaths, "buildElementPathParts");
    try {
      const commit = builder.finish();
      expect(commit.deferGeometryPreparation).toBe(false);
      const preparedNibs = prepare.mock.calls.length;
      expect(preparedNibs).toBeLessThanOrEqual(192);
      const element = { ...stroke, points: commit.points };
      store.records.set(stroke.id, createSceneRecord(element));
      renderer.applyDelta({
        affected: [{ id: stroke.id, after: element, domains: ["geometry", "visibility", "order"] }],
      });
      renderer.commitLiveStroke(stroke.id, commit);
      expect(prepare).toHaveBeenCalledTimes(preparedNibs);
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual([stroke.id]);
      expect(fullBuild).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(preparedNibs);
      expect(publishWindow).toHaveBeenCalledTimes(commit.pressureWindows!.length);
      for (const [index, window] of publishWindow.mock.calls)
        expect(window).toBe(commit.pressureWindows![index as number]);
      const geometry = commit.geometry;
      expect(commit.geometry).toBe(geometry);
      expect(prepare).toHaveBeenCalledTimes(preparedNibs);
    } finally {
      renderer.destroy();
      prepare.mockRestore();
      fullBuild.mockRestore();
    }
  });
});

describe("deferred live stroke canonical handoff", () => {
  it("keeps a short ambiguous live tail until cooperative canonical mounting without lazy reads", () => {
    const store = new FakeSceneStore();
    const { renderer, scheduler } = createSceneFixture(page, store);
    renderer.setPage(page, 1000);
    scheduler.runAll();
    const initial = indexedStroke(0);
    const stroke = { ...initial, style: { ...initial.style, width: 22 as const } };
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: stroke.style,
    });
    const preview = builder.appendBatch(tightPressureLoopSamples(120, 2));
    expect(preview.finalizedChunks).toHaveLength(0);
    renderer.updateLiveStroke(preview, stroke.style, "pen");
    const commit = builder.finish();
    expect(commit.deferGeometryPreparation).toBe(true);
    const element = { ...stroke, points: commit.points };
    store.records.set(stroke.id, createSceneRecord(element));
    const unexpectedRead = (): never => {
      throw new Error("The deferred handoff must not demand synchronous geometry");
    };
    try {
      renderer.applyDelta({
        affected: [{ id: stroke.id, after: element, domains: ["geometry", "visibility", "order"] }],
      });
      renderer.commitLiveStroke(stroke.id, {
        deferGeometryPreparation: true,
        geometryMemoryBytes: commit.geometryMemoryBytes,
        get geometry() {
          return unexpectedRead();
        },
        get pressureWindows() {
          return unexpectedRead();
        },
      });
      expect(renderer.mountedIds("content")).toEqual([]);
      expect(scenePaths(fakeNode(renderer.svg))).toContain(preview.tail.geometry[0]!.d);
      expect(renderer.instrumentation().liveTailNodesRemoved).toBe(0);
      scheduler.runAll();
      expect(renderer.mountedIds("content")).toEqual([stroke.id]);
      expect(scenePaths(fakeNode(renderer.svg))).toContain(buildStrokePathParts(element)[0]!.d);
      expect(renderer.instrumentation().liveTailNodesRemoved).toBe(1);
    } finally {
      renderer.destroy();
    }
  });
});

function scenePaths(node: FakeNode): string[] {
  return [
    ...(node.tagName === "path" ? [node.attributes.get("d") ?? ""] : []),
    ...node.nodes.flatMap(scenePaths),
  ];
}
