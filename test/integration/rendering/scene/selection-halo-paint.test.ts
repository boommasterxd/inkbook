import { describe, expect, it, vi } from "vitest";

import {
  createSelectionTraceFixture,
  selectionHaloNodes,
  selectionHaloPaths,
} from "../../../fixtures/rendering/selection-traces";
import { arrow, rectangle, stroke } from "../../../unit/domain/schema/fixtures";
import { coordinateSystem } from "../../../unit/domain/geometry/fixtures";
import { connectedLine } from "../../../unit/domain/store/fixtures";
import { fakeNode } from "../../../unit/rendering/scene/fakes";
import type { ArrowElementV1 } from "../../../../src/domain/schema/public";

it("erodes one opaque union and removes its interior without painting outside the original ink", () => {
  const source = stroke();
  source.style = { ...source.style, opacity: 0.2, color: { type: "rgba", value: "#FF000040" } };
  const { renderer, select } = createSelectionTraceFixture([source, rectangle()]);
  const roots = select();
  const descendants = selectionHaloNodes(fakeNode(renderer.svg));
  const filters = descendants.filter(({ tagName }) => tagName === "filter");
  expect(filters).toHaveLength(1);
  expect(filters[0]!.attributes.get("filterUnits")).toBe("userSpaceOnUse");
  expect(filters[0]!.nodes.map(({ tagName }) => tagName)).toEqual(["feMorphology", "feComposite"]);
  expect(Object.fromEntries(filters[0]!.nodes[0]!.attributes)).toMatchObject({
    in: "SourceAlpha",
    operator: "erode",
    radius: "1.5",
    result: "interior",
  });
  expect(Object.fromEntries(filters[0]!.nodes[1]!.attributes)).toMatchObject({
    in: "SourceGraphic",
    in2: "interior",
    operator: "out",
  });
  const uses = descendants.filter(({ tagName }) => tagName === "use");
  expect(uses).toHaveLength(2);
  expect(uses[0]!.parent).toBe(uses[1]!.parent);
  for (const root of roots) {
    const path = selectionHaloPaths(root)[0]!;
    expect(path.attributes.has("fill-opacity")).toBe(false);
    expect(path.attributes.has("stroke-opacity")).toBe(false);
    const pressure = root.attributes.get("data-selection-element-id") === source.id;
    expect(path.attributes.get("fill")).toBe(pressure ? "currentColor" : "none");
    if (pressure) expect(path.attributes.get("stroke")).toBe("none");
  }
  renderer.destroy();
});

it("keeps one fixed-screen erosion region outside preview transforms", () => {
  const source = rectangle();
  const { renderer, scheduler, select } = createSelectionTraceFixture([source]);
  const [root] = select();
  const filter = selectionHaloNodes(fakeNode(renderer.svg)).find(
    ({ tagName }) => tagName === "filter",
  )!;
  expect(Number(filter.attributes.get("width"))).toBe(2048 + 6);
  renderer.setCamera({ x: 0, zoom: 2 });
  renderer.setPreviewTransform([source.id], "scale(2 0.5)", 1, "preserve");
  renderer.flushPointerFeedbackFrame();
  const halo = selectionHaloPaths(root!)[0]!;
  expect(halo.attributes.get("stroke-width")).toBe(String(source.style.outlineWidth * 2));
  expect(filter.nodes[0]!.attributes.get("radius")).toBe("0.75");
  expect(Number(filter.attributes.get("width"))).toBe((2048 + 6) / 2);
  expect(Number(filter.attributes.get("height"))).toBe((1000 + 6) / 2);
  expect(filter.attributes.has("transform")).toBe(false);
  expect(halo.parent!.attributes.get("transform")).toBe("scale(2 0.5)");
  renderer.clearPreviewTransforms();
  scheduler.runAll();
  expect(halo.parent!.attributes.has("transform")).toBe(false);
  renderer.destroy();
});

