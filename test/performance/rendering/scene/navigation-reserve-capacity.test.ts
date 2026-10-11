import { expect, it, vi } from "vitest";
import { UniformSpatialIndex } from "../../../../src/domain/spatial";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { MAX_PREPARED_SCENE_PATH_IDS } from "../../../../src/domain/geometry/prepared-scene-paths";
import { NavigationPathPreparation } from "../../../../src/rendering/scene/navigation-path-preparation";
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import {
  beginNavigationPathRequest,
  createSceneRecord,
  observeIndexedSceneQueries,
} from "../../../fixtures/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const PRIORITY = { viewport: BOUNDS, direction: { x: 0, y: 1 } };

function createCapacityFixture(
  prefix: "warm" | "shape" | "overlap",
  coldFirst: boolean,
  warmAll = false,
) {
  const records = new Map(
    Array.from({ length: 10_000 }, (_, rank) => {
      const prefixElement = coldFirst ? rank >= 44 && rank < 300 : rank < 256;
      const y = warmAll || rank < 300 ? 120 : 10_000;
      const startY = prefixElement && prefix === "overlap" ? 99 : y;
      const points = [50, startY, 0.5, 51, y, 0.5];
      if (warmAll) Object.freeze(points);
      const element = {
        ...indexedStroke(rank),
        pivot: { x: 50, y },
        points,
      };
      const record =
        prefixElement && prefix === "shape"
          ? fakeRectangleRecord(element.id, rank, 50, y)
          : createSceneRecord(element, rank);
      return [record.id, record] as const;
    }),
  );
  const index = new UniformSpatialIndex<string>();
  index.insertMany([...records.values()].map(({ id, bounds }) => ({ id, bounds })));
  const { query, work } = observeIndexedSceneQueries(index);
  const prepare = vi.fn<NonNullable<SceneStorePort["prepareScenePaths"]>>(
    () => new Promise(() => undefined),
  );
  const store: SceneStorePort = {
    get: (id) => records.get(id),
    query: () => {
      throw new Error("Preparation must use its indexed cursor.");
    },
    beginQuery: (bounds) => index.beginQuery(bounds),
    prepareScenePaths: prepare,
  };
  const cache = new ScenePathCache();
  if (prefix === "warm") {
    for (const record of records.values()) {
      const warm = coldFirst ? record.rank >= 44 && record.rank < 300 : record.rank < 256;
      if (warm || warmAll) {
        const parts = buildElementPathParts(record.element);
        cache.completePreparation(record.element, parts, record.geometryVersion);
        cache.retain(record.id, record.geometryVersion, parts);
      }
    }
  }
  return {
    cache,
    records,
    store,
    prepare,
    query,
    preparation: new NavigationPathPreparation(store, cache),
    indexedWork: () => work.indexedVisits,
  };
}

it.each(["warm", "shape", "overlap"] as const)(
  "counts reserved cold contours rather than a preceding 256-candidate %s prefix",
  (prefix) => {
    for (const coldFirst of [false, true]) {
      const fixture = createCapacityFixture(prefix, coldFirst);
      try {
        const [ids, signal] = beginNavigationPathRequest(fixture, PRIORITY, BOUNDS);
        expect(ids).toHaveLength(44);
        expect(ids.length).toBeLessThanOrEqual(MAX_PREPARED_SCENE_PATH_IDS);
        expect(fixture.indexedWork()).toBeLessThanOrEqual(314);
        const visited = fixture.indexedWork();
        expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
        expect(fixture.indexedWork()).toBe(visited);
        fixture.preparation.cancel();
        expect(signal.aborted).toBe(true);
        expect(fixture.preparation.memoryUsage()).toBe(0);
      } finally {
        fixture.preparation.cancel();
        fixture.cache.release();
        fixture.query.mockRestore();
      }
      expect(fixture.cache.statistics().bytes).toBe(0);
    }
  },
);

