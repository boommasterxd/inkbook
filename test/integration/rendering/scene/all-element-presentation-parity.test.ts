import { describe, expect, it } from "vitest";

import {
  buildElementPathParts,
  calculateElementBounds,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { SelectionHandlePresentation } from "../../../../src/obsidian/embeds/active-editor/handle-presentation";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import {
  pathPresentation,
  PRESENTATION_ATTRIBUTES,
} from "../../../../src/rendering/scene/element-presentation";
import { createAllElementSnapshot, uuid } from "../../../unit/persistence/serialization/fixtures";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";

const cases = elementCases().map((element) => ({ element, name: caseName(element) }));

describe("canonical presentation across every element type", () => {
  it.each(cases)(
    "preserves $name from preview through multi-selection transforms",
    ({ element }) => {
      const { renderer, scheduler, selected, band } = setup(element);
      scheduler.runAll();
      const camera = fakeNode(renderer.svg).nodes[1]!;
      const paintedGroup = camera.nodes[band === "highlight" ? 3 : 4]!;
      const liveGroup = camera.nodes[5]!;
      const retainedNodes = [...paintedGroup.nodes];
      const committed = retainedNodes.flatMap(paintedPaths).map(paintedAttributes);
      const parts = buildElementPathParts(element);

      renderer.setLivePath({
        band,
        parts: parts.map((part) => ({ d: part.d, presentation: pathPresentation(element, part) })),
      });
      scheduler.runAll();
      expect(liveGroup.nodes.map(paintedAttributes)).toEqual(committed.slice(0, parts.length));
      renderer.setLivePath(null);
      scheduler.runAll();

      const selection = new SelectionHandlePresentation(
        renderer,
        (point) => point,
        () => 1,
      );
      for (const geometry of [selected.slice(0, 1), selected]) {
        selection.renderGeometry(geometry, null);
        scheduler.runAll();
        expect(paintedGroup.nodes).toEqual(retainedNodes);
        expect(paintedGroup.nodes.flatMap(paintedPaths).map(paintedAttributes)).toEqual(committed);
      }
      for (const transform of [
        { kind: "translate" as const, delta: { x: 23, y: -17 } },
        { kind: "rotate" as const, center: { x: 400, y: 300 }, degrees: 31 },
      ]) {
        selection.renderTransform(
          selected.map(({ element: item }) => item.id),
          transform,
        );
        scheduler.runAll();
        expect(paintedGroup.nodes.flatMap(paintedPaths).map(paintedAttributes)).toEqual(committed);
        expect(paintedGroup.nodes.every((node) => node.attributes.has("transform"))).toBe(true);
      }
      selection.dispose();
      scheduler.runAll();
      expect(paintedGroup.nodes).toEqual(retainedNodes);
      expect(paintedGroup.nodes.flatMap(paintedPaths).map(paintedAttributes)).toEqual(committed);
      expect(paintedGroup.nodes.every((node) => !node.attributes.has("transform"))).toBe(true);
      renderer.destroy();
    },
  );
});

function paintedPaths(node: FakeNode): readonly FakeNode[] {
  return node.tagName === "g" ? node.nodes : [node];
}

function paintedAttributes(node: FakeNode): ReadonlyMap<string, string | null> {
  return new Map(
    ["d", ...PRESENTATION_ATTRIBUTES].map((name) => [name, node.attributes.get(name) ?? null]),
  );
}

function setup(element: InkElementV1) {
  const snapshot = createAllElementSnapshot();
  const band =
    element.kind === "straight-highlighter" ||
    (element.kind === "stroke" && element.tool === "highlighter")
      ? "highlight"
      : "content";
  const scheduler = new FakeScheduler();
  const document = new FakeDocument();
  const store = new FakeSceneStore();
  const selected = [element, { ...element, id: uuid(100) }].map((item, rank) => {
    const bounds = calculateElementBounds(item);
    store.records.set(item.id, {
      band,
      bounds,
      element: item,
      geometryVersion: 1,
      id: item.id,
      paintVersion: 1,
      rank,
    });
    return { bounds, element: item };
  });
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 1200, left: 0, top: 0, width: 2048.6 }) },
    page: snapshot.page,
    scheduler,
    store,
  });
  renderer.setPage(snapshot.page, 1200);
  return { band, renderer, scheduler, selected } as const;
}

function elementCases(): InkElementV1[] {
  return createAllElementSnapshot().elements.flatMap((element): InkElementV1[] => {
    if (element.kind === "stroke") {
      return [
        element,
        { ...element, style: { ...element.style, pressureEnabled: false } },
        {
          ...element,
          tool: "highlighter",
          style: { ...element.style, pressureEnabled: false, width: 22 },
        },
      ];
    }
    if ("outlineStyle" in element.style) {
      return (["solid", "dashed", "dotted"] as const).map(
        (outlineStyle) =>
          ({
            ...element,
            style: { ...element.style, outlineStyle },
          }) as InkElementV1,
      );
    }
    return [element];
  });
}

function caseName(element: InkElementV1): string {
  if (element.kind === "stroke")
    return `${element.tool} (pressure ${String(element.style.pressureEnabled)})`;
  return "outlineStyle" in element.style
    ? `${element.kind} (${element.style.outlineStyle})`
    : element.kind;
}
