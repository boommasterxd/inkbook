import { createSnapshot } from "../../unit/persistence/serialization/fixtures";
import {
  createPressureGroupFixture,
  createRetainedCapacityRectangle,
} from "../persistence/fixtures";
import type { ComparisonScenario } from "./contracts";

type Serialization = typeof import("../../../src/persistence/serialization/public");
type Integrity = typeof import("../../../src/persistence/serialization/streaming-static-integrity");
export const PERSISTENCE_VALIDATION_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "persistence-pressure-integrity",
    modules: [
      "persistence/serialization/public",
      "persistence/serialization/streaming-static-integrity",
    ],
    covers: [
      {
        file: "test/performance/persistence/pressure-group-integrity.test.ts",
        test: "verifies 10,000 pressure groups",
        ordinals: [1],
      },
    ],
    execution: "sync",
    statistics: [{ kind: "max", population: "operations" }],

    warmupOperations: 1,
    create(implementation) {
      const serialization = implementation.get<Serialization>("persistence/serialization/public");
      const { StreamingStaticIntegrityMatcher } = implementation.get<Integrity>(
        "persistence/serialization/streaming-static-integrity",
      );
      const snapshot = createPressureGroupFixture();
      const serialized = serialization.serializeInkbookDocument(snapshot);
      if (!serialized.ok) throw new Error(serialized.error.code);
      const current = serialized.value.svg.slice(
        serialized.value.svg.indexOf('<g id="inkbook-background">'),
      );
      return {
        run() {
          const matcher = new StreamingStaticIntegrityMatcher(
            snapshot,
            serialized.value.lockedHeight,
          );
          for (let offset = 0; offset < current.length; offset += 16 * 1024)
            if (!matcher.write(current.slice(offset, offset + 16 * 1024))) return false;
          return matcher.finish();
        },
        verify(result) {
          if (result !== true) throw new Error("Pressure integrity rejected canonical groups.");
        },
        dispose() {},
      };
    },
  },
  {
    id: "persistence-retained-capacity",
    modules: ["persistence/serialization/public"],
    covers: [
      {
        file: "test/performance/persistence/incremental-validation-capacity.test.ts",
        test: "updates retained serializer capacity",
        ordinals: [1],
      },
    ],
    execution: "sync",
    statistics: [{ kind: "max", population: "operations" }],

    warmupOperations: 1,
    create(implementation) {
      const { IncrementalDocumentSerializer } = implementation.get<Serialization>(
        "persistence/serialization/public",
      );
      const elements = Array.from({ length: 20_000 }, (_, index) =>
        createRetainedCapacityRectangle(index + 1),
      );
      const serializer = new IncrementalDocumentSerializer();
      return {
        reset() {
          if (!serializer.reset(createSnapshot(elements)).ok)
            throw new Error("Capacity fixture failed.");
        },
        run() {
          for (let revision = 8; revision < 108; revision += 1) {
            const offset = revision % 2;
            const result = serializer.applyDelta({
              baseModelRevision: revision - 1,
              changedElements: [
                { ...elements[0]!, pivot: { x: 150 + offset, y: 150 }, x: 100 + offset },
              ],
              modelRevision: revision,
            });
            if (!result.ok) return false;
          }
          return true;
        },
        verify(result) {
          if (result !== true) throw new Error("Retained capacity delta failed.");
        },
        dispose: () => serializer.clear(),
      };
    },
  },
];
