import { afterEach, expect, it, vi } from "vitest";
import { CommittedPreviewGeometry } from "../../../../../src/rendering/scene/presentation/committed-preview-geometry";
import { SceneTransformPreviewController } from "../../../../../src/rendering/scene/presentation/transform-preview-controller";
import type { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import {
  createLongPreviewStroke,
  createProgressivePreviewFixture,
  observePressurePreviewSteps,
  writeOnePreviewStep,
} from "../../../../fixtures/rendering/progressive-element-preview";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { takeImmutableElementOwnership } from "../../../../../src/domain/store/records/immutability";

afterEach(() => vi.restoreAllMocks());

const ids = Array.from({ length: 10_000 }, (_, index) => `selected-${index}`);

/** Observe production collection traversal, independent of the retained byte formula. */
function readMemoryWithoutMapVisits(owner: { memoryUsage(): number }): number {
  const probes = [
    vi.spyOn(Map.prototype, Symbol.iterator),
    vi.spyOn(Map.prototype, "values"),
    vi.spyOn(Map.prototype, "entries"),
    vi.spyOn(Map.prototype, "forEach"),
  ];
  let bytes: number;
  let visits: number;
  try {
    bytes = owner.memoryUsage();
    visits = probes.reduce((total, probe) => total + probe.mock.calls.length, 0);
  } finally {
    for (const probe of probes) probe.mockRestore();
  }
  expect(visits).toBe(0);
  return bytes;
}

it("accounts 10000 committed transforms without scanning retained entries on memory reads", () => {
  const geometry = new CommittedPreviewGeometry();
  const base = "translate(5 0)";
  for (const id of ids) geometry.retain(id, base, null);
  const initial = readMemoryWithoutMapVisits(geometry);
  // Conservative accounting reserves six numeric coefficients for each retained matrix.
  const matrixReservation = 6 * 8;
  expect(initial).toBe(
    (40 + matrixReservation) * ids.length + 2 * (ids.join("").length + ids.length * base.length),
  );
  for (const transform of ["scale(2)", "rotate(30 0 0)", null]) {
    for (const id of ids) {
      expect(
        geometry.resolve(id, { transform, strokeWidthScale: null, version: 1 }).transform,
      ).toBe(transform === null ? base : `${transform} ${base}`);
    }
    expect(readMemoryWithoutMapVisits(geometry)).toBe(
      initial + ids.length * (matrixReservation + 2 * (transform?.length ?? 0)),
    );
  }
  geometry.retain(ids[0]!, null, null);
  // Resolution reserves another matrix for desired feedback; replacement drops that slot.
  expect(readMemoryWithoutMapVisits(geometry)).toBe(
    initial + matrixReservation * (ids.length - 1) - base.length * 2,
  );
  for (const id of ids) geometry.finish(id);
  geometry.finish(ids[0]!);
  expect(readMemoryWithoutMapVisits(geometry)).toBe(0);
  geometry.retain("next-gesture", base, 2);
  geometry.release();
  expect(readMemoryWithoutMapVisits(geometry)).toBe(0);
});

it("keeps transform bytes exact across camera, replacement, reset, remount and release", () => {
  const content = {
    applyPreviewTransform: vi.fn(),
    flushSelectionContext: vi.fn(),
    promoteVisible: vi.fn(() => false),
    previewMountedIds: () => ids,
  };
  const controller = new SceneTransformPreviewController(content, { x: 0, zoom: 1 });
  const first = "translate(1 1)";
  controller.set(ids, first, 1, "scale");
  const initial = readMemoryWithoutMapVisits(controller);
  expect(initial).toBeGreaterThan(10_000 * 80);
  expect(initial).toBeLessThan(4 * 1024 * 1024);
  const next = "rotate(30 10 10)";
  controller.set(ids, next, 2, "scale");
  expect(readMemoryWithoutMapVisits(controller)).toBe(
    initial + 2 * ids.length * (next.length - first.length),
  );
  controller.setContext({ x: 0, zoom: 2 }, undefined);
  controller.refreshContext();
  expect(readMemoryWithoutMapVisits(controller)).toBe(
    initial + 2 * ids.length * (next.length - first.length),
  );
  controller.write();
  expect(readMemoryWithoutMapVisits(controller)).toBe(
    initial + 2 * ids.length * (next.length - first.length) - 40 * ids.length,
  );
  controller.clear();
  expect(readMemoryWithoutMapVisits(controller)).toBeGreaterThan(0);
  controller.write();
  expect(readMemoryWithoutMapVisits(controller)).toBe(0);
  controller.set(["small-selection"], first, 3, "preserve");
  controller.applyMounted(["small-selection", "foreign"]);
  const retained = readMemoryWithoutMapVisits(controller);
  controller.applyMounted(["small-selection"]);
  expect(readMemoryWithoutMapVisits(controller)).toBe(retained);
  controller.release();
  expect(readMemoryWithoutMapVisits(controller)).toBe(0);
});

it("accounts 10000 feedback entries and 256 snapshots exactly across eviction and remount", () => {
  const { preview, content } = createProgressivePreviewFixture(0);
  const elements = Array.from({ length: 256 }, (_, index) => indexedStroke(index));
  const snapshots = elements.map(({ id }) => id);
  const selected = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index).id);
  const feedback = { transform: "scale(2 1)", inverse: "scale(0.5 1)" };
  const request = {
    ids: snapshots,
    feedbackIds: selected,
    materialize: (id: string) => elements.find((element) => element.id === id),
    feedback,
  };
  preview.set({ ...request, version: 1 });
  const membership = selected.reduce((bytes, id) => bytes + 32 + id.length * 2, 0);
  const initial = (snapshots.length + selected.length) * 8 + membership;
  expect(readMemoryWithoutMapVisits(preview)).toBe(initial);
  preview.writeFeedback(1, 0, () => 0);
  const transforms = selected.reduce(
    (bytes, id) => bytes + 80 + (id.length + feedback.transform.length) * 2,
    0,
  );
  const feedbackIds = selected.length * 40;
  const commonFeedbackBytes = 128 + 6 * 8 + feedback.transform.length * 2;
  expect(readMemoryWithoutMapVisits(preview)).toBe(
    initial + transforms + feedbackIds + commonFeedbackBytes,
  );
  expect(preview.write(Infinity, () => 0)).toBe(false);
  const snapshotBytes = elements.length * (128 + 3 * 8 + 40);
  const basisBytes = snapshots.reduce(
    (bytes, id) =>
      bytes + 64 + (id.length + feedback.transform.length + feedback.inverse.length) * 2,
    0,
  );
  const snapshotTransforms = snapshots.reduce(
    (bytes, id) => bytes + 80 + (id.length + feedback.transform.length) * 2,
    0,
  );
  const completed =
    initial +
    transforms +
    feedbackIds +
    snapshotBytes +
    basisBytes * 2 -
    snapshotTransforms +
    commonFeedbackBytes;
  expect(readMemoryWithoutMapVisits(preview)).toBe(completed);
  preview.applyMounted(snapshots);
  expect(readMemoryWithoutMapVisits(preview)).toBe(
    completed - basisBytes + snapshotTransforms + snapshots.length * 40,
  );
  expect(preview.write(Infinity, () => 0)).toBe(false);
  expect(readMemoryWithoutMapVisits(preview)).toBe(completed);
  expect(content.applyCanonicalElementPreview).toHaveBeenCalledTimes(512);
  preview.set({ ...request, ids: [], feedbackIds: [], version: 2 });
  expect(readMemoryWithoutMapVisits(preview)).toBe(0);
  preview.release();
  expect(readMemoryWithoutMapVisits(preview)).toBe(0);
});

