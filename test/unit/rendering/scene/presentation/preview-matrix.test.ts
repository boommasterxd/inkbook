import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { selectionPreviewMatrix } from "../../../../../src/editor/selection/transform/selection-preview-matrix";
import {
  createMountedElement,
  updatePreviewTransform,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { CommittedPreviewGeometry } from "../../../../../src/rendering/scene/presentation/committed-preview-geometry";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { createSceneRecord } from "../../../../fixtures/rendering/scene";

it("composes SVG ordering without rounding, including singular forward matrices", () => {
  const retained = new CommittedPreviewGeometry();
  retained.retain("x", "translate(0.0000001 7)", null, [1, 0, 0, 1, 1e-7, 7]);
  const preview = retained.resolve("x", {
    transform: "scale(0 3)",
    matrix: [0, 0, 0, 3, 0, 0],
    version: 1,
    strokeWidthScale: 2,
  });
  expect(preview.matrix).toEqual([0, 0, 0, 3, 0, 21]);
  expect(retained.finish("x")).toMatchObject({
    matrix: [0, 0, 0, 3, 0, 0],
    strokeWidthScale: 2,
  });
  expect(retained.memoryUsage()).toBe(0);
  retained.retain("x", "opaque(legacy)", null);
  expect(
    retained.resolve("x", {
      transform: "translate(1 0)",
      matrix: [1, 0, 0, 1, 1, 0],
      version: 2,
      strokeWidthScale: null,
    }),
  ).toMatchObject({
    transform: "translate(1 0) opaque(legacy)",
    matrix: undefined,
  });
});

it("produces the full-precision editor matrix for rotation and anchored nonuniform scale", () => {
  const rotate = selectionPreviewMatrix({
    kind: "rotate",
    degrees: 90,
    center: { x: 10, y: 20 },
  })!;
  expect(rotate[0] * 11 + rotate[2] * 20 + rotate[4]).toBeCloseTo(10, 12);
  expect(rotate[1] * 11 + rotate[3] * 20 + rotate[5]).toBeCloseTo(21, 12);
  const scaled = selectionPreviewMatrix({
    kind: "scale",
    anchor: { x: 7, y: 9 },
    delta: { x: 1e-7, y: 3 },
    factors: { x: 2, y: 0.5 },
    rotation: 33,
  })!;
  expect(scaled[0] * 7 + scaled[2] * 9 + scaled[4]).toBeCloseTo(7.0000001, 12);
  expect(scaled[1] * 7 + scaled[3] * 9 + scaled[5]).toBeCloseTo(12, 12);
  expect(selectionPreviewMatrix({ kind: "translate", delta: { x: 1e-7, y: -3 } })).toEqual([
    1, 0, 0, 1, 1e-7, -3,
  ]);
});

it("keeps preview metadata separate from positioned stroke offsets and clears unknown writes", async () => {
  const { FakeDocument } = await import("../fakes");
  const { createInstrumentation } =
    await import("../../../../../src/rendering/scene/instrumentation");
  const record = createSceneRecord({
    ...indexedStroke(3),
    offset: { x: 37, y: 19 },
  });
  const instrument = createInstrumentation();
  const entry = createMountedElement(
    new FakeDocument() as unknown as Document,
    record,
    buildElementPathParts(record.element),
    instrument,
  );
  updatePreviewTransform(entry, "translate(3 4)", 1, null, instrument, [1, 0, 0, 1, 3, 4]);
  expect(entry.appliedPreviewMatrix).toEqual([1, 0, 0, 1, 3, 4]);
  expect(entry.appliedTransform).toBe("translate(3 4) translate(37 19)");
  updatePreviewTransform(entry, "translate(3 4)", 1, null, instrument);
  expect(entry.appliedPreviewMatrix).toBeUndefined();
  updatePreviewTransform(entry, "translate(3 4)", 1, null, instrument, [1, 0, 0, 1, NaN, 4]);
  expect(entry.appliedPreviewMatrix).toBeUndefined();
});

it("computes exact progressive current times inverse snapshot and clears on cancel", async () => {
  const { createProgressivePreviewFixture } =
    await import("../../../../fixtures/rendering/progressive-element-preview");
  const { preview, content } = createProgressivePreviewFixture();
  const element = indexedStroke(4),
    ids = [element.id];
  const feedback = {
    transform: "translate(4 8)",
    inverse: "translate(-4 -8)",
    matrix: [1, 0, 0, 1, 4, 8] as const,
  };
  preview.set({ ids, materialize: () => element, version: 1, feedback });
  expect(preview.write(Infinity, () => 0)).toBe(false);
  preview.set({
    ids,
    materialize: () => element,
    version: 2,
    feedback: {
      transform: "scale(2 3)",
      inverse: "scale(.5 .3333333333333333)",
      matrix: [2, 0, 0, 3, 0, 0],
    },
  });
  preview.writeFeedback(1, 0, () => 1);
  expect(content.applyPreviewTransform).toHaveBeenLastCalledWith(
    element.id,
    "matrix(2 0 0 3 -8 -24)",
    2,
    1,
    [2, 0, 0, 3, -8, -24],
  );
  preview.clear();
  expect(content.applyPreviewTransform).toHaveBeenLastCalledWith(
    element.id,
    null,
    Number.MAX_SAFE_INTEGER,
    null,
  );
  expect(preview.memoryUsage()).toBe(0);
});

it("preserves opaque feedback when a singular snapshot cannot be inverted", async () => {
  const { progressiveFeedbackTransform } =
    await import("../../../../../src/rendering/scene/presentation/progressive-feedback-transform");
  const feedback = {
    transform: "scale(2)",
    inverse: "scale(.5)",
    matrix: [2, 0, 0, 2, 0, 0] as const,
  };
  expect(
    progressiveFeedbackTransform(
      feedback,
      {
        transform: "scale(0)",
        inverse: "legacy-inverse",
        matrix: [0, 0, 0, 0, 0, 0],
      },
      7,
      2,
    ),
  ).toMatchObject({ transform: "scale(2) legacy-inverse", matrix: undefined });
  expect(
    progressiveFeedbackTransform(
      { ...feedback, matrix: [Infinity, 0, 0, 2, 0, 0] },
      undefined,
      7,
      2,
    ),
  ).toMatchObject({ transform: "scale(2)", matrix: undefined });
});

it("forwards current matrices to late mounted members and clears legacy metadata", async () => {
  const { SceneTransformPreviewController } =
    await import("../../../../../src/rendering/scene/presentation/transform-preview-controller");
  const applyPreviewTransform = vi.fn();
  const controller = new SceneTransformPreviewController(
    {
      applyPreviewTransform,
      flushSelectionContext: vi.fn(),
      promoteVisible: () => false,
      previewMountedIds: () => [],
    },
    { x: 0, zoom: 1 },
  );
  controller.set(["one", "late"], "translate(3 4)", 1, "scale", undefined, [1, 0, 0, 1, 3, 4]);
  controller.write();
  controller.applyMounted(["late"]);
  expect(applyPreviewTransform).toHaveBeenLastCalledWith(
    "late",
    "translate(3 4)",
    1,
    null,
    [1, 0, 0, 1, 3, 4],
  );
  controller.set(["one", "late"], "opaque(legacy)", 2, "scale");
  controller.write();
  expect(applyPreviewTransform).toHaveBeenLastCalledWith("late", "opaque(legacy)", 2, null);
  controller.clear();
  controller.write();
  expect(applyPreviewTransform).toHaveBeenLastCalledWith(
    "late",
    null,
    Number.MAX_SAFE_INTEGER,
    null,
  );
  expect(controller.memoryUsage()).toBe(0);
});
