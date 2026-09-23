import { selectionOverlayGeometry } from "../../../../src/editor/selection/public";
import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import { SelectionHandlePresentation } from "../../../../src/obsidian/embeds/active-editor/handle-presentation";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";

describe("pressure stroke selection parity", () => {
  it("retains identical painted paths through multi-selection, move, rotation, and deselection", () => {
    const { renderer, scheduler, selected } = setup();
    scheduler.runAll();
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const original = content.nodes.map((node) => new Map(node.attributes));
    const presentation = new SelectionHandlePresentation(
      renderer,
      (point) => point,
      () => 1,
    );

    presentation.renderGeometry(selected, selectionOverlayGeometry(selected, 1));
    scheduler.runAll();
    expect(content.nodes.map((node) => node.attributes)).toEqual(original);

    for (const transform of [
      { kind: "translate" as const, delta: { x: 10, y: 20 } },
      { kind: "rotate" as const, center: { x: 40, y: 40 }, degrees: 45 },
    ]) {
      presentation.renderTransform(
        selected.map(({ element }) => element.id),
        transform,
      );
      scheduler.runAll();
      for (const [index, node] of content.nodes.entries()) {
        const painted = new Map(node.attributes);
        expect(painted.delete("transform")).toBe(true);
        expect(painted).toEqual(original[index]);
      }
    }

    presentation.clearPreviews();
    presentation.renderGeometry([], null);
    scheduler.runAll();
    expect(content.nodes.map((node) => node.attributes)).toEqual(original);
    renderer.destroy();
  });
});

function setup() {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  const selected = [1, 2].map((index) => {
    const base = indexedStroke(index);
    const element = {
      ...base,
      points: [20, 20, 0.2, 21, 40, 1, 22, 20, 0.8, 23, 40, 1, 24, 20, 0.1],
      style: { ...base.style, width: 8 as const },
    };
    const bounds = calculateElementBounds(element);
    store.records.set(element.id, {
      band: "content",
      bounds,
      element,
      geometryVersion: 1,
      id: element.id,
      paintVersion: 1,
      rank: index,
    });
    return { bounds, element };
  });
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    scheduler,
    store,
  });
  return { renderer, scheduler, selected };
}
