import { assert } from "vitest";

import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import {
  createDenseSnapTargets,
  createStandardDomainFixture,
} from "../domain/standard-domain-fixture";
import type { ComparisonImplementation, ComparisonScenario } from "./contracts";

export const DOMAIN_SPATIAL_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "domain-indexed-hit-query",
    modules: ["domain/store/public", "domain/spatial/index", "editor/selection/hit-test"],
    covers: [
      {
        file: "test/performance/domain/domain-performance.test.ts",
        test: "reuses scratch allocations for 500 hit-test queries",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p95", population: "samples", minimumSamples: 500 }],
    execution: "sequence",
    sequenceLength: 500,

    warmupOperations: 0,
    create(implementation) {
      const { HitTestScratch, elementContainsPoint } = implementation.get<
        typeof import("../../../src/editor/selection/hit-test")
      >("editor/selection/hit-test");
      const fixture = createStandardDomainFixture();
      const { store, scratch } = createSpatialStore(implementation, fixture.elements);
      const hit = new HitTestScratch();
      const bounds = { maxX: 38, maxY: 38, minX: 22, minY: 22 };
      const original = store.get(fixture.strokeIds[0]!)!.element as StrokeElementV1;
      const maximum: StrokeElementV1 = {
        ...original,
        points: Array.from({ length: 4_096 }, (_, index) => [index * 4, 0, index % 2]).flat(),
        pivot: { x: 0, y: 0 },
        rotation: 0,
        style: { ...original.style, pressureEnabled: true },
      };
      Object.freeze(maximum.points);
      elementContainsPoint(maximum, { x: 8000, y: 0 }, 0);
      store.query(bounds, scratch);
      const warmAllocations = scratch.allocationCount;
      let results: boolean[] = [];
      let durations: number[] = [];
      return {
        *run() {
          results = new Array<boolean>(500);
          durations = [];
          for (let operation = 0; operation < 500; operation += 1) {
            const started = performance.now();
            store.query(bounds, scratch);
            hit.begin({ x: 30, y: 30 }, "pen", 1);
            for (let index = 0; index < scratch.count; index += 1) {
              const id = scratch.at(index);
              const record = store.get(id);
              const rank = store.getRank(id);
              if (record && rank)
                hit.consider(id, rank.band, record.element as InkElementV1, rank.rank);
            }
            hit.finish();
            results[operation] = elementContainsPoint(maximum, { x: operation * 28, y: 0 }, 0);
            durations.push(performance.now() - started);
            yield;
          }
          return results;
        },
        measurementSamples() {
          return durations;
        },
        verify() {
          assert.equal(results.length, 500);
          assert.ok(results.every(Boolean));
          assert.equal(durations.length, 500);
          assert.ok(scratch.candidateVisitCount < 10);
          assert.equal(scratch.allocationCount, warmAllocations);
          assert.equal(store.instrumentation.fullStoreScans, 0);
        },
        dispose() {
          scratch.release();
        },
      };
    },
  },
  {
    id: "domain-indexed-snap-query",
    modules: ["domain/store/public", "domain/spatial/index", "editor/snapping/snap-candidate"],
    covers: [
      {
        file: "test/performance/domain/domain-performance.test.ts",
        test: "limits 500 snap lookups to spatially returned targets",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p95", population: "samples" }],
    execution: "sync",

    warmupOperations: 16,
    create(implementation) {
      const { SnapCandidateScratch, findSnapCandidate } = implementation.get<
        typeof import("../../../src/editor/snapping/snap-candidate")
      >("editor/snapping/snap-candidate");
      const { store, scratch: storeScratch } = createSpatialStore(
        implementation,
        createDenseSnapTargets(),
      );
      const scratch = new SnapCandidateScratch();
      let reads = 0;
      const query = {
        query(
          bounds: import("../../../src/domain/spatial/index").SpatialBounds,
          sink: { add(id: string): void },
        ) {
          store.query(bounds, storeScratch);
          for (let index = 0; index < storeScratch.count; index += 1)
            sink.add(storeScratch.at(index));
        },
      };
      const reader = {
        get(id: string) {
          reads += 1;
          const anchors = store.getSemanticAnchors(id);
          const rank = store.getRank(id);
          return anchors === null || rank === undefined ? null : { anchors, rank: rank.rank };
        },
      };
      return {
        reset() {
          reads = 0;
        },
        run() {
          return findSnapCandidate(
            { current: null, pointer: { x: 100, y: 500 }, pointerType: "pen", zoom: 1 },
            query,
            reader,
            scratch,
          );
        },
        verify() {
          assert.equal(reads, 128);
          assert.equal(store.instrumentation.fullStoreScans, 0);
        },
        dispose() {
          storeScratch.release();
        },
      };
    },
  },
];

function createSpatialStore(
  implementation: ComparisonImplementation,
  elements: readonly InkElementV1[],
) {
  const { ElementStore } =
    implementation.get<typeof import("../../../src/domain/store/public")>("domain/store/public");
  const { SpatialQueryScratch } =
    implementation.get<typeof import("../../../src/domain/spatial/index")>("domain/spatial/index");
  return { store: new ElementStore(elements), scratch: new SpatialQueryScratch<string>() };
}
