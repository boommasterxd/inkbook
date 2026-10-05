import { describe, expect, it, vi } from "vitest";

import {
  type ArrowElementV1,
  type BoxShapeElementV1,
  type PageV1,
  type StrokeStyleV1,
} from "../../../../src/domain/schema/public";
import { type StraightHighlighterElementV1 } from "../../../../src/domain/schema/types";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/live-stroke";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { type SceneElementRecord } from "../../../../src/rendering/scene/types";
import { flushSceneViewport } from "../../../fixtures/rendering/scene";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asDocument,
  asElement,
  fakeRectangleRecord,
  fakeNode,
  replaceWithRectangles,
} from "../../../unit/rendering/scene/fakes";

const page: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
};
function highlighter(): SceneElementRecord {
  const element: StraightHighlighterElementV1 = {
    bend: null,
    createdAt: 0,
    end: { x: 80, y: 40 },
    endNode: "none",
    id: "highlight",
    kind: "straight-highlighter",
    pivot: { x: 45, y: 40 },
    rotation: 0,
    start: { x: 10, y: 40 },
    startNode: "none",
    style: {
      color: { type: "rgba", value: "#FFFF0080" },
      opacity: 0.5,
      pressureEnabled: false,
      smoothing: 0.5,
      width: 8,
    },
  };
  return {
    band: "highlight",
    bounds: { maxX: 90, maxY: 50, minX: 0, minY: 30 },
    element,
    geometryVersion: 1,
    id: element.id,
    paintVersion: 1,
    rank: 0,
  };
}

