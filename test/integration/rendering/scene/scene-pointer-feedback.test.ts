import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type {
  BoxShapeElementV1,
  PageV1,
  StrokeElementV1,
} from "../../../../src/domain/schema/public";
import { SelectionScalePreviewPlan } from "../../../../src/obsidian/embeds/active-editor/selection-scale-preview";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

describe("scene pointer-feedback staging", () => {
  it("writes only the latest exact preview from a raw-input burst", () => {
    const { contentPath, element, originalD, renderer, scheduler } = rectanglePreviewFixture();
    renderer.resetInstrumentation();

    renderer.setElementPreviews([{ ...element, width: 40 }], 1);
    renderer.setElementPreviews([{ ...element, width: 60 }], 2);

    expect(contentPath.attributes.get("d")).toBe(originalD);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runNext();
    expect(contentPath.attributes.get("d")).toBe("M10 10L70 10L70 30L10 30Z");
    expect(renderer.instrumentation().contentGeometryWrites).toBe(1);
  });

  it("writes only the latest selection and snap paths from one input frame", () => {
    const { renderer, scheduler } = setup();
    const overlayGroup = fakeNode(renderer.svg).nodes[2]!;
    const selection = overlayGroup.nodes[1]!;
    const snap = overlayGroup.nodes[3]!;

    renderer.setSelectionOverlayPath("M 0 0 L 10 10", "none");
    renderer.setSelectionOverlayPath("M 20 20 L 30 30", "accent");
    renderer.setSnapMarkerPath("M 1 1 L 2 2");
    renderer.setSnapMarkerPath("M 3 3 L 4 4");

    expect(selection.attributes.get("d")).toBeUndefined();
    expect(snap.attributes.get("d")).toBeUndefined();
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runNext();
    expect(selection.attributes.get("d")).toBe("M 20 20 L 30 30");
    expect(selection.attributes.get("data-selection-fill")).toBe("accent");
    expect(snap.attributes.get("d")).toBe("M 3 3 L 4 4");
  });

  it("restores exact geometry previews after their staged clear", () => {
    const { contentPath, element, originalD, renderer, scheduler } = rectanglePreviewFixture();

    renderer.setElementPreviews([{ ...element, width: 40 }], 1);
    scheduler.runNext();
    expect(contentPath.attributes.get("d")).not.toBe(originalD);
    renderer.clearElementPreviews();
    scheduler.runNext();
    expect(contentPath.attributes.get("d")).toBe(originalD);
  });
});

describe("pressure preview staging", () => {
  it.each([0.5, 1, 2])("preserves thin and thick pressure regions at zoom %s", (zoom) => {
    const stroke = longPressureStroke();
    const { renderer, store } = setup([strokeRecord(stroke)]);
    renderer.setCamera({ x: 0, zoom });
    const content = contentGroup(renderer);
    const committedOutline = content.nodes[0]!.attributes.get("d");
    const plan = new SelectionScalePreviewPlan([
      { bounds: calculateElementBounds(stroke), element: stroke },
    ]);
    const preview = plan.resolve({
      exactElements: [],
      exactPreviewTruncated: true,
      previewFrame: null,
      snapCandidate: null,
      snapGuide: null,
      transform: {
        anchor: { x: 0, y: 0 },
        delta: { x: 0, y: 0 },
        factors: { x: 3, y: 0.5 },
        kind: "scale",
        rotation: 0,
      },
    });
    renderer.setElementPreviews(preview.elements, 1, preview.pressurePreviewIds);
    renderer.setPreviewTransform([stroke.id], "scale(3 0.5)", 1, "preserve");
    renderer.flushPointerFeedbackFrame();

    expect(content.nodes).toHaveLength(1);
    expect(content.nodes[0]!.tagName).toBe("g");
    const paths = pressurePaths(renderer);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.length).toBeLessThanOrEqual(16);
    const widths = paths.map((path) => Number(path.attributes.get("stroke-width")));
    expect(Math.min(...widths)).toBeCloseTo(0.7 * zoom, 3);
    expect(Math.max(...widths)).toBeCloseTo(2 * zoom, 3);
    const thin = paths[widths.indexOf(Math.min(...widths))]!;
    expect(thin.attributes.get("d")).toContain("M10 20");
    for (const path of paths) {
      expect(path.attributes.get("fill")).toBe("none");
      expect(path.attributes.get("stroke")).not.toBe("none");
      expect(content.nodes[0]!.attributes.get("transform")).toBe("scale(3 0.5)");
      expect(path.attributes.get("vector-effect")).toBe("non-scaling-stroke");
    }
    const geometry = paths.map((path) => path.attributes.get("d"));
    renderer.setElementPreviews(preview.elements, 2, preview.pressurePreviewIds);
    renderer.setPreviewTransform([stroke.id], "scale(0.5 3)", 2, "preserve");
    renderer.flushPointerFeedbackFrame();
    expect(pressurePaths(renderer)).toEqual(paths);
    expect(paths.map((path) => path.attributes.get("d"))).toEqual(geometry);
    expect(paths.map((path) => Number(path.attributes.get("stroke-width")))).toEqual(widths);

    renderer.clearElementPreviews();
    renderer.clearPreviewTransforms();
    renderer.flushPointerFeedbackFrame();
    expect(content.nodes).toHaveLength(1);
    expectPressureOutline(content.nodes[0]!, committedOutline);
    expect(store.records.get(stroke.id)?.element).toBe(stroke);
  });
});