describe("inner edge paint updates", () => {
  it("uses only shape contour ink and updates width and dashes without rewriting geometry", () => {
    const source = rectangle();
    source.style = { ...source.style, fillColor: { type: "rgba", value: "#FF0000FF" } };
    const { renderer, scheduler, select, store } = createSelectionTraceFixture([source]);
    const [root] = select();
    const halo = selectionHaloPaths(root!)[0]!;
    expect(halo.attributes.get("fill")).toBe("none");
    const writes = vi.spyOn(halo, "setAttribute");
    const record = store.get(source.id)!;
    const after = {
      ...source,
      style: { ...source.style, outlineWidth: 8 as const, outlineStyle: "dashed" as const },
    };
    store.records.set(source.id, { ...record, element: after, paintVersion: 2 });
    renderer.applyDelta({ affected: [{ id: source.id, domains: ["paint"] }] });
    scheduler.runAll();
    expect(halo.attributes.get("stroke-width")).toBe("8");
    expect(halo.attributes.get("stroke-dasharray")).toBe("32 24");
    expect(halo.attributes.get("stroke-linecap")).toBe("round");
    expect(halo.attributes.get("fill")).toBe("none");
    expect(writes.mock.calls.some(([name]) => name === "d")).toBe(false);
    writes.mockRestore();
    renderer.destroy();
  });

  it("keeps thin point silhouettes unexpanded and preserves filled arrowheads and center traces", () => {
    const line = connectedLine();
    line.end = line.start;
    line.bend = null;
    line.style = { ...line.style, outlineStyle: "dotted", outlineWidth: 1 };
    const arrow: ArrowElementV1 = {
      ...connectedLine(),
      id: "arrow",
      kind: "arrow",
      startNode: "circle",
      endNode: "triangle",
    };
    const { renderer, select } = createSelectionTraceFixture([line, arrow]);
    const roots = select();
    const point = selectionHaloPaths(
      roots.find((root) => root.attributes.get("data-selection-element-id") === line.id)!,
    )[0]!;
    expect(point.attributes.get("stroke-linecap")).toBe("round");
    expect(point.attributes.get("stroke-width")).toBe("1");
    expect(point.attributes.has("stroke-dasharray")).toBe(false);
    for (const root of roots) {
      expect(
        selectionHaloNodes(root).filter(
          (node) => node.attributes.get("class") === "inkbook-selection-center-trace",
        ),
      ).toHaveLength(1);
    }
    const arrowPaths = selectionHaloPaths(
      roots.find((root) => root.attributes.get("data-selection-element-id") === arrow.id)!,
    );
    expect(arrowPaths).toHaveLength(2);
    expect(arrowPaths[1]!.attributes.get("fill")).toBe("currentColor");
    renderer.destroy();
  });
});

it.each(["arrow", "2d", "3d"] as const)(
  "retains %s head and shaft geometry through outline-style changes",
  (kind) => {
    const source =
      kind === "arrow"
        ? { ...arrow(), startNode: "arrow" as const, endNode: "arrow" as const }
        : coordinateSystem(kind);
    const { renderer, scheduler, store, select } = createSelectionTraceFixture([source]);
    const [root] = select();
    const paths = selectionHaloPaths(root!);
    const geometry = paths.map((path) => path.attributes.get("d"));
    const writes = paths.map((path) => vi.spyOn(path, "setAttribute"));
    expect(paths).toHaveLength(1);
    for (const [version, outlineStyle] of (
      ["solid", "dashed", "dotted", "solid"] as const
    ).entries()) {
      const record = store.get(source.id)!;
      store.records.set(source.id, {
        ...record,
        element: { ...source, style: { ...source.style, outlineStyle } },
        paintVersion: version + 2,
      });
      renderer.resetInstrumentation();
      renderer.applyDelta({ affected: [{ id: source.id, domains: ["paint"] }] });
      scheduler.runAll();
      expect(renderer.instrumentation().geometryBuilds).toBe(0);
      expect(selectionHaloPaths(root!)).toEqual(paths);
      expect(paths.map((path) => path.attributes.get("d"))).toEqual(geometry);
      expect(paths[0]!.attributes.has("stroke-dasharray")).toBe(outlineStyle !== "solid");
    }
    expect(writes.some((spy) => spy.mock.calls.some(([name]) => name === "d"))).toBe(false);
    writes.forEach((spy) => spy.mockRestore());
    renderer.destroy();
  },
);
