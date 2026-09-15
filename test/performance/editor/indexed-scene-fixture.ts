import type { ElementStore } from "../../../src/domain/store/public";
import type { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EraserSweep } from "../../../src/editor/gestures/public";
import { indexedStroke } from "../../fixtures/editor/stroke";

export function createIndexedStrokeScene(
  storeClass: typeof ElementStore,
  sceneClass: typeof ElementSceneStore,
) {
  const store = new storeClass(Array.from({ length: 10_000 }, (_, index) => indexedStroke(index)));
  return { store, sceneStore: new sceneClass(store) };
}

export function createIndexedEraser(
  eraserClass: typeof EraserSweep,
  sceneStore: ElementSceneStore,
) {
  return new eraserClass(
    { x: 20, y: 20 },
    4,
    {
      getElement: (id) => sceneStore.get(id)?.element,
      query: (bounds, sink) => sceneStore.query(bounds, sink),
    },
    {
      addCandidateFade: () => undefined,
      clearCandidateFade: () => undefined,
      setCandidateFade: () => undefined,
    },
  );
}
