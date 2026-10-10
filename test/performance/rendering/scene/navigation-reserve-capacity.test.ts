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

function createCapacityFixture(prefix: "warm" | "shape" | "overlap", coldFirst: boolean) {
  const records = new Map(
    Array.from({ length: 10_000 }, (_, rank) => {
      const prefixElement = coldFirst ? rank >= 44 && rank < 300 : rank < 256;
      const y = rank < 300 ? 120 : 10_000;
      const startY = prefixElement && prefix === "overlap" ? 99 : y;
      const element = {
        ...indexedStroke(rank),
        pivot: { x: 50, y },
        points: [50, startY, 0.5, 51, y, 0.5],
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
      if (warm)
        cache.retain(record.id, record.geometryVersion, buildElementPathParts(record.element));
    }
  }
  return {
    cache,
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
