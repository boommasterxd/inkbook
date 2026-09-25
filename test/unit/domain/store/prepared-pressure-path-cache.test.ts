import { expect, it, vi } from "vitest";
import { PreparedPressurePathCache } from "../../../../src/domain/store/prepared-pressure-path-cache";
import { ElementStore } from "../../../../src/domain/store/public";
import { stroke } from "../schema/fixtures";

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