function arrow(endNode: ArrowElementV1["endNode"]): SceneElementRecord {
  const element: ArrowElementV1 = {
    bend: null,
    createdAt: 0,
    end: { x: 80, y: 60 },
    endConnection: null,
    endNode,
    id: "arrow",
    kind: "arrow",
    pivot: { x: 45, y: 60 },
    rotation: 0,
    start: { x: 10, y: 60 },
    startConnection: null,
    startNode: "none",
    style: {
      outlineColor: { type: "rgba", value: "#112233FF" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
  };
  return {
    band: "content",
    bounds: { maxX: 90, maxY: 70, minX: 0, minY: 50 },
    element,
    geometryVersion: endNode === "none" ? 1 : 2,
    id: element.id,
    paintVersion: 1,
    rank: 0,
  };
}

function setup(): {
  container: FakeNode;
  renderer: SvgSceneRenderer;
  scheduler: FakeScheduler;
  store: FakeSceneStore;
} {
  const document = new FakeDocument();
  const container = new FakeNode(document, "div");
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  store.records.set("a", fakeRectangleRecord("a", 0, 10));
  store.records.set("highlight", highlighter());
  const renderer = new SvgSceneRenderer({
    container: asElement(container),
    inputHandlers: { pointerdown: vi.fn() },
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page,
    workScheduler: scheduler.workScheduler,
    store,
  });
  void asDocument(document);
  renderer.setPage(page, 500);
  return { container, renderer, scheduler, store };
}

function setupTransformPreview(
  prefix: string,
  yAt: (rank: number) => number,
): {
  readonly content: FakeNode;
  readonly renderer: SvgSceneRenderer;
  readonly scheduler: FakeScheduler;
} {
  const { renderer, scheduler, store } = setup();
  const ids = replaceWithRectangles(store, prefix, 300, yAt);
  scheduler.runAll();
  renderer.setPreviewTransform(ids, "translate(5 0)", 1);
  scheduler.runAll();
  return { content: fakeNode(renderer.svg).nodes[1]!.nodes[4]!, renderer, scheduler };
}

describe("imperative SVG scene renderer", () => {
  it("mounts two fixed bands through exact 80-screen-pixel spatial overscan", () => {
    const { renderer, scheduler, store } = setup();

    scheduler.runAll();

    expect(store.lastQuery).toEqual({ maxX: 256, maxY: 256, minX: -256, minY: -256 });
    expect(renderer.mountedIds("highlight")).toEqual(["highlight"]);
    expect(renderer.mountedIds("content")).toEqual(["a"]);
    expect(renderer.mountedCount).toBe(2);
    expect(renderer.instrumentation()).toMatchObject({ domEntrants: 2, geometryBuilds: 2 });
  });

  it("coalesces invalidations and keeps camera, overlay, paint, and order domains isolated", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    renderer.resetInstrumentation();

    renderer.setOverlayPath("M 1 1 L 2 2");
    renderer.setOverlayPath("M 2 2 L 3 3");
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
    expect(renderer.instrumentation()).toMatchObject({
      contentAttributeWrites: 0,
      geometryBuilds: 0,
      spatialQueries: 0,
    });

    renderer.resetInstrumentation();
    renderer.setScheme("dark");
    renderer.setScheme("dark");
    scheduler.runAll();
    expect(renderer.instrumentation()).toMatchObject({
      backgroundBuilds: 0,
      contentAttributeWrites: 0,
      geometryBuilds: 0,
      spatialQueries: 0,
      themeWrites: 1,
    });
    expect(fakeNode(renderer.svg).style["--inkbook-page"]).toBe("#212121FF");

    renderer.resetInstrumentation();
    renderer.setCamera({ x: 5, zoom: 2 });
    scheduler.runAll();
    expect(store.lastQuery).toEqual({ maxX: 256, maxY: 256, minX: -256, minY: -256 });
    expect(renderer.instrumentation()).toMatchObject({
      contentAttributeWrites: 0,
      geometryBuilds: 0,
      spatialQueries: 0,
      visibilityHysteresisHits: 1,
    });

    renderer.resetInstrumentation();
    const current = store.records.get("a")!;
    const element = current.element as BoxShapeElementV1;
    store.records.set("a", {
      ...current,
      element: { ...element, style: { ...element.style, outlineOpacity: 0.25 } },
      paintVersion: 2,
    });
    renderer.applyDelta({ affected: [{ domains: ["paint"], id: "a" }] });
    scheduler.runAll();
    expect(renderer.instrumentation()).toMatchObject({
      contentAttributeWrites: 1,
      geometryBuilds: 0,
      spatialQueries: 0,
    });

    store.records.set("b", fakeRectangleRecord("b", 1, 40));
    renderer.applyDelta({ affected: [{ domains: ["visibility"], id: "b" }] });
    scheduler.runAll();
    renderer.resetInstrumentation();
    store.records.set("a", { ...store.records.get("a")!, rank: 2 });
    store.records.set("b", { ...store.records.get("b")!, rank: 0 });
    renderer.applyDelta({
      affected: [
        { domains: ["order"], id: "a" },
        { domains: ["order"], id: "b" },
      ],
    });
    scheduler.runAll();
    expect(renderer.mountedIds("content")).toEqual(["b", "a"]);
    expect(renderer.instrumentation()).toMatchObject({
      contentAttributeWrites: 0,
      geometryBuilds: 0,
      spatialQueries: 0,
    });
  });
});

describe("live stroke scene handoff", () => {
  it("reuses finalized nodes across a 4096-sample stroke with bounded tail allocation", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();
    renderer.resetInstrumentation();
    const style: StrokeStyleV1 = {
      color: { type: "rgba", value: "#112233FF" },
      opacity: 0.8,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 8,
    };
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style,
    });
    const liveLayer = fakeNode(renderer.svg).nodes[1]!.nodes[6]!;
    const liveGroup = liveLayer.nodes[0]!;
    let firstChunkNode: FakeNode | undefined;
    let latestPreview = builder.append({ pressure: 0.5, time: 0, x: 0, y: 0 });
    renderer.updateLiveStroke(latestPreview, style, "pen");

    for (let index = 1; index < 4096; index += 1) {
      latestPreview = builder.append({
        pressure: 0.5,
        time: index,
        x: index,
        y: index % 7,
      });
      renderer.updateLiveStroke(latestPreview, style, "pen");
      if (firstChunkNode === undefined && latestPreview.finalizedChunks.length > 0) {
        firstChunkNode = liveGroup.nodes[0];
      }
    }

    const statistics = renderer.instrumentation();
    const builderStatistics = builder.instrumentation();
    expect(scheduler.pendingCount).toBe(0);
    expect(builderStatistics.maximumFinalizedChunkSamples).toBeLessThanOrEqual(131);
    expect(builderStatistics.maximumTailSamples).toBeLessThanOrEqual(131);
    expect(liveLayer.nodes).toEqual([liveGroup]);
    expect(liveGroup.nodes).toHaveLength(latestPreview.finalizedChunks.length + 1);
    expect(liveGroup.nodes[0]).toBe(firstChunkNode);
    expect(liveGroup.nodes[liveGroup.nodes.length - 1]?.attributes.get("d")).toBe(
      latestPreview.tail.geometry[0]?.d,
    );
    expect(liveGroup.nodes[0]?.attributes.get("fill")).toBe("#112233FF");
    expect(liveGroup.nodes[0]?.attributes.get("stroke")).toBe("none");
    expect(liveGroup.attributes.get("opacity")).toBe("0.8");
    expect(liveGroup.nodes[0]?.attributes.has("fill-opacity")).toBe(false);
    expect(statistics).toMatchObject({
      collectionAllocations: 0,
      contentAttributeWrites: 0,
      contentGeometryWrites: 0,
      geometryBuilds: 0,
      liveChunkNodesCreated: latestPreview.finalizedChunks.length,
      liveMaximumChunkNodes: latestPreview.finalizedChunks.length,
      liveMaximumTailNodes: 1,
      livePreviewUpdates: 4096,
      liveTailNodesCreated: 1,
      liveTailNodesRemoved: 0,
    });

    renderer.clearLiveStroke();
    expect(liveGroup.nodes).toHaveLength(0);
    expect(liveGroup.attributes.has("opacity")).toBe(false);
    expect(renderer.instrumentation()).toMatchObject({
      liveChunkNodesRemoved: latestPreview.finalizedChunks.length,
      liveTailNodesRemoved: 1,
    });
  });
});

