import { describe, expect, it } from "vitest";
import { PreparedStrokeCenterCache } from "../../../../src/domain/store/prepared-stroke-center-cache";
import { ElementStore } from "../../../../src/domain/store/public";
import { moveSelection } from "../../../../src/editor/selection/transforms";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import { stroke } from "../schema/fixtures";
import { isolatedStrokePreparationStores } from "../../../fixtures/domain/runtime-stroke-store";

const centers = [{ x: 100, y: 100, pressure: 0.5 }];

describe("store-owned local stroke centers", () => {
  it("bounds retained entries and releases evicted center windows", () => {
    const cache = new PreparedStrokeCenterCache();
    const source = stroke();
    Object.freeze(source.points);
    for (let index = 0; index < 4097; index += 1)
      cache.publish(`stroke-${String(index)}`, 1, source, 0, centers);
    expect(cache.statistics()).toMatchObject({ entries: 4096, evictions: 1 });
    expect(cache.statistics().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(cache.read("stroke-0", 1, source, 0)).toBeUndefined();
    cache.release();
    expect(cache.statistics()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("bounds bytes independently of entry count and freezes copied centers", () => {
    const cache = new PreparedStrokeCenterCache(10, 1024);
    const source = stroke();
    Object.freeze(source.points);
    cache.publish("a", 1, source, 0, centers);
    const retained = cache.read("a", 1, source, 0)!;
    expect(retained).not.toBe(centers);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained[0])).toBe(true);
    cache.publish(
      "b",
      1,
      source,
      0,
      Array.from({ length: 65 }, () => centers[0]!),
    );
    expect(cache.statistics().bytes).toBeLessThanOrEqual(1024);
    expect(cache.read("b", 1, source, 0)).toBeUndefined();
    cache.setRetentionEnabled(false);
    cache.publish("a", 1, source, 0, centers);
    expect(cache.statistics()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("shares center windows across placement and paint while revoking stale ports", () => {
    const source = stroke();
    const store = new ElementStore([source]);
    const record = store.get(source.id)!;
    const port = store.pressureGeometry(source.id, record.geometryVersion);
    port.publishCenters!(0, centers);
    const retained = port.readCenters!(0);
    const moved = moveSelection([record.element as StrokeElementV1], { x: 0.003, y: -100.007 })[0]!;
    store.replace(source.id, moved);
    const current = store.get(source.id)!;
    expect((current.element as StrokeElementV1).points).toBe(
      (record.element as StrokeElementV1).points,
    );
    const local = store.pressureGeometry(source.id, current.geometryVersion).local!();
    expect(local.readCenters!(0)).toBe(retained);
    expect(port.readCenters!(0)).toBeUndefined();
    port.publishCenters!(1, centers);
    expect(local.readCenters!(1)).toBeUndefined();
    const element = current.element as StrokeElementV1;
    store.replace(source.id, { ...element, style: { ...element.style, opacity: 0.5 } });
    expect(local.readCenters!(0)).toBe(retained);
    store.replace(source.id, { ...element, rotation: 37 });
    expect(local.readCenters!(0)).toBeUndefined();
    expect(store.activeDocumentMemoryUsage().selectionGeometryCacheBytes).toBe(0);
    store.releasePreparedPressureGeometry();
  });

  it("isolates stores, clears under memory pressure, removes ownership and closes ports", () => {
    const source = stroke();
    const { first, second, version, port } = isolatedStrokePreparationStores(source);
    port.publishCenters!(0, centers);
    expect(second.pressureGeometry(source.id, version).readCenters!(0)).toBeUndefined();
    first.setActiveDocumentMemoryPressure(true);
    port.publishCenters!(0, centers);
    expect(port.readCenters!(0)).toBeUndefined();
    expect(first.activeDocumentMemoryUsage().selectionGeometryCacheBytes).toBe(0);
    first.setActiveDocumentMemoryPressure(false);
    port.publishCenters!(0, centers);
    first.remove([source.id]);
    expect(first.activeDocumentMemoryUsage().selectionGeometryCacheBytes).toBe(0);
    first.releasePreparedPressureGeometry();
    port.publishCenters!(0, centers);
    expect(port.readCenters!(0)).toBeUndefined();
    second.releasePreparedPressureGeometry();
  });
});

it("does not reuse preparations for externally mutable samples", () => {
  const cache = new PreparedStrokeCenterCache();
  const source = stroke();
  cache.publish("a", 1, source, 0, centers);
  expect(cache.read("a", 1, source, 0)).toBeUndefined();
  expect(cache.statistics().bytes).toBe(0);
});

it.each(["samples", "rotation", "pivot-x", "pivot-y", "width", "pressure", "tool"] as const)(
  "invalidates exact local preparation when %s changes",
  (change) => {
    const cache = new PreparedStrokeCenterCache();
    const source = stroke();
    Object.freeze(source.points);
    cache.publish("a", 1, source, 0, centers);
    const samples = change === "samples" ? [...source.points] : source.points;
    Object.freeze(samples);
    const replacement = {
      ...source,
      points: samples,
      rotation: change === "rotation" ? 37 : source.rotation,
      tool: change === "tool" ? ("highlighter" as const) : source.tool,
      pivot: {
        x: source.pivot.x + (change === "pivot-x" ? 1 : 0),
        y: source.pivot.y + (change === "pivot-y" ? 1 : 0),
      },
      style: {
        ...source.style,
        width: change === "width" ? (8 as const) : source.style.width,
        pressureEnabled:
          change === "pressure" ? !source.style.pressureEnabled : source.style.pressureEnabled,
      },
    };
    expect(cache.read("a", 2, replacement, 0)).toBeUndefined();
    expect(cache.resolve("a", 2, replacement).shapeVersion).toBe(2);
  },
);
