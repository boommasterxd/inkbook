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
  it("renders a long-pressure fallback as a non-scaling centerline", () => {
    const stroke = longPressureStroke();
    const { renderer, store } = setup(strokeRecord(stroke));
    const contentPath = fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!;
    const committedOutline = contentPath.attributes.get("d");
    expect(contentPath.attributes.get("fill")).not.toBe("none");
    expect(contentPath.attributes.get("stroke")).toBe("none");

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
    renderer.setElementPreviews(preview.elements, 1);
    renderer.setPreviewTransform([stroke.id], "scale(3 0.5)", 1, "preserve");
    renderer.flushPointerFeedbackFrame();

    expect(contentPath.attributes.get("d")).not.toBe(committedOutline);
    expect(contentPath.attributes.get("fill")).toBe("none");
    expect(contentPath.attributes.get("stroke")).not.toBe("none");
    expect(contentPath.attributes.get("stroke-width")).toBe("2");
    expect(contentPath.attributes.get("transform")).toBe("scale(3 0.5)");
    expect(contentPath.attributes.get("vector-effect")).toBe("non-scaling-stroke");

    renderer.clearElementPreviews();
    renderer.clearPreviewTransforms();
    renderer.flushPointerFeedbackFrame();
    expectPressureOutline(contentPath, committedOutline);
    expect(store.records.get(stroke.id)?.element).toBe(stroke);
  });

  it("atomically hands a pressure centerline fallback to the exact committed outline", () => {
    const stroke = longPressureStroke();
    const { renderer, scheduler, store } = setup(strokeRecord(stroke));
    const contentPath = fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes[0]!;
    const fallback = { ...stroke, style: { ...stroke.style, pressureEnabled: false } };
    renderer.setElementPreviews([fallback], 1);
    renderer.setPreviewTransform([stroke.id], "scale(3 0.5)", 1, "preserve");
    renderer.flushPointerFeedbackFrame();
    const fallbackD = contentPath.attributes.get("d");

    const handoff = renderer.beginPreviewCommit();
    expect(handoff.arm([stroke.id])).toBe(true);
    const replacement = scaledStroke(stroke, 3, 0.5);
    store.records.set(stroke.id, {
      ...strokeRecord(replacement),
      geometryVersion: 2,
    });
    renderer.applyDelta({
      affected: [
        {
          after: replacement,
          before: stroke,
          domains: ["geometry"],
          id: stroke.id,
        },
      ],
    });
    renderer.clearElementPreviews();
    renderer.clearPreviewTransforms();

    expect(contentPath.attributes.get("d")).toBe(fallbackD);
    expect(contentPath.attributes.get("vector-effect")).toBe("non-scaling-stroke");
    scheduler.runAll();
    expectPressureOutline(contentPath, buildElementPathParts(replacement)[0]?.d);
  });
});

function setup(record = fakeRectangleRecord("a", 0, 10)) {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  store.records.set(record.id, record);
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
    20 + (index % 3),
    0.25 + (index % 4) * 0.2,
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