describe("scene DOM ownership", () => {
  it("owns one accessible input surface and releases listeners and DOM", () => {
    const { container, renderer, scheduler } = setup();
    scheduler.runAll();
    const input = fakeNode(renderer.inputSurface);

    expect(input.tabIndex).toBe(0);
    const label = input.nodes[0]!;
    expect(input.attributes.has("aria-label")).toBe(false);
    expect(input.attributes.has("title")).toBe(false);
    expect(input.attributes.get("aria-labelledby")).toBe(label.attributes.get("id"));
    expect(label.attributes.has("hidden")).toBe(true);
    expect((label as unknown as HTMLElement).textContent).toBe("Inkbook canvas");
    expect(input.attributes.get("class")).toBe("inkbook-canvas-input");
    expect(input.listeners.get("pointerdown")?.size).toBe(1);
    expect(fakeNode(renderer.svg).nodes[2]?.nodes[0]?.attributes.get("fill-rule")).toBe("evenodd");

    renderer.destroy();

    expect(input.listeners.get("pointerdown")?.size).toBe(0);
    expect(container.nodes).toHaveLength(0);
  });

  it("updates page-surface height even when background geometry remains cached", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();
    const svg = fakeNode(renderer.svg);
    const camera = svg.nodes[1]!;
    const pageSurface = camera.nodes[0]!;

    renderer.setPage(page, 600);
    scheduler.runAll();

    expect(pageSurface.attributes.get("d")).toContain("2048.6 600 L 0 600 Z");
  });

  it("renders tall backgrounds through bounded geometry and an SVG pattern", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();

    renderer.setPage({ ...page, background: { spacing: 25, type: "dots" } }, 900_000);
    scheduler.runAll();

    const svg = fakeNode(renderer.svg);
    const camera = svg.nodes[1]!;
    const background = camera.nodes[1]!;
    expect(background.attributes.get("d")?.match(/M /g)).toHaveLength(1);
    expect(background.attributes.get("fill")).toMatch(/^url\(#inkbook-background-pattern-/);
    const pattern = svg.nodes[3]!.nodes[0]!;
    const patternPath = pattern.nodes[0]!;
    expect(patternPath.attributes.get("d")).toBe("M 1 1 L 1 1");
    renderer.setPage({ ...page, background: { spacing: 25, type: "squares" } }, 500);
    renderer.setCamera({ x: 0, zoom: 0.25 });
    scheduler.runAll();
    expect(background.attributes.get("fill")).toMatch(/^url\(#inkbook-background-pattern-/u);
    expect(background.attributes.has("vector-effect")).toBe(false);
    expect(background.attributes.get("d")?.match(/M /gu)).toHaveLength(1);
    expect(patternPath.attributes.get("d")).toBe("M 0 2 H 25 M 2 0 V 25");
    expect(patternPath.attributes.get("stroke-width")).toBe("4");
  });
});

describe("mounted scene updates", () => {
  it("flushes pending pointer feedback inside an owning navigation frame", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();
    const svg = fakeNode(renderer.svg);
    const camera = svg.nodes[1]!;
    const overlay = svg.nodes[2]!.nodes[0]!;

    renderer.setCamera({ x: 5, zoom: 2 });
    renderer.setOverlayPath("M 1 1 L 2 2");
    renderer.flushPointerFeedbackFrame();

    expect(camera.attributes.get("transform")).toBe("translate(10 0) scale(2)");
    expect(overlay.attributes.get("d")).toBe("M 1 1 L 2 2");
    expect(scheduler.pendingCount).toBe(1);
  });

  it("updates geometry and previews, then reuses paths after a viewport exit", () => {
    const { renderer, scheduler, store } = setup();
    scheduler.runAll();
    const current = store.records.get("a")!;
    const element = current.element as BoxShapeElementV1;
    store.records.set("a", {
      ...current,
      element: { ...element, width: 30 },
      geometryVersion: 2,
    });
    renderer.resetInstrumentation();
    renderer.applyDelta({ affected: [{ domains: ["geometry"], id: "a" }] });
    scheduler.runAll();
    expect(renderer.instrumentation()).toMatchObject({
      contentGeometryWrites: 1,
      geometryBuilds: 1,
    });

    renderer.resetInstrumentation();
    renderer.setPreviewTransform(["a"], "translate(5 0)", 1);
    scheduler.runAll();
    renderer.clearPreviewTransforms();
    scheduler.runAll();
    expect(renderer.instrumentation().contentGeometryWrites).toBe(2);

    flushSceneViewport(renderer, scheduler, { height: 100, left: 0, top: 1000, width: 100 });
    expect(renderer.mountedCount).toBe(0);
    renderer.resetInstrumentation();
    flushSceneViewport(renderer, scheduler, { height: 100, left: 0, top: 0, width: 100 });
    expect(renderer.instrumentation()).toMatchObject({
      geometryBuilds: 0,
      detachedCacheHits: 2,
      contentGeometryWrites: 0,
      contentAttributeWrites: 0,
    });
  });

  it("replaces direct sibling path topology when arrow paint semantics change", () => {
    const { renderer, scheduler, store } = setup();
    store.records.clear();
    store.records.set("arrow", arrow("none"));
    scheduler.runAll();
    renderer.resetInstrumentation();
    store.records.set("arrow", arrow("triangle"));

    renderer.applyDelta({ affected: [{ domains: ["geometry"], id: "arrow" }] });
    scheduler.runAll();

    expect(renderer.mountedIds("content")).toEqual(["arrow"]);
    expect(renderer.instrumentation()).toMatchObject({ geometryBuilds: 1 });
  });
});

describe("dense scene reconciliation", () => {
  it("keeps 20,000 offscreen elements out of the mounted scene", () => {
    const { renderer, scheduler, store } = setup();
    store.records.clear();
    for (let rank = 0; rank < 20_000; rank += 1) {
      const y = rank < 4 ? 10 : 10_000 + rank * 100;
      const id = `budget-${rank.toString().padStart(5, "0")}`;
      store.records.set(id, fakeRectangleRecord(id, rank, 10, y));
    }

    scheduler.runAll();

    expect(store.lastQuery).toMatchObject({ maxY: 256, minY: -256 });
    expect(renderer.mountedCount).toBe(4);
  });

  it("reconciles dense visibility in batches and promotes an unmounted hit", () => {
    const { renderer, scheduler, store } = setup();
    const expected = replaceWithRectangles(store, "dense", 1_201, () => 10);

    scheduler.runNext();
    expect(renderer.mountedCount).toBe(192);
    expect(fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes).toHaveLength(192);
    expect(renderer.instrumentation().geometryBuilds).toBeGreaterThan(0);
    expect(renderer.instrumentation().geometryBuilds).toBeLessThan(expected.length);
    renderer.promoteVisible(expected[0]!);
    scheduler.runAll();

    expect(renderer.mountedIds("content")).toEqual(expected);
    expect(renderer.mountedCount).toBe(1201);
    expect(renderer.instrumentation().frames).toBeLessThanOrEqual(21);
    expect(renderer.instrumentation().domFragmentRuns).toBeGreaterThan(1);

    renderer.resetInstrumentation();
    renderer.setCamera({ x: 0.5, zoom: 1 });
    scheduler.runAll();
    expect(renderer.instrumentation()).toMatchObject({
      collectionAllocations: 0,
      contentAttributeWrites: 0,
    });
  });

  it("limits transformed selected content to 256 viewport-near paths", () => {
    const { content } = setupTransformPreview("selected", (rank) => 10 + rank / 1_000);
    expect(content.nodes.filter(({ attributes }) => attributes.has("transform"))).toHaveLength(256);
  });
});
describe("camera-aware selection transform previews", () => {
  it("refreshes the bounded transform subset in the same camera frame", () => {
    const { content, renderer, scheduler } = setupTransformPreview(
      "camera-selected",
      (rank) => rank / 2,
    );
    expect(content.nodes[content.nodes.length - 1]?.attributes.has("transform")).toBe(false);
    renderer.setCamera({ x: -100, zoom: 1 });
    scheduler.runAll();

    expect(content.nodes[content.nodes.length - 1]?.attributes.get("transform")).toBe(
      "translate(5 0)",
    );
    expect(content.nodes.filter(({ attributes }) => attributes.has("transform"))).toHaveLength(256);
  });
});