describe("pressure preview topology", () => {
  it("atomically hands pressure bands to the exact committed outline", () => {
    const stroke = longPressureStroke();
    const { renderer, scheduler, store } = setup([strokeRecord(stroke)]);
    renderer.setElementPreviews([stroke], 1, new Set([stroke.id]));
    renderer.setPreviewTransform([stroke.id], "scale(3 0.5)", 1, "preserve");
    renderer.flushPointerFeedbackFrame();
    const content = contentGroup(renderer);
    const roots = [...content.nodes];
    expect(pressurePaths(renderer).length).toBeGreaterThan(1);

    const handoff = renderer.beginPreviewCommit();
    expect(handoff.arm([stroke.id])).toBe(true);
    const replacement = scaledStroke(stroke, 3, 0.5);
    store.records.set(stroke.id, {
      ...strokeRecord(replacement),
      geometryVersion: 2,
    });
    renderer.applyDelta({
      affected: [{ after: replacement, before: stroke, domains: ["geometry"], id: stroke.id }],
    });
    renderer.clearElementPreviews();
    renderer.clearPreviewTransforms();

    expect(content.nodes).toEqual(roots);
    scheduler.runAll();
    expect(content.nodes).toHaveLength(1);
    expectPressureOutline(content.nodes[0]!, buildElementPathParts(replacement)[0]?.d);
  });

  it.each([false, true])(
    "retains late-mount zoom compensation with varying pressure %s",
    (varying) => {
      const original = longPressureStroke();
      const stroke = varying
        ? original
        : {
            ...original,
            points: original.points.map((value, index) => (index % 3 === 2 ? 0.5 : value)),
          };
      const { renderer } = setup([strokeRecord(stroke)]);
      renderer.setCamera({ x: 0, zoom: 0.5 });
      renderer.setPreviewTransform([stroke.id], "scale(2 0.5)", 1, "preserve");
      renderer.flushPointerFeedbackFrame();
      renderer.setElementPreviews([stroke], 2, new Set([stroke.id]));
      renderer.flushPointerFeedbackFrame();
      const paths = pressurePaths(renderer);
      expect(paths.length).toBe(varying ? 4 : 1);
      expect(Math.min(...paths.map((path) => Number(path.attributes.get("stroke-width"))))).toBe(
        varying ? 0.35 : 0.675,
      );
      for (const path of paths) {
        expect(contentGroup(renderer).nodes[0]!.attributes.get("transform")).toBe("scale(2 0.5)");
        expect(path.attributes.get("vector-effect")).toBe("non-scaling-stroke");
      }
    },
  );
});

