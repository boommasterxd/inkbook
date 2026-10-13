import { expect, it, vi } from "vitest";
import { PreparedPressurePathCache } from "../../../../src/domain/store/prepared-pressure-path-cache";
import { ElementStore } from "../../../../src/domain/store/public";
import { stroke } from "../schema/fixtures";
import { translatedStroke } from "../../../../src/domain/geometry/stroke-position";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";

const geometry = [{ d: "M0 0L5 5Z", paint: "fill" as const }];

it("bounds prepared paths by 1024 entries and four MiB, without retaining caller mutations", () => {
  const cache = new PreparedPressurePathCache();
  for (let index = 0; index < 1025; index++) cache.publish(String(index), 1, geometry);
  expect(cache.statistics()).toMatchObject({ entries: 1024, evictions: 1 });
  expect(cache.read("0", 1)).toBeUndefined();
  const retained = cache.read("1024", 1)!;
  expect(retained).toEqual(geometry);
  expect(retained).not.toBe(geometry);
  expect(Object.isFrozen(retained[0])).toBe(true);
  cache.release();
  const large = [{ d: geometry[0]!.d.repeat(4096), paint: "fill" as const }];
  for (let index = 0; index < 100; index++) cache.publish(String(index), 1, large);
  expect(cache.statistics().bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(cache.statistics().entries).toBeLessThan(100);
  expect(cache.statistics().evictions).toBeGreaterThan(1);
  cache.release();
  cache.publish("oversized", 1, [{ d: "M0 0".repeat(1024 * 1024), paint: "fill" }]);
  cache.publish("wrong-paint", 1, [{ d: "M0 0", paint: "stroke" }]);
  cache.publish("multipart", 1, [...geometry, ...geometry]);
  expect(cache.statistics().bytes).toBe(0);
  cache.publish("stale", 0, geometry);
  expect(cache.read("stale", 0)).toEqual(geometry);
  expect(cache.read("stale", 1)).toBeUndefined();
  expect([...cache.cachedVersions()]).toEqual([]);
});

it("binds prepared paths to live pressure geometry and releases them on invalidation or pressure", () => {
  const element = stroke();
  const store = new ElementStore([element]);
  const change = vi.fn();
  store.subscribeMemoryUsage(change);
  const port = store.pressureGeometry(element.id, store.get(element.id)!.geometryVersion);
  port.publishPath!(geometry);
  expect(port.readPath!()).toEqual(geometry);
  expect(change).toHaveBeenCalledOnce();
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBeGreaterThan(0);
  store.replace(element.id, { ...element, style: { ...element.style, opacity: 0.5 } });
  expect(port.readPath!()).toEqual(geometry);
  store.replace(element.id, { ...element, points: [0, 0, 1, 20, 20, 1] });
  port.publishPath!(geometry);
  expect(port.readPath!()).toBeUndefined();
  const current = store.pressureGeometry(element.id, store.get(element.id)!.geometryVersion);
  current.publishPath!(geometry);
  store.setActiveDocumentMemoryPressure(true);
  current.publishPath!(geometry);
  expect(current.readPath!()).toBeUndefined();
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
  store.setActiveDocumentMemoryPressure(false);
  current.publishPath!(geometry);
  store.releasePreparedPressureGeometry();
  current.publishPath!(geometry);
  expect(current.readPath!()).toBeUndefined();
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
});

it("rejects nonpressure, missing, and removed IDs", () => {
  const pressure = stroke();
  const constant = stroke(2, "highlighter");
  const store = new ElementStore([pressure, constant]);
  for (const id of [constant.id, "missing"]) {
    const port = store.pressureGeometry(id, store.get(id)?.geometryVersion ?? 0);
    port.publishPath!(geometry);
    expect(port.readPath!()).toBeUndefined();
  }
  const port = store.pressureGeometry(pressure.id, store.get(pressure.id)!.geometryVersion);
  port.publishPath!(geometry);
  store.remove([pressure.id]);
  port.publishPath!(geometry);
  expect(port.readPath!()).toBeUndefined();
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
});

it("retains exact local paths across rotated placement and paint, revoking old ports", () => {
  const store = new ElementStore([{ ...stroke(), rotation: 37 }]);
  const initial = store.get(stroke().id)!;
  const oldPort = store.pressureGeometry(initial.element.id, initial.geometryVersion).local!();
  oldPort.publishPath!(geometry);
  const retained = oldPort.readPath!();
  const moved = translatedStroke(initial.element as StrokeElementV1, { x: -100.007, y: 0.003 });
  store.replace(initial.element.id, moved);
  const current = store.get(initial.element.id)!;
  const world = store.pressureGeometry(current.element.id, current.geometryVersion);
  const local = world.local!();
  expect(local.local!()).toBe(local);
  expect(local.readPath!()).toBe(retained);
  expect(world.readPath!()).toBeUndefined();
  oldPort.publishPath!([{ d: "M99 99", paint: "fill" }]);
  expect(oldPort.readPath!()).toBeUndefined();
  expect(local.readPath!()).toBe(retained);
  expect([...store.preparedPressurePaths()]).toEqual([{ record: current, parts: retained }]);
  store.replace(initial.element.id, { ...moved, style: { ...moved.style, opacity: 0.5 } });
  expect(local.readPath!()).toBe(retained);
  store.replace(initial.element.id, initial.element as StrokeElementV1);
  const restored = store.get(initial.element.id)!;
  expect(store.pressureGeometry(restored.element.id, restored.geometryVersion).readPath!()).toBe(
    retained,
  );
  store.releasePreparedPressureGeometry();
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
});

it("keeps version-bound positioned paths distinct from local paths", () => {
  const placed = translatedStroke(stroke(), { x: 10, y: 20 });
  const store = new ElementStore([placed]);
  const first = store.get(placed.id)!;
  expect(first.geometryVersion).toBe(0);
  const port = store.pressureGeometry(first.element.id, first.geometryVersion);
  port.publishPath!(geometry);
  expect(port.readPath!()).toEqual(geometry);
  expect(port.local!().readPath!()).toBeUndefined();
  expect([...store.preparedPressurePaths()]).toEqual([]);
  store.replace(placed.id, translatedStroke(first.element as StrokeElementV1, { x: 1, y: 1 }));
  expect(port.readPath!()).toBeUndefined();
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
});

it.each(["samples", "rotation", "pivot-x", "pivot-y", "width", "pressure"] as const)(
  "rejects a retained local path after %s changes",
  (change) => {
    const source = stroke();
    const store = new ElementStore([source]);
    const first = store.get(source.id)!;
    const cache = new PreparedPressurePathCache();
    const owned = first.element as StrokeElementV1;
    cache.publishLocal(source.id, owned, geometry);
    const changed = {
      ...owned,
      points:
        change === "samples" ? owned.points.map((v, i) => (i === 0 ? v + 1 : v)) : owned.points,
      rotation: change === "rotation" ? 37 : owned.rotation,
      pivot: {
        x: owned.pivot.x + (change === "pivot-x" ? 1 : 0),
        y: owned.pivot.y + (change === "pivot-y" ? 1 : 0),
      },
      style: {
        ...owned.style,
        width: change === "width" ? (8 as const) : owned.style.width,
        pressureEnabled: change === "pressure" ? false : owned.style.pressureEnabled,
      },
    };
    store.replace(source.id, changed);
    const latest = store.get(source.id)!;
    expect(cache.readLocal(source.id, latest.element as StrokeElementV1)).toBeUndefined();
    store.releasePreparedPressureGeometry();
    cache.release();
  },
);

it("rejects a tool replacement across immutable bands without invalidating the original path", () => {
  const source = stroke();
  const store = new ElementStore([source]);
  const first = store.get(source.id)!;
  const port = store.pressureGeometry(source.id, first.geometryVersion);
  port.publishPath!(geometry);
  const retained = port.readPath!();
  expect(() =>
    store.replace(source.id, {
      ...source,
      tool: "highlighter",
      style: { ...source.style, pressureEnabled: false },
    }),
  ).toThrow();
  expect(store.get(source.id)).toBe(first);
  expect(port.readPath!()).toBe(retained);
  store.releasePreparedPressureGeometry();
});

it("rebinds exact local provenance for confirmed equal copied samples and rejects changed values", () => {
  const source = stroke();
  const store = new ElementStore([source]);
  const first = store.get(source.id)!;
  const port = store.pressureGeometry(source.id, first.geometryVersion);
  port.publishPath!(geometry);
  const retained = port.readPath!();
  const bytes = store.activeDocumentMemoryUsage().pressurePathCacheBytes;
  store.replace(source.id, {
    ...source,
    points: [...source.points],
    style: { ...source.style, opacity: 0.5 },
  });
  const repainted = store.get(source.id)!;
  expect(repainted.geometryVersion).toBe(first.geometryVersion);
  expect((repainted.element as StrokeElementV1).points).not.toBe(
    (first.element as StrokeElementV1).points,
  );
  expect(port.readPath!()).toBe(retained);
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(bytes);
  expect([...store.preparedPressurePaths()]).toEqual([{ record: repainted, parts: retained }]);
  const changed = [...source.points];
  changed[3] = changed[3]! + 0.001;
  store.replace(source.id, { ...source, points: changed });
  expect(store.get(source.id)!.geometryVersion).not.toBe(first.geometryVersion);
  expect(port.readPath!()).toBeUndefined();
  expect([...store.preparedPressurePaths()]).toEqual([]);
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
  store.releasePreparedPressureGeometry();
});

it("requires owned immutable samples, accounts local provenance and clears its cache index", () => {
  const cache = new PreparedPressurePathCache(1024, 2);
  const external = stroke();
  Object.freeze(external.points);
  Object.freeze(external);
  cache.publishLocal(external.id, external, geometry);
  expect(cache.statistics().bytes).toBe(0);
  const store = new ElementStore([external]);
  const owned = store.get(external.id)!.element as StrokeElementV1;
  const bounded = new PreparedPressurePathCache(512, 2);
  bounded.publishLocal("a", owned, geometry);
  expect(bounded.statistics().bytes).toBe(128 + 2 + geometry[0]!.d.length * 2 + 192);
  bounded.publishLocal("b", owned, geometry);
  expect([...bounded.cachedVersions()]).toEqual([["b", -1]]);
  expect(bounded.readLocal("a", owned)).toBeUndefined();
  expect(bounded.read("b", 1)).toBeUndefined();
  expect(bounded.readLocal("b", owned)).toEqual(geometry);
  bounded.setRetentionEnabled(false);
  expect([...bounded.cachedVersions()]).toEqual([]);
  bounded.publishLocal("a", owned, geometry);
  expect(bounded.statistics().bytes).toBe(0);
  bounded.setRetentionEnabled(true);
  bounded.publishLocal("a", owned, geometry);
  bounded.release();
  expect([...bounded.cachedVersions()]).toEqual([]);
  store.releasePreparedPressureGeometry();
});
