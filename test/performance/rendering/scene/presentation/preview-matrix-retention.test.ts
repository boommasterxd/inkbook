import { expect, it, vi } from "vitest";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { CommittedPreviewGeometry } from "../../../../../src/rendering/scene/presentation/committed-preview-geometry";
import type { PreviewTransform } from "../../../../../src/rendering/scene/reconciliation/scene-mount-preparation";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import {
  createSceneFixture,
  createSceneRecord,
  sceneDeltaEntries,
} from "../../../../fixtures/rendering/scene";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { createMountedElement } from "../../../../../src/rendering/scene/content/mounted-element";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import { DetachedSceneElementCache } from "../../../../../src/rendering/scene/content/detached-element-cache";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import { PAGE, rectangle } from "../../../../unit/domain/store/fixtures";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import {
  IDENTITY_MATRIX,
  SelectionRunResiduals,
} from "../../../../../src/rendering/scene/presentation/selection-run-residuals";
import {
  asDocument,
  FakeDocument,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

it("retains a single numeric payload through 32 overlapping commits and releases pending geometry", () => {
  const retained = new CommittedPreviewGeometry();
  let current: PreviewTransform = {
    transform: null,
    version: 0,
    strokeWidthScale: null,
  };
  const lengths: number[] = [];
  for (let version = 1; version <= 32; version++) {
    retained.retain("stroke", current.transform, null, current.matrix);
    current = retained.resolve("stroke", {
      transform: "translate(1 2)",
      matrix: [1, 0, 0, 1, 1, 2],
      version,
      strokeWidthScale: null,
    });
    expect(current.matrix).toEqual([1, 0, 0, 1, version, version * 2]);
    expect(current.transform?.match(/matrix\(/g)).toHaveLength(1);
    lengths.push(current.transform!.length);
    expect(retained.memoryUsage()).toBeLessThan(400);
  }
  expect(Math.max(...lengths)).toBeLessThan(32);
  const element = {
    ...indexedStroke(1),
    points: Array.from({ length: 512 }, (_, i) => [i, i % 5, 0.5]).flat(),
  };
  const cancel = vi.spyOn(ProgressivePreviewPath.prototype, "cancel");
  retained.prepare(createSceneRecord(element), 0, () => 100);
  retained.retain("stroke", current.transform, null, current.matrix);
  // retain another element must not cancel the current geometry job.
  expect(cancel).not.toHaveBeenCalled();
  retained.release();
  expect(cancel).toHaveBeenCalledOnce();
  expect(retained.memoryUsage()).toBe(0);
  expect(retained.has("stroke")).toBe(false);
  cancel.mockRestore();
});

it("accounts a composed matrix on the actual renderer and releases its mounted reservation", () => {
  const memory = vi.spyOn(SceneContentRenderer.prototype, "previewMemoryUsage");
  const entries = vi.spyOn(mounted, "createMountedElement");
  const store = new ElementStore(),
    port = new ElementSceneStore(store);
  const { renderer, scheduler } = createSceneFixture(PAGE, port);
  const update = mounted.updateMountedGeometry;
  const geometry = vi.spyOn(mounted, "updateMountedGeometry");
  try {
    scheduler.runAll();
    renderer.memoryUsage();
    const content = memory.mock.contexts[memory.mock.contexts.length - 1];
    if (!(content instanceof SceneContentRenderer))
      throw new Error("Expected the renderer's content memory owner.");
    const empty = content.previewMemoryUsage();
    const original = rectangle();
    const other = { ...rectangle(indexedStroke(9).id, 300, 100) };
    renderer.applyDelta({ affected: sceneDeltaEntries(store.create([original, other])!) });
    scheduler.runAll();
    const reservation = 2 * 6 * Float64Array.BYTES_PER_ELEMENT;
    expect(content.previewMemoryUsage()).toBe(empty + reservation);
    const ids = [original.id, other.id],
      base = [1, 0, 0, 1, 5, 0] as const;
    renderer.setPreviewTransform(ids, "translate(5 0)", 1, "scale", undefined, base);
    renderer.flushPointerFeedbackFrame(scheduler.now());
    expect(renderer.beginPreviewCommit().arm(ids)).toBe(true);
    renderer.applyDelta({
      affected: sceneDeltaEntries(
        store.replaceMany(moveSelection([original, other], { x: 5, y: 0 }))!,
      ),
    });
    geometry.mockImplementation((...args) => {
      update(...args);
      scheduler.time += 9;
    });
    scheduler.runFrame();
    expect(geometry).toHaveBeenCalledOnce();
    const entry = entries.mock.results
      .map(({ value }) => value as mounted.MountedSceneElement)
      .find((candidate) => candidate.id !== geometry.mock.calls[0]![0].id)!;
    renderer.clearPreviewTransforms();
    const desired = [1, 0, 0, 1, 7, 0] as const;
    renderer.setPreviewTransform(ids, "translate(7 0)", 2, "scale", undefined, desired);
    renderer.flushPointerFeedbackFrame(scheduler.now());
    expect(entry.appliedPreviewMatrix).toEqual([1, 0, 0, 1, 12, 0]);
    expect(entry.appliedPreviewMatrix).not.toBe(base);
    expect(entry.appliedPreviewMatrix).not.toBe(desired);
    expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThanOrEqual(
      content.previewMemoryUsage(),
    );
    renderer.clearPreviewTransforms();
    scheduler.runAll();
    expect(content.previewMemoryUsage()).toBe(empty + reservation);
    renderer.destroy();
    expect(renderer.mountedCount).toBe(0);
    expect(content.previewMemoryUsage()).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  } finally {
    renderer.destroy();
    port.release();
    geometry.mockRestore();
    entries.mockRestore();
    memory.mockRestore();
  }
});

it("reserves detached matrices within capacity and releases cache ownership", () => {
  const record = fakeRectangleRecord("matrix", 0, 20),
    instrumentation = createInstrumentation();
  const entry = createMountedElement(
    asDocument(new FakeDocument()),
    record,
    buildElementPathParts(record.element),
    instrumentation,
  );
  const matrix = [1, 0, 0, 1, 12, 0] as const;
  mounted.updatePreviewTransform(entry, "matrix(1 0 0 1 12 0)", 1, 1, instrumentation, matrix);
  const pathBytes = entry.paths.reduce((bytes, path) => bytes + 512 + path.appliedD.length * 2, 0);
  const required =
    576 + matrix.length * Float64Array.BYTES_PER_ELEMENT + entry.id.length * 2 + 256 + pathBytes;
  const cache = new DetachedSceneElementCache(required);
  expect(cache.retain(entry)).toBe(true);
  expect(cache.memoryUsage()).toBe(required);
  expect(new DetachedSceneElementCache(required - 1).retain(entry)).toBe(false);
  expect(entry.appliedPreviewMatrix).toBe(matrix);
  expect(cache.take(record, instrumentation)).toBe(entry);
  expect(entry.appliedPreviewMatrix).toBeUndefined();
  expect(cache.memoryUsage()).toBe(0);
  mounted.updatePreviewTransform(entry, "matrix(1 0 0 1 12 0)", 2, 1, instrumentation, matrix);
  expect(cache.retain(entry)).toBe(true);
  cache.release();
  expect(cache.memoryUsage()).toBe(0);
  expect(cache.retainedRoots).toBe(0);
});

it("reserves independent residual matrix slots through composition, reparenting and cleanup", () => {
  const residuals = new SelectionRunResiduals();
  const instrumentation = createInstrumentation();
  const record = fakeRectangleRecord("member", 0, 20);
  const entry = createMountedElement(
    asDocument(new FakeDocument()),
    record,
    buildElementPathParts(record.element),
    instrumentation,
  );
  const empty = residuals.memoryUsage();
  residuals.retainBase(entry);
  // Identity and borrowed aliases deliberately retain the same conservative reservation.
  const reserved =
    112 + entry.id.length * 2 + 3 * IDENTITY_MATRIX.length * Float64Array.BYTES_PER_ELEMENT;
  expect(residuals.memoryUsage()).toBe(empty + reserved);
  const active = [1, 0, 0, 1, 5, 6] as const;
  residuals.set(entry, "translate(5 6)", 1, 1, active);
  residuals.capture(entry, 2);
  const parent = [2, 0, 0, 2, 0, 0] as const;
  residuals.reparent(entry, IDENTITY_MATRIX, parent, 1);
  const next = [1, 0, 0, 1, 7, 8] as const;
  residuals.set(entry, "translate(7 8)", 3, 1, next);
  expect(residuals.write(entry, parent, instrumentation)).toBe(true);
  expect(entry.appliedPreviewMatrix).toEqual([0.5, 0, 0, 0.5, 6, 7]);
  expect(entry.appliedPreviewMatrix).not.toBe(active);
  expect(entry.appliedPreviewMatrix).not.toBe(next);
  expect(residuals.memoryUsage()).toBeGreaterThanOrEqual(empty + reserved);
  residuals.canonical(entry, 2);
  residuals.set(entry, null, 4, null);
  expect(residuals.write(entry, IDENTITY_MATRIX, instrumentation)).toBe(true);
  expect(residuals.size).toBe(0);
  expect(residuals.memoryUsage()).toBe(empty);
  residuals.retainBase(entry);
  expect(residuals.memoryUsage()).toBe(empty + reserved);
  residuals.release(entry);
  residuals.release(entry);
  expect(residuals.memoryUsage()).toBe(empty);
  residuals.retainBase(entry);
  residuals.discard();
  expect(residuals.memoryUsage()).toBe(empty);
});
