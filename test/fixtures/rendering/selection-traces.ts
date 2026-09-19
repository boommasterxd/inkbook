import { calculateElementBounds } from "../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { createSceneFixture } from "./scene";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import { FakeSceneStore, fakeNode, type FakeNode } from "../../unit/rendering/scene/fakes";

export function createSelectionTraceFixture(elements: readonly InkElementV1[]) {
  const store = new FakeSceneStore();
  for (const [rank, element] of elements.entries()) {
    store.records.set(element.id, {
      element,
      rank,
      id: element.id,
      band:
        element.kind === "straight-highlighter" ||
        (element.kind === "stroke" && element.tool === "highlighter")
          ? "highlight"
          : "content",
      bounds: calculateElementBounds(element),
      geometryVersion: 1,
      paintVersion: 1,
    });
  }
  const { renderer, scheduler } = createSceneFixture(createSnapshot().page, store);
  scheduler.runAll();
  const nodes = () => selectionTraceNodes(fakeNode(renderer.svg));
  const select = (ids = elements.map(({ id }) => id)) => {
    renderer.setSelectedElements(new Set(ids));
    scheduler.runAll();
    return nodes();
  };
  return { renderer, scheduler, store, nodes, select };
}

export function selectionTraceNodes(root: FakeNode): FakeNode[] {
  if (root.attributes.has("data-selection-element-id")) return [root];
  return root.nodes.flatMap(selectionTraceNodes);
}

export function selectionHaloPaths(root: FakeNode): FakeNode[] {
  if (root.attributes.get("class") === "inkbook-selection-halo-path") return [root];
  return root.nodes.flatMap(selectionHaloPaths);
}

export function selectionTraceGeometry(root: FakeNode): string {
  return selectionHaloPaths(root)
    .map((node) => node.attributes.get("d") ?? "")
    .join("");
}

export function selectionTraceTransform(root: FakeNode): string {
  return selectionHaloPaths(root)[0]?.parent?.attributes.get("transform") ?? "";
}

export function selectionHaloNodes(root: FakeNode): FakeNode[] {
  return [root, ...root.nodes.flatMap(selectionHaloNodes)];
}