it("suspends real indexed acquisition at the shared deadline before reserving a full batch", () => {
  const fixture = createCapacityFixture("warm", false);
  let clock = 0;
  try {
    fixture.preparation.setTarget(PRIORITY, BOUNDS);
    expect(fixture.preparation.prepare(2, () => clock++)).toBe(true);
    expect(fixture.query).toHaveBeenCalledOnce();
    expect(fixture.indexedWork()).toBeLessThanOrEqual(2);
    expect(fixture.prepare).not.toHaveBeenCalled();
    fixture.preparation.cancel();
    expect(fixture.preparation.memoryUsage()).toBe(0);
  } finally {
    fixture.query.mockRestore();
    fixture.cache.release();
  }
});

it("rebinds 10,000 retained leading contours once and skips all pressure ports on repeated admission", () => {
  const fixture = createCapacityFixture("warm", false, true);
  const pressure = vi.fn(() => ({ readWindow: () => undefined, publishWindow: vi.fn() }));
  fixture.store.pressureGeometry = pressure;
  const read = vi.spyOn(fixture.cache, "read");
  const builds = vi.spyOn(fixture.cache, "startPreparation");
  try {
    fixture.preparation.setTarget(PRIORITY, BOUNDS);
    expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
    expect(pressure.mock.calls.length).toBe(0);
    expect(read.mock.calls.length).toBe(0);
    const firstVisits = fixture.indexedWork();
    expect(firstVisits).toBeGreaterThanOrEqual(fixture.records.size);
    expect(firstVisits).toBeLessThanOrEqual(fixture.records.size + 32);
    for (const [id, record] of fixture.records) {
      fixture.cache.invalidate(id);
      fixture.records.set(id, { ...record, geometryVersion: 2 });
    }
    fixture.preparation.pause();
    expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
    expect(pressure).toHaveBeenCalledTimes(fixture.records.size);
    expect(read).toHaveBeenCalledTimes(fixture.records.size);
    expect(read.mock.calls.every(([, , version]) => version === 2)).toBe(true);
    for (const id of fixture.records.keys()) expect(fixture.cache.has(id, 2)).toBe(true);
    fixture.preparation.pause();
    expect(fixture.preparation.prepare(Infinity, () => 0)).toBe(false);
    expect(pressure).toHaveBeenCalledTimes(fixture.records.size);
    expect(read).toHaveBeenCalledTimes(fixture.records.size);
    expect(fixture.indexedWork()).toBe(firstVisits * 3);
    expect(builds).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.cache.statistics()).toMatchObject({ entries: 10_000, evictions: 0 });
    expect(fixture.cache.statistics().bytes).toBeLessThanOrEqual(25 * 1024 * 1024);
    const changed = fixture.records.values().next().value!;
    const element = changed.element;
    if (element.kind !== "stroke") throw new Error("Expected a stroke.");
    fixture.records.set(changed.id, {
      ...changed,
      element: { ...element, style: { ...element.style, width: 4 } },
      geometryVersion: 3,
    });
    fixture.cache.invalidate(changed.id);
    fixture.preparation.pause();
    fixture.preparation.prepare(Infinity, () => 0);
    expect(fixture.prepare.mock.calls[0]![0]).toEqual([changed.id]);
    const changedSignal = fixture.prepare.mock.calls[0]![1];
    fixture.preparation.cancel();
    expect(changedSignal.aborted).toBe(true);
    fixture.cache.setRetentionEnabled(false);
    fixture.cache.setRetentionEnabled(true);
    fixture.prepare.mockClear();
    const [ids, signal] = beginNavigationPathRequest(fixture, PRIORITY, BOUNDS);
    expect(ids).toHaveLength(MAX_PREPARED_SCENE_PATH_IDS);
    expect(fixture.preparation.memoryUsage()).toBeLessThanOrEqual(
      // One transport batch plus query deduplication and two reusable axis states.
      4 * 1024 * 1024 + MAX_PREPARED_SCENE_PATH_IDS * (128 + 32) + 512,
    );
    fixture.preparation.cancel();
    expect(signal.aborted).toBe(true);
  } finally {
    read.mockRestore();
    builds.mockRestore();
    fixture.preparation.cancel();
    fixture.cache.release();
    fixture.query.mockRestore();
  }
  expect(fixture.preparation.memoryUsage()).toBe(0);
  expect(fixture.cache.statistics().bytes).toBe(0);
});
