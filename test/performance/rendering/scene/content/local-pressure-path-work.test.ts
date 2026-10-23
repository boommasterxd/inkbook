import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import { takeImmutableElementOwnership } from "../../../../../src/domain/store/records/immutability";
import { MAX_STROKE_POINTS, type StrokeElementV1 } from "../../../../../src/domain/schema/public";
import { translatedStroke } from "../../../../../src/domain/geometry/stroke-position";
import * as centers from "../../../../../src/domain/geometry/stroke-path";
import * as joins from "../../../../../src/domain/geometry/pressure/pressure-joins";
import * as unions from "../../../../../src/domain/geometry/pressure/pressure-union";
import * as serialization from "../../../../../src/domain/geometry/pressure/pressure-path-serialization";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";
import { preparedPressureHintBytes } from "../../../../../src/persistence/serialization/output/prepared-pressure-hints";
import { preparedHints as offeredPaths } from "../../../../fixtures/persistence/prepared-pressure-hints";
import {
  createStandardDomainFixture,
  createMaximumStroke,
  type StandardDomainFixture,
} from "../../../domain/standard-domain-fixture";
import { observePointReads } from "../../../../fixtures/rendering/point-reads";

afterEach(() => vi.restoreAllMocks());

let fixture: StandardDomainFixture;
beforeAll(() => {
  fixture = createStandardDomainFixture();
  for (const element of fixture.elements) takeImmutableElementOwnership(element);
  Object.freeze(fixture.elements);
  Object.freeze(fixture.strokeIds);
  Object.freeze(fixture);
});

function observePreparationWork() {
  let pointReads = 0;
  const observed = new WeakMap<object, number[]>();
  const original = centers.strokeCenterAt;
  const center = vi.spyOn(centers, "strokeCenterAt").mockImplementation((samples, index, count) => {
    let points = observed.get(samples);
    if (points === undefined) {
      points = observePointReads(samples as number[], () => (pointReads += 1));
      observed.set(samples, points);
    }
    return original(points, index, count);
  });
  const capsule = vi.spyOn(joins, "buildPressureCapsuleFromNibs");
  const union = vi.spyOn(unions, "iteratePressureUnion");
  const path = vi.spyOn(serialization, "serializePressureWindows");
  return {
    center,
    capsule,
    union,
    path,
    pointReads: () => pointReads,
    clear: () => {
      pointReads = 0;
      center.mockClear();
      capsule.mockClear();
      union.mockClear();
      path.mockClear();
    },
  };
}

function prepare(store: ElementStore, id: string, cache?: ScenePathCache) {
  const record = store.get(id)!;
  const port = store.pressureGeometry(id, record.geometryVersion);
  const job = new ProgressivePreviewPath(record.element as StrokeElementV1, port);
  while (!job.stepOperation()) {
    /* Finish actual canonical pressure preparation. */
  }
  const parts = job.parts!;
  cache?.completePreparation(record.element as StrokeElementV1, parts, record.geometryVersion);
  job.cancel();
  return parts;
}

function maximumPressureWave(): StrokeElementV1 {
  const base = createMaximumStroke();
  const points = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [
    index / 2,
    Math.round((100 + 5 * Math.sin(index * 0.17)) * 1000) / 1000,
    Math.round((0.5 + 0.3 * Math.sin(index * 0.037)) * 1000) / 1000,
  ]).flat();
  return {
    ...base,
    points,
    pivot: { x: MAX_STROKE_POINTS / 4, y: 100 },
    rotation: 37,
    style: { ...base.style, width: 2 },
  };
}

