import { assert } from "vitest";

import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import {
  createStandardDomainFixture,
  createStandardRuntimeDomainFixture,
} from "../domain/standard-domain-fixture";
import type { ComparisonScenario } from "./contracts";

const file = "test/performance/domain/domain-performance.test.ts";
const titles = {
  paint: "commits one-stroke paint changes without scans",
  endpoints: "uses the reverse map for a 512-endpoint target commit",
  arrange: "reorders an alternating 5,000-element selection",
};

export const DOMAIN_STORE_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "domain-runtime-store-construction",
    statistics: [{ kind: "total", population: "operations" }],
    modules: ["domain/store/public"],
    covers: [
      {
        file,
        test: "matches the normative point, shape, connection, overflow, and extent boundaries",
        ordinals: [1],
      },
    ],
    execution: "async",

    warmupOperations: 1,
    create(implementation) {
      const { ElementStore } =
        implementation.get<typeof import("../../../src/domain/store/public")>(
          "domain/store/public",
        );
      const fixture = createStandardRuntimeDomainFixture();
      let builder = ElementStore.createBuilder({
        shouldYield: () => false,
        yieldControl: async () => undefined,
      });
      let accepted: string;
      return {
        reset() {
          builder = ElementStore.createBuilder({
            shouldYield: () => false,
            yieldControl: async () => undefined,
          });
        },
        async run() {
          accepted = await builder.appendOwnedRuntime(fixture.elements);
          return builder.finalize();
        },
        verify(result) {
          const store = result as InstanceType<typeof ElementStore>;
          assert.equal(accepted, "accepted");
          assert.equal(store.size, 11_000);
          assert.ok(store.getMaximumBottom()! >= 200_000);
          let endpoints = 0;
          store.visitDependents(fixture.connectedTargetId, () => {
            endpoints += 1;
          });
          assert.equal(endpoints, 512);
        },
        dispose() {},
      };
    },
  },
  ...(["paint", "endpoints", "arrange"] as const).map((kind): ComparisonScenario => ({
    id: `domain-store-${kind}`,
    statistics: [
      {
        kind: kind === "paint" ? "p95" : "total",
        population: kind === "paint" ? "samples" : "operations",
      },
    ],
    modules: ["domain/store/public"],
    covers: [{ file, test: titles[kind], ordinals: [1] }],
    execution: "sync",

    warmupOperations: 16,
    create(implementation) {
      const { ElementStore } =
        implementation.get<typeof import("../../../src/domain/store/public")>(
          "domain/store/public",
        );
      const fixture = createStandardDomainFixture();
      const store = new ElementStore(fixture.elements);
      const original = structuredClone(
        store.get(kind === "endpoints" ? fixture.connectedTargetId : fixture.strokeIds[0]!)!
          .element,
      ) as InkElementV1;
      const originalBands = {
        content: store.materializeBandOrder("content"),
        highlight: store.materializeBandOrder("highlight"),
      };
      const selected = new Set(fixture.strokeIds.filter((_, index) => index % 2 === 0));
      const stable = store.get(fixture.strokeIds[9_999]!);
      let replacement = original;
      let paintSamples: number[] = [];
      return {
        reset() {
          if (kind === "arrange") store.reorderBands(originalBands);
          if (kind === "endpoints" || kind === "paint") store.replace(original.id, original);
          replacement = structuredClone(original);
          paintSamples = [];
          if (kind === "endpoints" && replacement.kind === "rectangle") {
            replacement.x += 1;
            replacement.pivot.x += 1;
          }
          store.resetInstrumentation();
        },
        run() {
          if (kind === "paint") {
            let delta: ReturnType<typeof store.replace> = null;
            for (const opacity of [0.99, 1]) {
              const paint = structuredClone(original) as StrokeElementV1;
              paint.style.opacity = opacity;
              const started = performance.now();
              delta = store.replace(paint.id, paint);
              paintSamples.push(performance.now() - started);
            }
            return delta;
          }
          return kind === "arrange"
            ? store.arrange(selected, "bring-to-front")
            : store.replace(replacement.id, replacement);
        },
        ...(kind === "paint" ? { measurementSamples: () => paintSamples } : {}),
        verify(result) {
          const delta = result as ReturnType<typeof store.replace>;
          assert.ok(delta !== null);
          assert.equal(store.instrumentation.fullStoreScans, 0);
          assert.equal(store.instrumentation.snapshotMaterializations, 0);
          if (kind === "endpoints") {
            assert.equal(delta.changes.length, 257);
            assert.equal(store.instrumentation.reverseDependencyVisits, 512);
          } else if (kind === "arrange") {
            assert.ok(delta.changes.length >= 10_000);
            assert.equal(store.instrumentation.recordReplacements, 0);
          } else {
            assert.equal(delta.changes.length, 1);
            assert.equal(paintSamples.length, 2);
            assert.equal(store.instrumentation.recordReplacements, 2);
            assert.equal(store.get(fixture.strokeIds[9_999]!), stable);
          }
        },
        dispose() {},
      };
    },
  })),
];
