import { expect, it, vi } from "vitest";

import { BOUNDS, directionalFixture } from "./navigation-index-fixture";

it("bounds directional candidates and contour ownership, reuses prepared geometry and cancels reversals", () => {
  const { work, store, cache, preparation, priority, records } = directionalFixture();
  const get = vi.spyOn(store, "get");
  const builds = vi.spyOn(cache, "startPreparation");
  preparation.setTarget(priority, BOUNDS);
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(builds).toHaveBeenCalledTimes(300);
  expect(get.mock.calls.length).toBeLessThanOrEqual(600);
  expect(work.units).toBeLessThanOrEqual(314);
  expect(cache.statistics().entries).toBe(300);
  expect(preparation.memoryUsage()).toBe(0);
  preparation.cancel();
  preparation.setTarget(priority, BOUNDS);
  expect(preparation.prepare(Infinity, () => 0)).toBe(false);
  expect(builds).toHaveBeenCalledTimes(300);
  preparation.setTarget({ ...priority, direction: { x: 0, y: -1 } }, BOUNDS);
  preparation.prepare(Infinity, () => 0);
  expect(cache.has(records[0]!.id, 1)).toBe(true);
  preparation.cancel();
  expect(preparation.memoryUsage()).toBe(0);
});
