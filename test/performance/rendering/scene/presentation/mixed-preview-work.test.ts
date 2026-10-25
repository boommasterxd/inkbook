import { afterEach, expect, it, vi } from "vitest";
import type { InkElementV1, StrokeElementV1 } from "../../../../../src/domain/schema/public";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import { SceneElementPreviews } from "../../../../../src/rendering/scene/presentation/scene-element-previews";
import { createSceneRecord } from "../../../../fixtures/rendering/scene";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import * as elementPath from "../../../../../src/domain/geometry/element-path";
import { resolveShapeAnchor } from "../../../../../src/domain/geometry/anchors";
import {
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

import {
  connectedPreviewLine,
  createSettledPreviewScene,
  expectReleasedPreviewScene,
} from "../../../../fixtures/rendering/connected-preview-work";

afterEach(() => vi.restoreAllMocks());

function mixedScene(strokes: readonly StrokeElementV1[], count = 600) {
  const store = new FakeSceneStore();
  for (const [rank, element] of strokes.entries())
    store.records.set(element.id, createSceneRecord(element, rank));
  const rectangle = fakeRectangleRecord("selected-shape", 30_000, 20).element;
  const shape = createSceneRecord({ ...rectangle, rotation: 45 }, 30_000);
  if (shape.element.kind !== "rectangle") throw new TypeError("Expected a rectangle.");
  const target = shape.element;
  const anchor = { kind: "box", position: "middle-right" } as const;
  const followers = Array.from({ length: count }, (_, index) => ({
    ...connectedPreviewLine(index),
    start: resolveShapeAnchor(target, anchor)!,
    startConnection: { targetId: shape.id, anchor },
  }));
  store.records.set(shape.id, shape);
  for (const [rank, element] of followers.entries())
    store.records.set(element.id, createSceneRecord(element, 40_000 + rank));
  const scene = createSettledPreviewScene(store);
  const content = fakeNode(scene.renderer.svg).nodes[1]!.nodes[4]!;
  return {
    ...scene,
    store,
    shape,
    followers,
    ids: strokes.map(({ id }) => id),
    selectedNodes: content.nodes.slice(0, strokes.length),
  };
}

function projectedElement(
  store: FakeSceneStore,
  id: string,
  shapeId: string,
  factor: number,
): InkElementV1 {
  const element = scaleElement(store.records.get(id)!.element, { x: 0, y: 0 }, { x: factor, y: 1 });
  if (element.kind !== "line") return element;
  const shape = scaleElement(
    store.records.get(shapeId)!.element,
    { x: 0, y: 0 },
    { x: factor, y: 1 },
  );
  if (shape.kind !== "rectangle") throw new TypeError("Expected a rectangle.");
  return {
    ...element,
    start: resolveShapeAnchor(shape, { kind: "box", position: "middle-right" })!,
  };
}

it("shares one late admitted unit across selected, connected and membership queues", () => {
  const stroke = indexedStroke(1);
  const follower = connectedPreviewLine(0);
  const store = new FakeSceneStore();
  store.records.set(stroke.id, createSceneRecord(stroke));
  store.records.set(follower.id, createSceneRecord(follower, 1));
  let sourceVisits = 0;
  const connectedIds = new Proxy([follower.id], {
    get(target, key, receiver) {
      if (key === "0") sourceVisits += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const materialize = vi.fn((id: string) => store.records.get(id)?.element);
  const content = {
    previewMountedIds: () => [stroke.id, follower.id],
    promoteVisible: vi.fn(),
    applyPreviewTransform: vi.fn(),
    clearElementPreview: vi.fn(),
  } as unknown as SceneContentRenderer;
  const previews = new SceneElementPreviews(content, store);
  try {
    previews.setProgressive(
      { ids: [stroke.id], materialize, version: 1 },
      undefined,
      { x: 0, zoom: 1 },
      { ids: connectedIds, materialize },
    );
    expect(previews.pending).toBe(true);
    previews.write(0, () => 1, true);
    expect(materialize).toHaveBeenCalledExactlyOnceWith(stroke.id);
    expect(sourceVisits).toBe(0);
    expect(previews.pending).toBe(true);
  } finally {
    previews.release();
  }
});

it("paints followers during continuous nonuniform pressure scaling and finishes both purpose queues exactly", () => {
  const stroke = {
    ...indexedStroke(0),
    points: Array.from({ length: 257 }, (_, index) => [
      20 + index / 10,
      20 + Math.sin(index / 16) * 2,
      0.5,
    ]).flat(),
  };
  const { renderer, scheduler, store, shape, followers } = mixedScene([stroke], 40);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const pressureRoot = content.nodes[0]!;
  const initialShapePath = elementPath.buildElementPathParts(shape.element)[0]!.d;
  const shapeRoot = content.nodes.find((node) => node.attributes.get("d") === initialShapePath)!;
  let factor = 1;
  let geometryReads = 0;
  const materialize = (id: string): InkElementV1 => {
    const element = projectedElement(store, id, shape.id, factor);
    if (element.kind !== "stroke") return element;
    return {
      ...element,
      points: new Proxy(element.points, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) geometryReads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
    };
  };
  const followerIds = followers.map(({ id }) => id);
  const followerSet = new Set(followerIds);
  const connected = {
    ids: followerIds,
    materialize: (id: string) => (followerSet.has(id) ? materialize(id) : undefined),
  };
  const apply = vi.spyOn(SceneContentRenderer.prototype, "applyCanonicalElementPreview");
  const original = Reflect.get<ProgressivePreviewPath, "step">(
    ProgressivePreviewPath.prototype,
    "step",
  );
  const step = vi.spyOn(ProgressivePreviewPath.prototype, "step").mockImplementation(function (
    this: ProgressivePreviewPath,
  ) {
    const complete = original.call(this, scheduler.time, () => scheduler.time + 1);
    scheduler.time += scheduler.workScheduler.budgetMs();
    return complete;
  });
  try {
    for (let version = 1; version <= 100; version += 1) {
      factor = 1 + version / 200;
      renderer.setProgressiveElementPreviews(
        [stroke.id, shape.id],
        materialize,
        version,
        { transform: `scale(${factor} 1)`, inverse: `scale(${1 / factor} 1)` },
        connected,
      );
      renderer.flushPointerFeedbackFrame(scheduler.time);
      expect(pressureRoot.attributes.get("transform")?.startsWith(`scale(${factor} 1)`)).toBe(true);
      expect(shapeRoot.attributes.get("transform")?.startsWith(`scale(${factor} 1)`)).toBe(true);
      scheduler.runNext();
    }
    const followersDuringInput = apply.mock.calls.filter(([element]) =>
      followerSet.has(element.id),
    );
    expect(new Set(followersDuringInput.map(([element]) => element.id)).size).toBe(40);
    expect(geometryReads).toBeGreaterThan(0);
    expect(step.mock.calls.length).toBeGreaterThan(followersDuringInput.length);
    scheduler.runAll(5_000);
    const currentShapePath = elementPath.buildElementPathParts(materialize(shape.id))[0]!.d;
    expect(shapeRoot.attributes.get("d")).toBe(currentShapePath);
    expect(shapeRoot.attributes.has("transform")).toBe(false);
    const finalPressure = apply.mock.calls
      .filter(([element]) => element.id === stroke.id)
      .pop()![0];
    expect(finalPressure).toEqual(scaleElement(stroke, { x: 0, y: 0 }, { x: factor, y: 1 }));
    const roots = content.nodes.slice(-40);
    expect(roots.every((node) => !node.attributes.has("transform"))).toBe(true);
    const expectedFollower = elementPath.buildElementPathParts(materialize(followers[0]!.id))[0]!.d;
    expect(roots.every((node) => node.attributes.get("d") === expectedFollower)).toBe(true);
    renderer.clearElementPreviews();
    scheduler.runAll();
  } finally {
    renderer.destroy();
  }
  expectReleasedPreviewScene(renderer, scheduler);
});

it("preserves complete selected pressure feedback while updating more than 256 connected followers", () => {
  const strokes = Array.from({ length: 300 }, (_, index) => ({
    ...indexedStroke(index),
    points: [20, 20, 0.5, 22, 22, 0.75],
    pivot: { x: 21, y: 21 },
  }));
  const { renderer, scheduler, store, ids, selectedNodes, shape, followers } = mixedScene(strokes);
  const selected = [shape.id, ...ids];
  const followerIds = followers.map(({ id }) => id);
  const followerSet = new Set(followerIds);
  let version = 2;
  const materialize = (id: string) => projectedElement(store, id, shape.id, version);
  const connected = {
    ids: followerIds,
    materialize: (id: string) => {
      if (!followerSet.has(id)) return undefined;
      scheduler.time += 1;
      return materialize(id);
    },
  };
  const apply = vi.spyOn(SceneContentRenderer.prototype, "applyCanonicalElementPreview");
  const preview = vi.spyOn(SceneElementPreviews.prototype, "values", "get");
  try {
    renderer.setProgressiveElementPreviews(
      selected,
      materialize,
      1,
      { transform: "scale(2 1)", inverse: "scale(0.5 1)" },
      connected,
    );
    renderer.flushPointerFeedbackFrame(scheduler.time);
    expect(selectedNodes.every((node) => node.attributes.get("transform") === "scale(2 1)")).toBe(
      true,
    );
    version = 3;
    renderer.setProgressiveElementPreviews(
      selected,
      materialize,
      2,
      { transform: "scale(3 1)", inverse: "scale(0.3333333333 1)" },
      connected,
    );
    renderer.flushPointerFeedbackFrame(scheduler.time);
    expect(selectedNodes.every((node) => node.attributes.get("transform") === "scale(3 1)")).toBe(
      true,
    );
    apply.mockClear();
    scheduler.runAll();
    expect(
      new Set(
        apply.mock.calls
          .filter(([element]) => followerSet.has(element.id))
          .map(([element]) => element.id),
      ).size,
    ).toBe(600);
    expect(
      new Set(
        apply.mock.calls
          .filter(([element]) => !followerSet.has(element.id))
          .map(([element]) => element.id),
      ).size,
    ).toBeLessThanOrEqual(256);
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const followerRoots = content.nodes.slice(-600);
    expect(followerRoots.every((node) => !node.attributes.has("transform"))).toBe(true);
    const expected = elementPath.buildElementPathParts(materialize(followerIds[0]!))[0]!.d;
    expect(followerRoots.every((node) => node.attributes.get("d") === expected)).toBe(true);
    const views = preview.mock.results
      .map(({ value }) => value as ReadonlyMap<string, InkElementV1>)
      .filter((value) => value.size > 1);
    expect(views.length).toBeGreaterThan(1);
    expect(views.every((value) => value === views[0])).toBe(true);
    renderer.clearElementPreviews();
    scheduler.runAll();
  } finally {
    renderer.destroy();
  }
  expectReleasedPreviewScene(renderer, scheduler);
});
