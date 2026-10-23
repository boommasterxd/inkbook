import { expect, it, vi } from "vitest";
import * as pressureUnion from "../../../../../src/domain/geometry/pressure/pressure-union";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { createWorkerSnapshot } from "../../../../fixtures/persistence/worker-snapshot";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";
import { translatedStroke } from "../../../../../src/domain/geometry/stroke-position";
import type { StrokeElementV1 } from "../../../../../src/domain/schema/public";
import * as strokePath from "../../../../../src/domain/geometry/stroke-path";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { roundCanonical } from "../../../../../src/domain/geometry/primitives";

it("mounts validated unlock paths without unions and rebuilds after a geometry change", () => {
  const element = {
    ...indexedStroke(1),
    points: Array.from({ length: 512 }, (_, i) => [i, 20 + (i % 7), 0.5]).flat(),
  };
  const geometry = buildElementPathParts(element);
  const store = new ElementStore([element]);
  const port = store.pressureGeometry(element.id, store.get(element.id)!.geometryVersion);
  port.publishPath!(geometry);
  const union = vi.spyOn(pressureUnion, "iteratePressureUnion");
  const sceneStore = new ElementSceneStore(store);
  const first = createSceneFixture(createWorkerSnapshot([]).page, sceneStore);
  first.scheduler.runAll();
  expect(union).not.toHaveBeenCalled();
  expect(
    fakeNode(first.renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!.nodes[0]!.attributes.get("d"),
  ).toBe(geometry[0]!.d);
  first.renderer.destroy();
  store.replace(element.id, { ...element, rotation: 30 });
  port.publishPath!(geometry);
  const second = createSceneFixture(createWorkerSnapshot([]).page, sceneStore);
  second.scheduler.runAll();
  expect(union).toHaveBeenCalled();
  second.renderer.destroy();
  sceneStore.release();
  union.mockRestore();
});

it("remounts retained rotated local contours after movement without point or union work", () => {
  const element = {
    ...indexedStroke(1),
    rotation: 37,
    points: Array.from({ length: 128 }, (_, i) => [
      30 + i / 4,
      roundCanonical(30 + Math.sin(i / 8)),
      0.5,
    ]).flat(),
    pivot: { x: 46, y: 30 },
  };
  const store = new ElementStore([element]);
  const source = store.get(element.id)!;
  const old = store.pressureGeometry(source.element.id, source.geometryVersion);
  const job = new ProgressivePreviewPath(source.element as StrokeElementV1, old);
  while (!job.stepOperation()) {
    /* The production preparation publishes only complete paths. */
  }
  const prepared = job.parts!;
  const samples = vi.spyOn(strokePath, "strokeCenterAt");
  const union = vi.spyOn(pressureUnion, "iteratePressureUnion");
  const sceneStore = new ElementSceneStore(store);
  const moved = translatedStroke(source.element as StrokeElementV1, { x: 12.007, y: 0.003 });
  store.replace(source.element.id, moved);
  const scene = createSceneFixture(createWorkerSnapshot([]).page, sceneStore);
  try {
    scene.scheduler.runAll();
    const group = fakeNode(scene.renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!;
    const path = group.nodes[0]!;
    expect(path.attributes.get("d")).toBe(prepared[0]!.d);
    expect(group.attributes.get("transform")).toBe("translate(12.007 0.003)");
    expect(samples).not.toHaveBeenCalled();
    expect(union).not.toHaveBeenCalled();
    expect(old.readPath!()).toBeUndefined();
    expect([...store.preparedPressurePaths()]).toHaveLength(1);
  } finally {
    scene.renderer.destroy();
    sceneStore.release();
    samples.mockRestore();
    union.mockRestore();
    job.cancel();
    store.releasePreparedPressureGeometry();
  }
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
});
