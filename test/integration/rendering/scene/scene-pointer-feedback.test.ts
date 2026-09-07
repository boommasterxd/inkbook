import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type {
  BoxShapeElementV1,
  PageV1,
  StrokeElementV1,
} from "../../../../src/domain/schema/public";
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

describe("canonical pressure preview staging", () => {
  it.each([0.5, 1, 2])("keeps exact pressure geometry independent of camera zoom %s", (zoom) => {
    const stroke = longPressureStroke();
    const { renderer, scheduler, store } = setup([strokeRecord(stroke)]);
    renderer.setCamera({ x: 0, zoom });
    const content = contentGroup(renderer);
    const committedOutline = content.nodes[0]!.attributes.get("d");
    const replacement = scaledStroke(stroke, 3, 0.5);
    renderer.setProgressiveElementPreviews([stroke.id], () => replacement, 1);
    renderer.flushPointerFeedbackFrame();
    expect(content.nodes[0]!.attributes.get("d")).toBe(committedOutline);
    scheduler.runAll();
    expect(content.nodes).toHaveLength(1);
    expectPressureOutline(content.nodes[0]!, buildElementPathParts(replacement)[0]?.d);
    renderer.clearElementPreviews();
    scheduler.runAll();
    expectPressureOutline(content.nodes[0]!, committedOutline);
    expect(store.records.get(stroke.id)?.element).toBe(stroke);
    renderer.destroy();
  });

  it("hands a complete canonical preview to the exact committed outline atomically", () => {
    const stroke = longPressureStroke();
    const { renderer, scheduler, store } = setup([strokeRecord(stroke)]);
    const replacement = scaledStroke(stroke, 3, 0.5);
    renderer.setProgressiveElementPreviews([stroke.id], () => replacement, 1);
    scheduler.runAll();
    const content = contentGroup(renderer);
    const previewD = content.nodes[0]!.attributes.get("d");
    const handoff = renderer.beginPreviewCommit();
    expect(handoff.arm([stroke.id])).toBe(true);
    store.records.set(stroke.id, { ...strokeRecord(replacement), geometryVersion: 2 });
    renderer.applyDelta({
      affected: [{ after: replacement, before: stroke, domains: ["geometry"], id: stroke.id }],
    });
    renderer.clearElementPreviews();
    renderer.clearPreviewTransforms();
    expect(content.nodes[0]!.attributes.get("d")).toBe(previewD);
    scheduler.runAll();
    expect(content.nodes).toHaveLength(1);
    expectPressureOutline(content.nodes[0]!, buildElementPathParts(replacement)[0]?.d);
    renderer.destroy();
  });

  it.each([40, 300])(
    "bounds canonical replacements to 256 viewport-near roots in %s strokes",
    (count) => {
      const strokes = Array.from({ length: count }, (_, index) => ({
        ...longPressureStroke(),
        id: `pressure-${String(index)}`,
        points: [10, 20, 0, 20, 30, 1, 30, 20, 0.5],
        style: { ...longPressureStroke().style, pressureEnabled: index % 2 === 0 },
      }));
      const originals = new Map(strokes.map((stroke) => [stroke.id, stroke]));
      const { renderer, scheduler } = setup(strokes.map(strokeRecord));
      const ids = strokes.map(({ id }) => id);
      const originalsD = contentGroup(renderer).nodes.map((node) => node.attributes.get("d"));
      let materialized = 0;
      renderer.setProgressiveElementPreviews(
        ids,
        (id) => {
          materialized += 1;
          return scaledStroke(originals.get(id)!, 2, 0.5);
        },
        1,
      );
      scheduler.runAll();
      expect(materialized).toBe(Math.min(count, 256));
      expect(
        contentGroup(renderer).nodes.filter(
          (node, index) => node.attributes.get("d") !== originalsD[index],
        ),
      ).toHaveLength(Math.min(count, 256));
      expect(contentGroup(renderer).nodes.every((node) => !node.attributes.has("transform"))).toBe(
        true,
      );
      expect(contentGroup(renderer).nodes).toHaveLength(count);
      expect(contentGroup(renderer).nodes.every(({ tagName }) => tagName === "path")).toBe(true);
      renderer.clearElementPreviews();
      scheduler.runAll();
      expect(contentGroup(renderer).nodes.map((node) => node.attributes.get("d"))).toEqual(
        originalsD,
      );
      renderer.destroy();
    },
  );
});

function contentGroup(renderer: SvgSceneRenderer): FakeNode {
  return fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
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