it("accounts pending pressure supersession, replacement, affine retention and cancellation", () => {
  const { preview } = createProgressivePreviewFixture(0);
  const original = createLongPreviewStroke(0);
  takeImmutableElementOwnership(original);
  let current = original;
  const request = {
    ids: [original.id],
    materialize: () => current,
    feedback: { transform: "scale(2 1)", inverse: "scale(0.5 1)" },
  };
  preview.set({ ...request, version: 1 });
  const initial = readMemoryWithoutMapVisits(preview);
  writeOnePreviewStep(preview);
  const pendingElementBytes = 128 + original.points.length * 8;
  expect(readMemoryWithoutMapVisits(preview)).toBe(initial + 40 + pendingElementBytes);
  const { steps, writeNext } = observePressurePreviewSteps();
  writeNext(preview);
  const path = steps.mock.contexts[0] as ProgressivePreviewPath;
  expect(readMemoryWithoutMapVisits(preview)).toBe(
    initial + 40 + pendingElementBytes + path.memoryUsage(),
  );
  preview.set({ ...request, version: 2 });
  writeNext(preview);
  expect(steps.mock.contexts[1]).toBe(path);
  expect(readMemoryWithoutMapVisits(preview)).toBe(
    initial + 40 + pendingElementBytes + path.memoryUsage(),
  );
  current = { ...original, points: original.points.slice(0, 9) };
  preview.set({ ...request, version: 3 });
  writeNext(preview);
  expect(path.memoryUsage()).toBe(0);
  const nextPath = steps.mock.contexts[2] as ProgressivePreviewPath;
  expect(readMemoryWithoutMapVisits(preview)).toBe(
    initial + 40 + 128 + current.points.length * 8 + nextPath.memoryUsage(),
  );
  preview.set({ ...request, version: 4, affineElement: () => current });
  expect(nextPath.memoryUsage()).toBe(0);
  expect(readMemoryWithoutMapVisits(preview)).toBe(initial + 40 + 128 + current.points.length * 8);
  current = { ...current, points: [1, 2, 0.5] };
  preview.set({ ...request, version: 5, affineElement: () => current });
  expect(readMemoryWithoutMapVisits(preview)).toBe(initial + 40 + 128 + 3 * 8);
  preview.clear();
  expect(readMemoryWithoutMapVisits(preview)).toBe(0);
});
