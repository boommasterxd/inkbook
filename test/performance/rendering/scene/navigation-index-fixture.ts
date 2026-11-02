import { UniformSpatialIndex } from "../../../../src/domain/spatial";
import { NavigationPathPreparation } from "../../../../src/rendering/scene/content/navigation-path-preparation";
import { ScenePathCache } from "../../../../src/rendering/scene/content/path-cache";
import type { SceneElementRecord, SceneStorePort } from "../../../../src/rendering/scene/types";
import { FakeSceneStore } from "../../../unit/rendering/scene/fakes";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createSceneRecord } from "../../../fixtures/rendering/scene";

export const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

export function indexedStore(records: readonly SceneElementRecord[]) {
  const fake = new FakeSceneStore();
  const index = new UniformSpatialIndex<string>();
  for (const record of records) fake.records.set(record.id, record);
  index.insertMany(records.map(({ id, bounds }) => ({ id, bounds })));
  const work = { units: 0, clock: 0, cancellations: 0 };
  const store: SceneStorePort = {
    get: (id) => fake.get(id),
    query: () => {
      throw new Error("Navigation must use the indexed cursor.");
    },
    beginQuery: (bounds) => {
      const cursor = index.beginQuery(bounds);
      return {
        advance: (limit) => {
          const step = cursor.advance(limit);
          work.units += step.workUnits;
          work.clock += step.workUnits;
          return step;
        },
        cancel: () => {
          work.cancellations += 1;
          cursor.cancel();
        },
        memoryUsage: () => cursor.memoryUsage(),
      };
    },
  };
  return { fake, index, work, store };
}

export function directionalFixture(count = 10_000, firstY = 120) {
  const records = Array.from({ length: count }, (_, rank) => {
    const y = rank < 300 ? firstY : 10_000;
    const element = {
      ...indexedStroke(rank),
      pivot: { x: 20, y },
      points: [20, y, 0.5, 21, y, 0.5],
    };
    return createSceneRecord(element, rank);
  });
  const indexed = indexedStore(records);
  const cache = new ScenePathCache();
  const preparation = new NavigationPathPreparation(indexed.store, cache);
  const priority = { viewport: BOUNDS, direction: { x: 0, y: 1 } };
  return { ...indexed, cache, preparation, priority, records };
}
