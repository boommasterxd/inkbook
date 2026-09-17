import { beforeAll, describe, expect, it } from "vitest";

import type { ArrangeAction } from "../../../src/domain/commands/arrange";
import { ElementStore } from "../../../src/domain/store/public";
import {
  annotateDurations,
  collectProfileGarbage,
  summarizeDurations,
} from "../persistence/metrics";
import { expectTiming } from "../timing-assertions";
import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";

function arrangeElement(index: number): BoxShapeElementV1 {
  const x = 25 + (index % 100) * 18;
  const y = 25 + Math.floor(index / 100) * 18;
  return {
    createdAt: index,
    height: 8,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "rectangle",
    pivot: { x: x + 4, y: y + 4 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 8,
    x,
    y,
  };
}

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
      const durations = new Array<number>(SAMPLE_COUNT);
      let incorrectChanges = 0;
      let incorrectBandScans = 0;
      let incorrectFullStoreScans = 0;
      let incorrectRecordReplacements = 0;
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        store.reorderBands({ content: originalOrder, highlight: [] });
        store.resetInstrumentation();
        const started = performance.now();
        const delta = store.arrange(selected, action);
        durations[sample] = performance.now() - started;
        if (delta === null || !(delta.changes.length >= ELEMENT_COUNT - 2)) incorrectChanges += 1;
        const instrumentation = store.instrumentation;
        if (!Object.is(instrumentation.bandScans, 2)) incorrectBandScans += 1;
        if (!Object.is(instrumentation.fullStoreScans, 0)) incorrectFullStoreScans += 1;
        if (!Object.is(instrumentation.recordReplacements, 0)) incorrectRecordReplacements += 1;
        collectProfileGarbage();
      }

      expect(incorrectChanges).toBe(0);
      expect(incorrectBandScans).toBe(0);
      expect(incorrectFullStoreScans).toBe(0);
      expect(incorrectRecordReplacements).toBe(0);
      await annotateDurations(annotate, action, durations);
      expectTiming(summarizeDurations(durations).p95, COMMAND_COMMIT_BUDGET_MS, { soft: true });
    }
  });
});
