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
  expect(step).toHaveBeenCalledOnce();
  expect(geometry.prepare(record, 0, () => 100, port)).toBeUndefined();
  expect(step).toHaveBeenCalledTimes(2);
  expect(geometry.memoryUsage()).toBeGreaterThan(0);
  const latest = { ...record, geometryVersion: 2, element: { ...element, rotation: 25 } };
  step.mockClear();
  const parts = geometry.prepare(latest, Infinity, () => 0, port);
  expect(step.mock.calls.length).toBeGreaterThan(4);
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

it("ignores a warm source path after a committed pressure resize changes its version", async () => {
  const { ElementStore } = await import("../../../../src/domain/store/public");
  const element = indexedStroke(1);
  const store = new ElementStore([element]);
  const source = store.get(element.id)!;
  const original = buildElementPathParts(element);
  const oldPort = store.pressureGeometry(element.id, source.geometryVersion);
  oldPort.publishPath!(original);
  const resized = {
    ...element,
    points: element.points.map((value, index) => (index % 3 === 2 ? value : value * 2)),
  };
  store.replace(element.id, resized);
  const current = store.get(element.id)!;
  oldPort.publishPath!(original);
  const port = store.pressureGeometry(element.id, current.geometryVersion);
  expect(port.readPath!()).toBeUndefined();
  const geometry = new CommittedPreviewGeometry();
  geometry.retain(element.id, "scale(2)", null);
  let parts;
  const record = { ...createSceneRecord(resized), geometryVersion: current.geometryVersion };
  while (parts === undefined) parts = geometry.prepare(record, Infinity, () => 0, port);
  expect(parts).toEqual(buildElementPathParts(resized));
  expect(parts).not.toEqual(original);
  expect(port.readPath!()).toEqual(parts);
  geometry.release();
  expect(geometry.memoryUsage()).toBe(0);
});
