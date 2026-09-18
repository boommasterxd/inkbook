import { beforeAll, describe, expect, it } from "vitest";

import type { ArrangeAction } from "../../../src/domain/commands/arrange";
import { ElementStore } from "../../../src/domain/store/public";
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

describe("arrange command work bounds", () => {
  it("bounds all four operations for an alternating 5,000-element selection", () => {
    for (const action of actions) {
      store.reorderBands({ content: originalOrder, highlight: [] });
      store.resetInstrumentation();
      const delta = store.arrange(selected, action);
      expect(delta).not.toBeNull();
      expect(delta!.changes.length).toBeGreaterThanOrEqual(ELEMENT_COUNT - 2);
      expect(store.instrumentation).toMatchObject({
        bandScans: 2,
        fullStoreScans: 0,
        recordReplacements: 0,
      });
    }
  });
});
