import { assert } from "vitest";

import type { ArrangeAction } from "../../../src/domain/commands/arrange";
import { arrangeElement } from "../domain/arrange-fixture";
import type { ComparisonScenario } from "./contracts";

const actions: readonly ArrangeAction[] = [
  "bring-forward",
  "send-backward",
  "bring-to-front",
  "send-to-back",
];

export const DOMAIN_ARRANGE_SCENARIOS: readonly ComparisonScenario[] = actions.map(
  (action, index) => ({
    id: `domain-arrange-${action}`,
    modules: ["domain/store/public"],
    covers: [
      {
        file: "test/performance/domain/arrange-performance.test.ts",
        test: "commits all four operations",
        ordinals: [index + 1],
      },
    ],
    statistics: [{ kind: "p95", population: "samples" }],
    execution: "sync",

    warmupOperations: 20,
    create(implementation) {
      const { ElementStore } =
        implementation.get<typeof import("../../../src/domain/store/public")>(
          "domain/store/public",
        );
      const elements = Array.from({ length: 10_000 }, (_, elementIndex) =>
        arrangeElement(elementIndex),
      );
      const originalOrder = elements.map(({ id }) => id);
      const selected = new Set(originalOrder.filter((_, elementIndex) => elementIndex % 2 === 0));
      const store = new ElementStore(elements);
      return {
        reset() {
          store.reorderBands({ content: originalOrder, highlight: [] });
          store.resetInstrumentation();
        },
        run() {
          return store.arrange(selected, action);
        },
        verify(result) {
          const delta = result as ReturnType<typeof store.arrange>;
          assert.ok((delta?.changes.length ?? 0) >= 9_998);
          assert.equal(store.instrumentation.bandScans, 2);
          assert.equal(store.instrumentation.fullStoreScans, 0);
          assert.equal(store.instrumentation.recordReplacements, 0);
        },
        dispose() {},
      };
    },
  }),
);
