import { createIndexedStrokeScene } from "../editor/indexed-scene-fixture";
import type { ComparisonImplementation } from "./contracts";

export function indexedEditorScene(implementation: ComparisonImplementation) {
  const { ElementStore } =
    implementation.get<typeof import("../../../src/domain/store/public")>("domain/store/public");
  const { ElementSceneStore } = implementation.get<
    typeof import("../../../src/obsidian/embeds/active-editor/scene-store")
  >("obsidian/embeds/active-editor/scene-store");
  return createIndexedStrokeScene(ElementStore, ElementSceneStore);
}
