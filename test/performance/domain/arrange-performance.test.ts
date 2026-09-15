import { beforeAll, describe, expect, it } from "vitest";

import type { ArrangeAction } from "../../../src/domain/commands/arrange";
import { arrangeElement } from "./arrange-fixture";
import { ElementStore } from "../../../src/domain/store/public";
import {
  annotateDurations,
  collectProfileGarbage,
  summarizeDurations,
} from "../persistence/metrics";
import { expectTiming } from "../timing-assertions";

const ELEMENT_COUNT = 10_000;
const SAMPLE_COUNT = 10;
const COMMAND_COMMIT_BUDGET_MS = 12;
const actions: readonly ArrangeAction[] = [
  "bring-forward",
  "send-backward",
  "bring-to-front",
  "send-to-back",
];

let originalOrder: readonly string[];
let selected: ReadonlySet<string>;
let store: ElementStore;

beforeAll(() => {
  const elements = Array.from({ length: ELEMENT_COUNT }, (_, index) => arrangeElement(index));
  originalOrder = elements.map(({ id }) => id);
  selected = new Set(originalOrder.filter((_, index) => index % 2 === 0));
  store = new ElementStore(elements);
});

describe("arrange command performance", () => {
  it("commits all four operations for an alternating 5,000-element selection within budget", async ({
    annotate,
  }) => {
    for (const action of actions) {
      store.reorderBands({ content: originalOrder, highlight: [] });
      store.arrange(selected, action);
      const durations: number[] = [];
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        store.reorderBands({ content: originalOrder, highlight: [] });
        store.resetInstrumentation();
        const started = performance.now();
        const delta = store.arrange(selected, action);
        durations.push(performance.now() - started);
        expect(delta?.changes.length).toBeGreaterThanOrEqual(ELEMENT_COUNT - 2);
        expect(store.instrumentation).toMatchObject({
          bandScans: 2,
          fullStoreScans: 0,
          recordReplacements: 0,
        });
        collectProfileGarbage();
      }

      await annotateDurations(annotate, action, durations);
      expectTiming(summarizeDurations(durations).p95, COMMAND_COMMIT_BUDGET_MS, { soft: true });
    }
  });
});
