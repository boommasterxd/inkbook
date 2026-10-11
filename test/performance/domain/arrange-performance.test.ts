import { beforeAll, describe, expect, it } from "vitest";

import { arrangeRenderBandSteps, type ArrangeAction } from "../../../src/domain/commands/arrange";
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

function alternatingOrder(action: ArrangeAction): readonly string[] {
  if (action === "bring-to-front" || action === "send-to-back") {
    const even = originalOrder.filter((_, index) => index % 2 === 0);
    const odd = originalOrder.filter((_, index) => index % 2 !== 0);
    return action === "bring-to-front" ? [...odd, ...even] : [...even, ...odd];
  }
  const expected = [...originalOrder];
  const start = action === "bring-forward" ? 0 : 1;
  const end = action === "bring-forward" ? expected.length : expected.length - 1;
  for (let index = start; index < end; index += 2) {
    expected[index] = originalOrder[index + 1]!;
    expected[index + 1] = originalOrder[index]!;
  }
  return expected;
}

beforeAll(() => {
  const elements = Array.from({ length: ELEMENT_COUNT }, (_, index) => arrangeElement(index));
  originalOrder = elements.map(({ id }) => id);
  selected = new Set(originalOrder.filter((_, index) => index % 2 === 0));
  store = new ElementStore(elements);
});

describe("arrange command work bounds", () => {
  it("bounds source ID reads per checkpoint for large selections and no-ops", () => {
    const source = Object.freeze([...originalOrder]);
    for (const action of actions) {
      for (const selection of [selected, new Set<string>(), new Set(source)]) {
        let reads = 0;
        let predicateCalls = 0;
        const counted = new Proxy(source, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
        });
        const steps = arrangeRenderBandSteps(
          counted,
          (id) => {
            predicateCalls += 1;
            return selection.has(id);
          },
          action,
        );
        let result;
        do {
          const previousReads = reads;
          result = steps.next();
          expect(reads - previousReads).toBeLessThanOrEqual(256);
        } while (!result.done);
        expect(reads).toBeLessThanOrEqual(ELEMENT_COUNT * 2);
        expect(predicateCalls).toBe(ELEMENT_COUNT);
        if (selection.size !== selected.size) {
          expect(result.value).toEqual({ elements: counted, changed: false });
          expect(result.value.elements).toBe(counted);
        } else {
          expect(result.value).toEqual({ elements: alternatingOrder(action), changed: true });
        }
      }
    }
    expect(source).toEqual(originalOrder);
  });

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
