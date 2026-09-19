import { describe, expect, it } from "vitest";

import { buildStrokePathParts } from "../../../../src/domain/geometry/stroke-path";
import { moveSelection, scaleElement } from "../../../../src/editor/selection/transforms";
import {
  createSelectionTraceFixture,
  selectionTraceGeometry,
  selectionTraceTransform,
  selectionHaloPaths,
  selectionHaloNodes,
} from "../../../fixtures/rendering/selection-traces";
import { createAllElementSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { coordinateSystem, table } from "../../../unit/domain/geometry/fixtures";
import { rectangle, stroke } from "../../../unit/domain/schema/fixtures";

function compact(path: string | undefined): string {
  return (path ?? "").replace(/\s+/gu, "");
}

describe("retained selection traces", () => {
  it("retains canonical inner-edge sources for every selected annotation family", () => {
    const elements = createAllElementSnapshot().elements;
    const { renderer, select } = createSelectionTraceFixture(elements);
    const traces = select();
    expect(traces.map((node) => node.attributes.get("data-selection-element-id")).sort()).toEqual(
      elements.map(({ id }) => id).sort(),
    );
    for (const trace of traces) {
      expect(selectionTraceGeometry(trace)).toBeTruthy();
      expect(
        selectionHaloPaths(trace).every(
          (path) => path.attributes.get("vector-effect") === "non-scaling-stroke",
        ),
      ).toBe(true);
    }
    for (const kind of ["ellipse", "triangle", "octagon"] as const) {
      const element = elements.find((item) => item.kind === kind)!;
      const d = selectionTraceGeometry(
        traces.find((trace) => trace.attributes.get("data-selection-element-id") === element.id)!,
      );
      if (kind === "ellipse") expect(d.match(/C/gu)).toHaveLength(4);
      else expect(d.match(/L/gu)).toHaveLength(kind === "triangle" ? 2 : 7);
    }
    renderer.destroy();
  });

  it("reuses complete pressure silhouettes without rebuilding centerlines", () => {
    const source = stroke();
    const { renderer, select } = createSelectionTraceFixture([source]);
    const [trace] = select();
    const expected = buildStrokePathParts(source)
      .map(({ d }) => d)
      .join("");
    expect(selectionTraceGeometry(trace!)).toBe(expected);
    expect(
      selectionHaloNodes(trace!).some(
        (node) => node.attributes.get("class") === "inkbook-selection-center-trace",
      ),
    ).toBe(false);
    renderer.destroy();
  });

  it("traces every table line and all coordinate axes in the same multi-selection", () => {
    const source = table();
    const axes = coordinateSystem("3d");
    const { renderer, select } = createSelectionTraceFixture([source, axes]);
    const traces = select();
    const tablePath = compact(
      selectionTraceGeometry(
        traces.find((node) => node.attributes.get("data-selection-element-id") === source.id)!,
      ),
    );
    for (const segment of ["M10 50L160 50", "M60 20L60 120", "M110 20L110 120"]) {
      expect(tablePath).toContain(compact(segment));
    }
    const axesPath = compact(
      selectionTraceGeometry(
        traces.find((node) => node.attributes.get("data-selection-element-id") === axes.id)!,
      ),
    );
    for (const segment of ["M100 100L200 100", "M100 100L100 0", "M100 100L50 150"]) {
      expect(axesPath).toContain(compact(segment));
    }
    renderer.destroy();
  });
});

describe("selection trace lifecycle", () => {
  it("keeps trace nodes with camera and preview transforms and releases them on clear and culling", () => {
    const source = rectangle();
    const { renderer, scheduler, select, nodes } = createSelectionTraceFixture([source]);
    const [trace] = select();
    const d = selectionTraceGeometry(trace!);
    renderer.setCamera({ x: 10, zoom: 2 });
    renderer.setPreviewTransform([source.id], "translate(5 7)", 1);
    scheduler.runAll();
    expect(nodes()).toEqual([trace]);
    expect(selectionTraceGeometry(trace!)).toBe(d);
    expect(selectionTraceTransform(trace!)).toContain("translate(5 7)");
    renderer.clearPreviewTransforms();
    scheduler.runAll();
    expect(selectionTraceTransform(trace!) ?? "").not.toContain("translate(5 7)");
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
      const { renderer, scheduler, select, nodes } = createSelectionTraceFixture([source]);
      const [trace] = select();
      const d = selectionTraceGeometry(trace!);
      renderer.setElementPreviews(moveSelection([source], { x: 20, y: 30 }), 1);
      scheduler.runAll();
      expect(selectionTraceGeometry(nodes()[0]!)).not.toBe(d);
      renderer.clearElementPreviews();
      scheduler.runAll();
      expect(selectionTraceGeometry(nodes()[0]!)).toBe(d);
      renderer.destroy();
    },
  );
});

describe("selection highlight setting", () => {
  it("removes every halo while preserving line and arrow center nodes across toggles", () => {
    const elements = createAllElementSnapshot().elements;
    const { renderer, scheduler, select, nodes } = createSelectionTraceFixture(elements);
    const selectedRoots = select();
    const centers = selectedRoots
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
    expect(nodes().flatMap(selectionHaloPaths)).toEqual([]);
    expect(nodes().flatMap(selectionHaloNodes)).toHaveLength(centers.length * 2);
    expect(
      nodes()
        .flatMap(selectionHaloNodes)
        .filter((node) => node.attributes.get("class") === "inkbook-selection-center-trace"),
    ).toEqual(centers);
    renderer.setSelectionHighlightsEnabled(true);
    scheduler.runAll();
    expect(
      nodes()
        .flatMap(selectionHaloNodes)
        .filter((node) => node.attributes.get("class") === "inkbook-selection-center-trace"),
    ).toEqual(centers);
    expect(nodes()).toHaveLength(elements.length);
    renderer.destroy();
  });

  it.each([rectangle(), stroke()])(
    "re-enables the displayed $kind preview and restores the baseline on cancellation",
    (source) => {
      const { renderer, scheduler, select, nodes } = createSelectionTraceFixture([source]);
      const baseline = selectionTraceGeometry(select()[0]!);
      renderer.setElementPreviews(moveSelection([source], { x: 20, y: 30 }), 1);
      scheduler.runAll();
      const preview = selectionTraceGeometry(nodes()[0]!);
      expect(preview).not.toBe(baseline);
      renderer.setSelectionHighlightsEnabled(false);
      scheduler.runAll();
      expect(nodes()).toEqual([]);
      renderer.setSelectionHighlightsEnabled(true);
      scheduler.runAll();
      expect(selectionTraceGeometry(nodes()[0]!)).toBe(preview);
      renderer.clearElementPreviews();
      scheduler.runAll();
      expect(selectionTraceGeometry(nodes()[0]!)).toBe(baseline);
      renderer.destroy();
    },
  );
});

it("re-enables pressure highlights during both progressive feedback and materialized resize", () => {
  const source = stroke();
  const { renderer, scheduler, select, nodes } = createSelectionTraceFixture([source]);
  const baseline = selectionTraceGeometry(select()[0]!);
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
  const resizedPath = selectionTraceGeometry(nodes()[0]!);
  expect(resizedPath).not.toBe(baseline);
  renderer.setSelectionHighlightsEnabled(false);
  scheduler.runAll();
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  expect(selectionTraceGeometry(nodes()[0]!)).toBe(resizedPath);
  renderer.clearProgressiveElementPreviews();
  scheduler.runAll();
  expect(selectionTraceGeometry(nodes()[0]!)).toBe(baseline);
  renderer.destroy();
});