it.each([1_000, 2_000])(
  "reuses moved local contours for %i selected mixed-length strokes in the 10k fixture",
  (selectedCount) => {
    expect(fixture.strokeCount).toBe(10_000);
    expect(fixture.strokePointCount).toBe(500_000);
    const store = new ElementStore(fixture.elements);
    const ids = fixture.strokeIds.slice(0, selectedCount);
    const cache = new ScenePathCache();
    const work = observePreparationWork();
    try {
      for (const id of ids) prepare(store, id, cache);
      const pointCount = ids.reduce((sum, id) => {
        const stroke = store.get(id)!.element as StrokeElementV1;
        return sum + stroke.points.length / 3;
      }, 0);
      expect(work.pointReads()).toBeGreaterThanOrEqual(pointCount * 3);
      expect(work.pointReads()).toBeLessThanOrEqual(pointCount * 9);
      expect(work.capsule.mock.calls.length).toBeGreaterThan(0);
      expect(work.union.mock.calls.length).toBeGreaterThan(0);
      expect(work.path).toHaveBeenCalledTimes(selectedCount);
      for (const id of ids) {
        const stroke = store.get(id)!.element as StrokeElementV1;
        store.replace(id, translatedStroke(stroke, { x: -12.007, y: 0.003 }));
      }
      work.clear();
      store.resetInstrumentation();
      for (const id of ids) {
        const record = store.get(id)!;
        expect(
          cache.read(
            record.element as StrokeElementV1,
            store.pressureGeometry(id, record.geometryVersion),
          ),
        ).toBeDefined();
      }
      expect(work.pointReads()).toBe(0);
      expect(work.capsule).not.toHaveBeenCalled();
      expect(work.union).not.toHaveBeenCalled();
      expect(work.path).not.toHaveBeenCalled();
      expect(store.instrumentation.fullStoreScans).toBe(0);
      const offered = offeredPaths(store, 2);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.length).toBeLessThanOrEqual(Math.min(selectedCount, 1024));
      expect(
        offered.reduce((sum, hint) => sum + preparedPressureHintBytes(hint), 0),
      ).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      // A fresh presentation can reuse only the bounded Store cohort. Visit it first
      // so new cold entries cannot evict witnesses before their reuse is observed.
      const retained = new Set(offered.map(({ id }) => id));
      for (const id of retained) prepare(store, id);
      expect(work.pointReads()).toBe(0);
      expect(work.capsule).not.toHaveBeenCalled();
      expect(work.union).not.toHaveBeenCalled();
      expect(work.path).not.toHaveBeenCalled();
      for (const id of ids) if (!retained.has(id)) prepare(store, id);
      const coldMisses = selectedCount - retained.size;
      expect(work.path).toHaveBeenCalledTimes(coldMisses);
      if (coldMisses > 0) expect(work.capsule.mock.calls.length).toBeGreaterThan(0);
      expect(work.pointReads()).toBeLessThanOrEqual(pointCount * 9);
    } finally {
      cache.release();
      store.releasePreparedPressureGeometry();
    }
    expect(cache.cacheMemoryUsage()).toBe(0);
    expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
    expect(offeredPaths(store, 3)).toEqual([]);
  },
  120_000,
);

it("reuses complete maximum pressure paths and revokes cancelled, stale and pressure-disabled ownership", () => {
  const source = maximumPressureWave();
  expect(source.points.length / 3).toBe(MAX_STROKE_POINTS);
  const store = new ElementStore([source]);
  const initial = store.get(source.id)!;
  const port = store.pressureGeometry(source.id, initial.geometryVersion);
  const work = observePreparationWork();
  const cancelled = new ProgressivePreviewPath(initial.element as StrokeElementV1, port);
  try {
    expect(cancelled.stepOperation()).toBe(false);
    const reads = work.pointReads();
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(65 * 9);
    cancelled.cancel();
    expect(cancelled.stepOperation()).toBe(false);
    expect(work.pointReads()).toBe(reads);
    expect(port.readPath!()).toBeUndefined();
    expect(offeredPaths(store, 1)).toEqual([]);
    work.clear();
    const canonical = prepare(store, source.id);
    expect(work.pointReads()).toBeLessThanOrEqual(MAX_STROKE_POINTS * 9);
    expect(work.capsule.mock.calls.length).toBeGreaterThan(0);
    expect(work.union.mock.calls.length).toBeGreaterThan(0);
    expect(work.path).toHaveBeenCalledOnce();
    const owned = initial.element as StrokeElementV1;
    store.replace(source.id, translatedStroke(owned, { x: -0.003, y: 0.007 }));
    work.clear();
    expect(prepare(store, source.id)).toEqual(canonical);
    expect(work.pointReads()).toBe(0);
    expect(work.capsule).not.toHaveBeenCalled();
    expect(work.union).not.toHaveBeenCalled();
    expect(port.readPath!()).toBeUndefined();
    store.setActiveDocumentMemoryPressure(true);
    expect(offeredPaths(store, 2)).toEqual([]);
    expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
    store.setActiveDocumentMemoryPressure(false);
    const current = store.get(source.id)!;
    const local = store.pressureGeometry(source.id, current.geometryVersion).local!();
    local.publishPath!(canonical);
    expect(local.readPath!()).toEqual(canonical);
    const changed = Array.from((current.element as StrokeElementV1).points);
    changed[3] = changed[3]! + 0.001;
    store.replace(source.id, { ...(current.element as StrokeElementV1), points: changed });
    local.publishPath!(canonical);
    expect(local.readPath!()).toBeUndefined();
    expect(offeredPaths(store, 3)).toEqual([]);
  } finally {
    cancelled.cancel();
    store.releasePreparedPressureGeometry();
  }
  expect(store.activeDocumentMemoryUsage().pressurePathCacheBytes).toBe(0);
});
