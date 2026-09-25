import { createSceneRecord } from "../../../fixtures/rendering/scene";
import { afterEach, expect, it, vi } from "vitest";
import { CommittedPreviewGeometry } from "../../../../src/rendering/scene/committed-preview-geometry";
import { ProgressivePreviewPath } from "../../../../src/rendering/scene/progressive-preview-path";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { indexedStroke } from "../../../fixtures/editor/stroke";

afterEach(() => vi.restoreAllMocks());

it("advances expired deadlines, discards stale versions, publishes windows, and releases ownership", () => {
  const geometry = new CommittedPreviewGeometry();
  const element = {
    ...indexedStroke(1),
    points: Array.from({ length: 512 }, (_, i) => [i, i % 5, 0.5]).flat(),
  };
  const record = createSceneRecord(element);
  const publishWindow = vi.fn();
  const port = { readWindow: () => undefined, publishWindow };
  const step = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  geometry.retain(element.id, "translate(10 0)", 2);
  expect(geometry.prepare(record, 0, () => 100, port)).toBeUndefined();
  expect(step).not.toHaveBeenCalled();
  expect(geometry.prepare(record, 0, () => 100, port)).toBeUndefined();
  expect(step).toHaveBeenCalledOnce();
  expect(geometry.memoryUsage()).toBeGreaterThan(0);
  const latest = { ...record, geometryVersion: 2, element: { ...element, rotation: 25 } };
  step.mockClear();
  expect(geometry.prepare(latest, Infinity, () => 0, port)).toBeUndefined();
  expect(step).not.toHaveBeenCalled();
  let parts;
  while (parts === undefined) parts = geometry.prepare(latest, Infinity, () => 0, port);
  expect(parts).toEqual(buildElementPathParts(latest.element));
  expect(publishWindow).toHaveBeenCalled();
  expect(geometry.finish(element.id)).toMatchObject({ transform: null });
  expect(geometry.memoryUsage()).toBe(0);
  geometry.retain(element.id, "translate(5 0)", null);
  geometry.prepare(record, 0, () => 100);
  geometry.release();
  expect(geometry.memoryUsage()).toBe(0);
  expect(geometry.has(element.id)).toBe(false);
});
