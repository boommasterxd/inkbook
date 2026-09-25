import { expect, it, vi } from "vitest";
import * as pressureUnion from "../../../../src/domain/geometry/pressure-union";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { ElementStore } from "../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { fakeNode } from "../../../unit/rendering/scene/fakes";

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
