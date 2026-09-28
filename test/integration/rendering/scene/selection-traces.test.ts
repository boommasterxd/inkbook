import { describe, expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { fakeNode } from "../../../unit/rendering/scene/fakes";
import { moveSelection, scaleElement } from "../../../../src/editor/selection/transforms";
import {
  createSelectionTraceFixture,
  selectionTraceGeometry,
  selectionTraceTransform,
  selectionCenterPaths,
  selectionHaloNodes,
} from "../../../fixtures/rendering/selection-traces";
import { createAllElementSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { coordinateSystem, table } from "../../../unit/domain/geometry/fixtures";
import { rectangle, stroke } from "../../../unit/domain/schema/fixtures";

describe("retained selection traces", () => {
  it("retains one canonical center path for every selected annotation family", () => {
    const elements = createAllElementSnapshot().elements;
    const { renderer, select } = createSelectionTraceFixture(elements);
    const traces = select();
    expect(traces.map((node) => node.attributes.get("data-selection-element-id")).sort()).toEqual(
      elements.map(({ id }) => id).sort(),
    );
    for (const element of elements) {
      const root = traces.find(
        (node) => node.attributes.get("data-selection-element-id") === element.id,
      )!;
      expect(root.tagName).toBe("path");
      expect(root.nodes).toHaveLength(0);
      expect(selectionCenterPaths(root)).toHaveLength(1);
      expect(selectionTraceGeometry(root), element.kind).toBeTruthy();
      if (element.kind !== "arrow" && !(element.kind === "stroke" && element.style.pressureEnabled))
        expect(selectionTraceGeometry(root)).toBe(
          buildElementPathParts(element)
            .map(({ d }) => d)
            .join(""),
        );
    }
    renderer.destroy();
  });

  it("follows the smoothed pressure centerline without outlining its variable thickness", () => {
    const source = { ...stroke(), points: [100, 100, 0.1, 110, 120, 1, 120, 100, 0.4] };
    const { renderer, select } = createSelectionTraceFixture([source]);
    const [trace] = select();
    expect(selectionTraceGeometry(trace!)).toBe("M100 100L110 110L120 100");
    expect(selectionCenterPaths(trace!)).toHaveLength(1);
    renderer.destroy();
  });

  it("traces every table line and all coordinate axes in the same multi-selection", () => {
    const source = table();
    const axes = coordinateSystem("3d");
    const { renderer, select } = createSelectionTraceFixture([source, axes]);
    const roots = select();
    const compact = (path: string) => path.replace(/\s+/gu, "");
    const tablePath = compact(
      selectionTraceGeometry(
        roots.find((root) => root.attributes.get("data-selection-element-id") === source.id)!,
      ),
    );
    for (const segment of ["M10 50L160 50", "M60 20L60 120", "M110 20L110 120"])
      expect(tablePath).toContain(compact(segment));
    const axesPath = compact(
      selectionTraceGeometry(
        roots.find((root) => root.attributes.get("data-selection-element-id") === axes.id)!,
      ),
    );
    for (const segment of ["M100 100L200 100", "M100 100L100 0", "M100 100L50 150"])
      expect(axesPath).toContain(compact(segment));
    renderer.destroy();
  });
});

describe("selection trace lifecycle", () => {
  it("keeps trace nodes with camera and preview transforms and releases them on clear and culling", () => {
    const source = rectangle();
    const { renderer, scheduler, select, nodes } = createSelectionTraceFixture([source]);
    const [trace] = select();
    const d = selectionTraceGeometry(fakeNode(renderer.svg));
    renderer.setCamera({ x: 10, zoom: 2 });
    renderer.setPreviewTransform([source.id], "translate(5 7)", 1);
    scheduler.runAll();
    expect(nodes()).toEqual([trace]);
    expect(selectionTraceGeometry(fakeNode(renderer.svg))).toBe(d);
    expect(selectionTraceTransform(fakeNode(renderer.svg))).toContain("translate(5 7)");
    renderer.clearPreviewTransforms();
    scheduler.runAll();
    expect(selectionTraceTransform(fakeNode(renderer.svg)) ?? "").not.toContain("translate(5 7)");
    renderer.setCamera({ x: -5000, zoom: 1 });
    scheduler.runAll();
    expect(nodes()).toEqual([]);
    expect(trace!.parent).toBeUndefined();
    renderer.setCamera({ x: 0, zoom: 1 });
    scheduler.runAll();
    expect(nodes()).toHaveLength(1);
    select([]);
    expect(nodes()).toEqual([]);
    renderer.destroy();
  });

  it.each([rectangle(), stroke()])(
    "updates $kind traces with exact previews and restores canonical geometry when cancelled",
    (source) => {
      const { renderer, scheduler, select } = createSelectionTraceFixture([source]);
      select();
      const d = selectionTraceGeometry(fakeNode(renderer.svg));
      renderer.setElementPreviews(moveSelection([source], { x: 20, y: 30 }), 1);
      scheduler.runAll();
      if (source.kind === "stroke") {
        expect(selectionTraceGeometry(fakeNode(renderer.svg))).toBe(d);
        expect(selectionTraceTransform(fakeNode(renderer.svg))).toBe("translate(20 30)");
      } else expect(selectionTraceGeometry(fakeNode(renderer.svg))).not.toBe(d);
      renderer.clearElementPreviews();
      scheduler.runAll();
      expect(selectionTraceGeometry(fakeNode(renderer.svg))).toBe(d);
      expect(selectionTraceTransform(fakeNode(renderer.svg))).toBe("");
      renderer.destroy();
    },
  );
});

describe("selection highlight setting", () => {
  it("preserves only line and arrow centers when highlights are disabled", () => {
    const elements = createAllElementSnapshot().elements;
    const { renderer, scheduler, select, nodes } = createSelectionTraceFixture(elements);
    const selectedRoots = select();
    const centers = selectedRoots
      .filter((root) =>
        elements.some(
          (element) =>
            (element.kind === "line" || element.kind === "arrow") &&
            element.id === root.attributes.get("data-selection-element-id"),
        ),
      )
      .flatMap(selectionHaloNodes)
      .filter((node) => node.attributes.get("class") === "inkbook-selection-center-trace");
    renderer.setSelectionHighlightsEnabled(false);
    scheduler.runAll();
    expect(
      nodes()
        .map((node) => node.attributes.get("data-selection-element-id"))
        .sort(),
    ).toEqual(
      elements
        .filter((element) => element.kind === "line" || element.kind === "arrow")
        .map(({ id }) => id)
        .sort(),
    );
    expect(selectionCenterPaths(fakeNode(renderer.svg))).toEqual(centers);
    expect(nodes().flatMap(selectionHaloNodes)).toHaveLength(centers.length);
    expect(
      nodes()
        .flatMap(selectionHaloNodes)
        .filter((node) => node.attributes.get("class") === "inkbook-selection-center-trace"),
    ).toEqual(centers);
    renderer.setSelectionHighlightsEnabled(true);
    scheduler.runAll();
    for (const center of centers)
      expect(selectionCenterPaths(fakeNode(renderer.svg))).toContain(center);
    expect(nodes()).toHaveLength(elements.length);
    renderer.destroy();
  });

  it.each([rectangle(), stroke()])(
    "re-enables the displayed $kind preview and restores the baseline on cancellation",
    (source) => {
      const { renderer, scheduler, select, nodes } = createSelectionTraceFixture([source]);
      select();
      const baseline = selectionTraceGeometry(fakeNode(renderer.svg));
      renderer.setElementPreviews(moveSelection([source], { x: 20, y: 30 }), 1);
      scheduler.runAll();
      const preview = selectionTraceGeometry(fakeNode(renderer.svg));
      if (source.kind === "stroke") {
        expect(preview).toBe(baseline);
        expect(selectionTraceTransform(fakeNode(renderer.svg))).toBe("translate(20 30)");
      } else expect(preview).not.toBe(baseline);
      renderer.setSelectionHighlightsEnabled(false);
      scheduler.runAll();
      expect(nodes()).toEqual([]);
      renderer.setSelectionHighlightsEnabled(true);
      scheduler.runAll();
      expect(selectionTraceGeometry(fakeNode(renderer.svg))).toBe(preview);
      renderer.clearElementPreviews();
      scheduler.runAll();
      expect(selectionTraceGeometry(fakeNode(renderer.svg))).toBe(baseline);
      expect(selectionTraceTransform(fakeNode(renderer.svg))).toBe("");
      renderer.destroy();
    },
  );
});

it("re-enables pressure highlights during both progressive feedback and materialized resize", () => {
  const source = stroke();
  const { renderer, scheduler, select } = createSelectionTraceFixture([source]);
  select();
  const baseline = selectionTraceGeometry(fakeNode(renderer.svg));
  renderer.setSelectionHighlightsEnabled(false);
  scheduler.runAll();
  const resized = scaleElement(source, { x: 0, y: 0 }, { x: 2, y: 1 });
  renderer.setProgressiveElementPreviews([source.id], () => resized, 1, {
    transform: "scale(2 1)",
    inverse: "scale(0.5 1)",
  });
  renderer.flushPointerFeedbackFrame();
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  const resizedPath = selectionTraceGeometry(fakeNode(renderer.svg));
  expect(resizedPath).not.toBe(baseline);
  renderer.setSelectionHighlightsEnabled(false);
  scheduler.runAll();
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  expect(selectionTraceGeometry(fakeNode(renderer.svg))).toBe(resizedPath);
  renderer.clearProgressiveElementPreviews();
  scheduler.runAll();
  expect(selectionTraceGeometry(fakeNode(renderer.svg))).toBe(baseline);
  renderer.destroy();
});

it("clears selected centers and cancels pending mounting on destroy", () => {
  const elements = Array.from({ length: 100 }, (_, index) => ({
    ...rectangle(index + 100),
    x: 20 + (index % 10) * 30,
    y: 20 + Math.floor(index / 10) * 30,
    width: 20,
    height: 20,
  }));
  const { renderer, scheduler, select, nodes } = createSelectionTraceFixture(elements);
  const roots = select();
  expect(nodes()).toHaveLength(100);
  const group = roots[0]!.parent!;
  const parent = group.parent!;
  const siblings = [...parent.nodes];
  renderer.setSelectedElements(new Set());
  scheduler.runAll();
  expect(nodes()).toEqual([]);
  expect(parent.nodes).toEqual(siblings);
  expect(roots.every((root) => root.parent === undefined)).toBe(true);
  renderer.setSelectedElements(new Set(elements.map(({ id }) => id)));
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
  expect(selectionCenterPaths(fakeNode(renderer.svg))).toEqual([]);
});

it("restores the selection group when a trace removal fails", () => {
  const elements = Array.from({ length: 40 }, (_, index) => ({
    ...rectangle(index + 200),
    x: index * 20,
    y: 20,
    pivot: { x: index * 20 + 10, y: 30 },
  }));
  const { renderer, scheduler, select } = createSelectionTraceFixture(elements);
  const roots = select();
  const group = roots[0]!.parent!;
  const parent = group.parent!;
  const siblings = [...parent.nodes];
  const remove = vi.spyOn(roots[10]!, "remove").mockImplementationOnce(() => {
    throw new Error("trace removal failed");
  });
  renderer.setSelectedElements(new Set());
  expect(() => scheduler.runNext()).toThrow("trace removal failed");
  expect(parent.nodes).toEqual(siblings);
  expect(group.parent).toBe(parent);
  remove.mockRestore();
  renderer.destroy();
  expect(group.nodes).toEqual([]);
  expect(scheduler.pendingCount).toBe(0);
});
