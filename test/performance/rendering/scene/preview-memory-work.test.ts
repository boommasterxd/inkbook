import { expect, it, vi } from "vitest";
import { CommittedPreviewGeometry } from "../../../../src/rendering/scene/committed-preview-geometry";
import { SceneTransformPreviewController } from "../../../../src/rendering/scene/transform-preview-controller";

const ids = Array.from({ length: 10_000 }, (_, index) => `selected-${index}`);

/** Observe production collection traversal, independent of the retained byte formula. */
function readMemoryWithoutMapVisits(owner: { memoryUsage(): number }): number {
  const iterator = vi.spyOn(Map.prototype, Symbol.iterator);
  let bytes: number;
  let visits: number;
  try {
    bytes = owner.memoryUsage();
    visits = iterator.mock.calls.length;
  } finally {
    iterator.mockRestore();
  }
  expect(visits).toBe(0);
  return bytes;
}

it("accounts 10000 committed transforms without scanning retained entries on memory reads", () => {
  const geometry = new CommittedPreviewGeometry();
  const base = "translate(5 0)";
  for (const id of ids) geometry.retain(id, base, null);
  const initial = readMemoryWithoutMapVisits(geometry);
  expect(initial).toBe(40 * ids.length + 2 * (ids.join("").length + ids.length * base.length));
  for (const transform of ["scale(2)", "rotate(30 0 0)", null]) {
    for (const id of ids) {
      expect(
        geometry.resolve(id, { transform, strokeWidthScale: null, version: 1 }).transform,
      ).toBe(transform === null ? base : `${transform} ${base}`);
    }
    expect(readMemoryWithoutMapVisits(geometry)).toBe(
      initial + 2 * ids.length * (transform?.length ?? 0),
    );
  }
  geometry.retain(ids[0]!, null, null);
  expect(readMemoryWithoutMapVisits(geometry)).toBe(initial - base.length * 2);
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
