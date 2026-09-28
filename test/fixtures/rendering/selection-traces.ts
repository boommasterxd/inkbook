import { buildElementPathParts, type SvgPathPart } from "../../../src/domain/geometry/element-path";
import { calculateElementBounds } from "../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { createSceneFixture } from "./scene";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import { FakeSceneStore, fakeNode, type FakeNode } from "../../unit/rendering/scene/fakes";

/** Selection scenarios begin from validated mounted paths, independently of cold loading. */
class SelectionTraceStore extends FakeSceneStore {
  public readonly prepared = new Map<string, readonly SvgPathPart[]>();

  public pressureGeometry(id: string, version: number) {
    return {
      readPath: () => (version === 1 ? this.prepared.get(id) : undefined),
      readWindow: () => undefined,
      publishWindow: () => undefined,
    };
  }
}

export function createSelectionTraceFixture(elements: readonly InkElementV1[]) {
  const store = new SelectionTraceStore();
  for (const [rank, element] of elements.entries()) {
    if (
      element.kind === "stroke" &&
      element.style.pressureEnabled &&
      element.points.length > 256 * 3
    )
      store.prepared.set(element.id, buildElementPathParts(element));
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

export function selectionTraceGeometry(root: FakeNode): string {
  return selectionCenterPaths(root)
    .map((node) => node.attributes.get("d") ?? "")
    .join("");
}

export function selectionTraceTransform(root: FakeNode): string {
  return selectionCenterPaths(root)[0]?.attributes.get("transform") ?? "";
}

export function selectionCenterPaths(root: FakeNode): FakeNode[] {
  if (root.attributes.get("class") === "inkbook-selection-center-trace") return [root];
  return root.nodes.flatMap(selectionCenterPaths);
}

export function selectionHaloNodes(root: FakeNode): FakeNode[] {
  return [root, ...root.nodes.flatMap(selectionHaloNodes)];
}
