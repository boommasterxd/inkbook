import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSelectionTraceFixture,
  selectionCenterPaths,
  selectionHaloNodes,
  selectionTraceGeometry,
} from "../../../fixtures/rendering/selection-traces";
import { arrow, rectangle, stroke } from "../../../unit/domain/schema/fixtures";
import { coordinateSystem } from "../../../unit/domain/geometry/fixtures";
import { connectedLine } from "../../../unit/domain/store/fixtures";
import { fakeNode } from "../../../unit/rendering/scene/fakes";
import { decodeSvgPathCommands } from "../../../fixtures/domain/svg-path-fill";

afterEach(() => vi.restoreAllMocks());

it("paints one opaque solid center indicator per selected element without filters or clipping", () => {
  const source = stroke();
  source.style = { ...source.style, opacity: 0.2, color: { type: "rgba", value: "#FF000040" } };
  const { renderer, select } = createSelectionTraceFixture([source, rectangle()]);
  select();
  const scene = fakeNode(renderer.svg);
  expect(
    selectionHaloNodes(scene).filter(
      ({ tagName }) => tagName === "filter" || tagName === "clipPath",
    ),
  ).toEqual([]);
  const centers = selectionCenterPaths(scene);
  expect(centers).toHaveLength(2);
  for (const center of centers) {
    expect(Object.fromEntries(center.attributes)).toMatchObject({
      fill: "none",
      "stroke-width": "1.5",
      "vector-effect": "non-scaling-stroke",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    expect(center.attributes.get("opacity") ?? "1").toBe("1");
    expect(center.attributes.get("stroke-opacity") ?? "1").toBe("1");
    expect(center.attributes.has("stroke-dasharray")).toBe(false);
  }
  renderer.destroy();
});

it("retains center geometry and fixed screen width through camera and affine preview changes", () => {
  const source = stroke();
  const { renderer, scheduler, select } = createSelectionTraceFixture([source]);
  select();
  const scene = fakeNode(renderer.svg);
  const center = selectionCenterPaths(scene)[0]!;
  const geometry = selectionTraceGeometry(scene);
  const writes = vi.spyOn(center, "setAttribute");
  renderer.resetInstrumentation();
  renderer.setCamera({ x: 0, zoom: 2 });
  renderer.setPreviewTransform([source.id], "scale(2 0.5)", 1, "preserve");
  renderer.flushPointerFeedbackFrame();
  expect(center.attributes.get("stroke-width")).toBe("1.5");
  expect(center.attributes.get("vector-effect")).toBe("non-scaling-stroke");
  expect(selectionTraceGeometry(scene)).toBe(geometry);
  expect(center.attributes.get("transform")).toBe("scale(2 0.5)");
  expect(writes.mock.calls.some(([name]) => name === "d")).toBe(false);
  expect(renderer.instrumentation().geometryBuilds).toBe(0);
  expect(renderer.instrumentation().selectionTraceGeometryBuilds).toBe(0);
  renderer.clearPreviewTransforms();
  scheduler.runAll();
  expect(center.attributes.has("transform")).toBe(false);
  expect(selectionTraceGeometry(scene)).toBe(geometry);
  renderer.destroy();
});

describe("center indicator paint", () => {
  it("ignores shape fill, outline thickness and dashes without rewriting its center contour", () => {
    const source = rectangle();
    source.style = { ...source.style, fillColor: { type: "rgba", value: "#FF0000FF" } };
    const { renderer, scheduler, select, store } = createSelectionTraceFixture([source]);
    select();
    const center = selectionCenterPaths(fakeNode(renderer.svg))[0]!;
    const geometry = center.attributes.get("d");
    const writes = vi.spyOn(center, "setAttribute");
    const record = store.get(source.id)!;
    store.records.set(source.id, {
      ...record,
      element: { ...source, style: { ...source.style, outlineWidth: 8, outlineStyle: "dashed" } },
      paintVersion: 2,
    });
    renderer.resetInstrumentation();
    renderer.applyDelta({ affected: [{ id: source.id, domains: ["paint"] }] });
    scheduler.runAll();
    expect(center.attributes.get("fill")).toBe("none");
    expect(center.attributes.get("stroke-width")).toBe("1.5");
    expect(center.attributes.has("stroke-dasharray")).toBe(false);
    expect(center.attributes.get("d")).toBe(geometry);
    expect(writes.mock.calls.some(([name]) => name === "d")).toBe(false);
    expect(renderer.instrumentation().geometryBuilds).toBe(0);
    renderer.destroy();
  });

  it("retains a round center dot for a degenerate dotted line", () => {
    const source = connectedLine();
    source.end = source.start;
    source.bend = null;
    source.style = { ...source.style, outlineStyle: "dotted", outlineWidth: 1 };
    const { renderer, select } = createSelectionTraceFixture([source]);
    const [root] = select();
    const center = selectionCenterPaths(root!)[0]!;
    expect(decodeSvgPathCommands(center.attributes.get("d")!)).toEqual([
      { command: "M", values: [source.start.x, source.start.y] },
      { command: "L", values: [source.start.x, source.start.y] },
    ]);
    expect(center.attributes.get("stroke-linecap")).toBe("round");
    expect(center.attributes.get("stroke-width")).toBe("1.5");
    expect(center.attributes.has("stroke-dasharray")).toBe(false);
    renderer.destroy();
  });

  it("traces filled arrow node centers without their paint expansion", () => {
    const source = { ...arrow(), endNode: "triangle" as const };
    const { renderer, select } = createSelectionTraceFixture([source]);
    const [root] = select();
    const commands = decodeSvgPathCommands(selectionTraceGeometry(root!));
    const arcs = commands.filter(({ command }) => command === "A");
    expect(arcs).toHaveLength(2);
    for (const arc of arcs) expect(arc.values.slice(0, 2)).toEqual([6, 6]);
    const endpoints = commands
      .filter(({ values }) => values.length > 0)
      .map(({ values }) => values.slice(-2));
    expect(Math.min(...endpoints.map(([x]) => x!))).toBe(source.start.x);
    expect(Math.max(...endpoints.map(([x]) => x!))).toBe(source.end.x);
    expect(selectionCenterPaths(root!)[0]!.attributes.get("fill")).toBe("none");
    renderer.destroy();
  });
});

it.each(["arrow", "2d", "3d"] as const)(
  "keeps %s heads and shaft centers solid across dash-style changes",
  (kind) => {
    const source =
      kind === "arrow"
        ? { ...arrow(), startNode: "arrow" as const, endNode: "arrow" as const }
        : coordinateSystem(kind);
    const { renderer, scheduler, store, select } = createSelectionTraceFixture([source]);
    const [root] = select();
    const center = selectionCenterPaths(root!)[0]!;
    const geometry = selectionTraceGeometry(root!);
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
      expect(selectionCenterPaths(root!)).toEqual([center]);
      expect(selectionTraceGeometry(root!)).toBe(geometry);
      expect(center.attributes.has("stroke-dasharray")).toBe(false);
    }
    renderer.destroy();
  },
);
