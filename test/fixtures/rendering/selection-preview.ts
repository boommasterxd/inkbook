import { renderBandOf } from "../../../src/domain/commands/render-bands";
import { calculateElementBounds } from "../../../src/domain/geometry/public";
import { indexedStroke } from "../editor/stroke";
import { createAllElementSnapshot } from "../../unit/persistence/serialization/fixtures";
import { FakeSceneStore, fakeNode } from "../../unit/rendering/scene/fakes";
import { createSceneFixture } from "./scene";

export function createDenseSelectionPreview(count: number, pressureEnabled = true) {
  const store = new FakeSceneStore();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const stroke = indexedStroke(index);
    const element = {
      ...stroke,
      points: [20, 20, 0.5, 22, 22, 0.75],
      pivot: { x: 21, y: 21 },
      tool: index % 2 === 0 ? ("highlighter" as const) : ("pen" as const),
      style: { ...stroke.style, pressureEnabled },
    };
    ids.push(element.id);
    store.records.set(element.id, {
      band: renderBandOf(element),
      bounds: calculateElementBounds(element),
      element,
      geometryVersion: 1,
      id: element.id,
      paintVersion: 1,
      rank: index,
    });
    if (index % 50 === 0) {
      const unselected = { ...element, id: indexedStroke(10_000 + index).id };
      store.records.set(unselected.id, {
        ...store.records.get(element.id)!,
        element: unselected,
        id: unselected.id,
        rank: index + 0.5,
      });
    }
  }
  const scene = createSceneFixture(createAllElementSnapshot().page, store);
  scene.scheduler.runAll();
  const camera = fakeNode(scene.renderer.svg).nodes[1]!;
  const selected = new Set(ids);
  const nodes = new Map<string, ReturnType<typeof fakeNode>>();
  for (const [band, group] of [
    ["highlight", camera.nodes[3]!],
    ["content", camera.nodes[4]!],
  ] as const) {
    const records = [...store.records.values()].filter((record) => record.band === band);
    records.sort((left, right) => left.rank - right.rank);
    for (const [index, record] of records.entries()) nodes.set(record.id, group.nodes[index]!);
  }
  const selectedNodes = [...nodes].filter(([id]) => selected.has(id)).map(([, node]) => node);
  const untouched = [...nodes].filter(([id]) => !selected.has(id)).map(([, node]) => node);
  return { ...scene, ids, nodes, selectedNodes, untouched, store };
}
