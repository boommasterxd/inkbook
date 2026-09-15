import { assert } from "vitest";

import { createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { createStandardRuntimeDomainFixture } from "../domain/standard-domain-fixture";
import type { ComparisonScenario } from "./contracts";
import { DomainComparisonScheduler } from "./domain-scheduler";

export const DOMAIN_HYDRATION_SCENARIOS: readonly ComparisonScenario[] = [false, true].map(
  (slices) => ({
    id: slices ? "domain-hydration-slices" : "domain-hydration-total",
    statistics: slices
      ? [
          { kind: "p95", population: "samples" },
          { kind: "max", population: "samples" },
        ]
      : [{ kind: "total", population: "operations" }],
    modules: [
      "domain/store/public",
      "domain/schema/snapshot-validation",
      "persistence/worker/runtime/unlock-batch-limits",
    ],
    covers: [
      {
        file: "test/performance/domain/runtime-hydration-performance.test.ts",
        test: "builds a complete initial store in cancellable bounded slices",
        ordinals: slices ? [2, 3] : [1],
      },
    ],
    execution: "async",

    warmupOperations: 1,
    create(implementation, refreshRate) {
      const { ElementStore } =
        implementation.get<typeof import("../../../src/domain/store/public")>(
          "domain/store/public",
        );
      const { validateRuntimeInkSnapshotV1 } = implementation.get<
        typeof import("../../../src/domain/schema/snapshot-validation")
      >("domain/schema/snapshot-validation");
      const { MAX_UNLOCK_BATCH_ELEMENTS } = implementation.get<
        typeof import("../../../src/persistence/worker/runtime/unlock-batch-limits")
      >("persistence/worker/runtime/unlock-batch-limits");
      const fixture = createStandardRuntimeDomainFixture();
      const validation = validateRuntimeInkSnapshotV1(createWorkerSnapshot([...fixture.elements]));
      assert.ok(validation.ok);
      const scheduler = new DomainComparisonScheduler(Math.ceil(550 / refreshRate / 0.05));
      let builder = ElementStore.createBuilder(scheduler);
      let store: InstanceType<typeof ElementStore> | null = null;
      const derivations = validation.derivations.elements;
      return {
        reset() {
          store = null;
          builder = ElementStore.createBuilder(scheduler);
        },
        async run() {
          scheduler.start();
          for (let start = 0; start < fixture.elements.length; start += MAX_UNLOCK_BATCH_ELEMENTS) {
            const end = start + MAX_UNLOCK_BATCH_ELEMENTS;
            const status = await builder.appendOwnedValidatedRuntime(
              fixture.elements.slice(start, end),
              derivations.slice(start, end),
            );
            if (status !== "accepted") throw new Error(`Hydration batch was ${status}`);
          }
          store = await builder.finalize();
          scheduler.finish();
          return store;
        },
        ...(slices ? { measurementSamples: () => scheduler.samples } : {}),
        verify() {
          assert.equal(store?.size, 11_000);
          assert.equal(store?.instrumentation.hydrationElementVisits, 22_000);
          assert.equal(store?.instrumentation.publishedDeltas, 0);
          assert.ok(scheduler.samples.length >= 100);
        },
        dispose() {
          store = null;
        },
      };
    },
  }),
);