describe("pressure preview root budget", () => {
  it.each([40, 300])("keeps %s pressure strokes within the shared transform budget", (count) => {
    const strokes = Array.from({ length: count }, (_, index) => ({
      ...longPressureStroke(),
      id: `pressure-${String(index)}`,
      points: Array.from({ length: 48 }, (_, sample) => [
        10 + sample * 0.1,
        20,
        Math.floor(sample / 3) / 15,
      ]).flat(),
    }));
    const ids = strokes.map(({ id }) => id);
    const pressureIds = new Set(ids);
    const { renderer } = setup(strokes.map(strokeRecord));
    renderer.setElementPreviews(strokes, 1, pressureIds);
    renderer.setPreviewTransform(ids, "scale(2 0.5)", 1, "preserve");
    renderer.flushPointerFeedbackFrame();
    const content = contentGroup(renderer);
    const groups = content.nodes.filter(({ tagName }) => tagName === "g");
    expect(groups).toHaveLength(Math.min(count, 256));
    expect(content.nodes).toHaveLength(count);
    for (const group of groups) {
      expect(group.nodes).toHaveLength(16);
      expect(group.attributes.get("transform")).toBe("scale(2 0.5)");
    }
    const paths = pressurePaths(renderer);
    const geometry = paths.map((path) => path.attributes.get("d"));
    renderer.resetInstrumentation();
    renderer.setElementPreviews(strokes, 2, pressureIds);
    renderer.setPreviewTransform(ids, "scale(0.5 2)", 2, "preserve");
    renderer.flushPointerFeedbackFrame();
    expect(pressurePaths(renderer)).toEqual(paths);
    expect(paths.map((path) => path.attributes.get("d"))).toEqual(geometry);
    expect(renderer.instrumentation().contentGeometryWrites).toBe(groups.length);
    renderer.clearElementPreviews();
    renderer.clearPreviewTransforms();
    renderer.flushPointerFeedbackFrame();
    expect(content.nodes).toHaveLength(count);
    expect(content.nodes.every(({ tagName }) => tagName === "path")).toBe(true);
    renderer.destroy();
  });
});

function contentGroup(renderer: SvgSceneRenderer): FakeNode {
  return fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
}

function pressurePaths(renderer: SvgSceneRenderer): FakeNode[] {
  return contentGroup(renderer).nodes.flatMap((node) =>
    node.tagName === "g" ? node.nodes : [node],
  );
}

function setup(records: readonly SceneElementRecord[] = [fakeRectangleRecord("a", 0, 10)]) {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  for (const record of records) store.records.set(record.id, record);
  const layout = { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) };
  const container = asElement(new FakeNode(document, "div"));
  const renderer = new SvgSceneRenderer({
    container,
    layout,
    page: PAGE,
    reducedMotion: true,
    scheduler,
    store,
  });
  scheduler.runAll();
  return { renderer, scheduler, store };
}

function rectanglePreviewFixture() {
  const fixture = setup();
  const contentPath = fakeNode(fixture.renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!;
  const element = fixture.store.records.get("a")!.element as BoxShapeElementV1;
  return {
    ...fixture,
    contentPath,
    element,
    originalD: contentPath.attributes.get("d"),
  };
}

function longPressureStroke(): StrokeElementV1 {
  const points = Array.from({ length: 513 }, (_, index) => [
    10 + index * 0.1,
    20,
    index < 256 ? 0 : 1,
  ]).flat();
  return {
    createdAt: 0,
    id: "long-pressure",
    kind: "stroke",
    pivot: { x: 35.6, y: 21 },
    points,
    rotation: 0,
    style: {
      color: { type: "rgba", value: "#112233FF" },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 2,
    },
    tool: "pen",
  };
}

function strokeRecord(element: StrokeElementV1): SceneElementRecord {
  return {
    band: "content",
    bounds: calculateElementBounds(element),
    element,
    geometryVersion: 1,
    id: element.id,
    paintVersion: 1,
    rank: 0,
  };
}

function scaledStroke(stroke: StrokeElementV1, scaleX: number, scaleY: number): StrokeElementV1 {
  return {
    ...stroke,
    pivot: { x: stroke.pivot.x * scaleX, y: stroke.pivot.y * scaleY },
    points: stroke.points.map((value, index) => {
      if (index % 3 === 0) return value * scaleX;
      if (index % 3 === 1) return value * scaleY;
      return value;
    }),
  };
}

function expectPressureOutline(path: FakeNode, expectedD: string | undefined): void {
  expect(path.attributes.get("d")).toBe(expectedD);
  expect(path.attributes.get("fill")).not.toBe("none");
  expect(path.attributes.get("stroke")).toBe("none");
  expect(path.attributes.has("transform")).toBe(false);
  expect(path.attributes.has("vector-effect")).toBe(false);
}
