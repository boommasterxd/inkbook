import { beforeAll, describe, expect, it, vi } from "vitest";

import { arrangeRenderBandSteps, type ArrangeAction } from "../../../src/domain/commands/arrange";
import { ElementStore } from "../../../src/domain/store/public";
import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";
import { prepareArrangementMutation } from "../../../src/domain/store/arrangement-mutation";
import type { ElementRank } from "../../../src/domain/store/types";
import { ElementStoreOrdering } from "../../../src/domain/store/order-operations";

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

describe("arrange locality work bounds", () => {
  it.each(actions)("refreshes only changed authoritative rank slots for %s", (action) => {
    store.reorderBands({ content: originalOrder, highlight: [] });
    store.resetInstrumentation();
    const selectedIndex =
      action === "bring-to-front" ? ELEMENT_COUNT - 2 : action === "send-to-back" ? 1 : 100;
    const refresh = vi.spyOn(ElementStoreOrdering.prototype, "refresh");
    try {
      const delta = store.arrange(new Set([originalOrder[selectedIndex]!]), action)!;
      expect(delta.changes).toHaveLength(2);
      expect(refresh).toHaveBeenCalledTimes(2);
      for (const [band, start, , publishOrder, end] of refresh.mock.calls) {
        expect(band).toBe("content");
        expect(publishOrder).toBe(true);
        expect(end).toBe(start + 1);
      }
      expect(store.instrumentation).toMatchObject({ bandScans: 1, recordReplacements: 0 });
    } finally {
      refresh.mockRestore();
    }
  });
  it.each(actions)(
    "prepares only the touched band and affected dense ranks for %s",
    async (action) => {
      let contentReads = 0;
      let highlightReads = 0;
      const observe = (ids: readonly string[], onRead: () => void) =>
        new Proxy(ids, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/u.test(key)) onRead();
            return Reflect.get(target, key, receiver) as unknown;
          },
        });
      const content = originalOrder.slice(0, ELEMENT_COUNT / 2);
      const highlight = originalOrder.slice(ELEMENT_COUNT / 2);
      const ranks = new Map<string, ElementRank>();
      content.forEach((id, rank) => ranks.set(id, { band: "content", rank }));
      highlight.forEach((id, rank) => ranks.set(id, { band: "highlight", rank }));
      const rankReads = vi.spyOn(ranks, "get");
      try {
        const source = {
          bands: {
            content: observe(content, () => {
              contentReads += 1;
            }),
            highlight: observe(highlight, () => {
              highlightReads += 1;
            }),
          },
          ranks,
        };
        const selectedIndex =
          action === "bring-to-front" ? content.length - 2 : action === "send-to-back" ? 1 : 100;
        const prepared = await prepareArrangementMutation(
          source,
          action,
          new Set([content[selectedIndex]!]),
          {
            shouldYield: () => false,
            yieldControl: () => Promise.resolve(),
          },
        );
        expect(prepared).not.toBeNull();
        if (prepared === null || prepared === "cancelled")
          throw new Error("Expected arrangement plan.");
        expect(contentReads).toBe(content.length);
        expect(highlightReads).toBe(0);
        expect(rankReads).toHaveBeenCalledTimes(1);
        expect(prepared.order.ranks.size).toBe(2);
        expect(prepared.order.dirtyBands).toEqual({ content: true, highlight: false });
        expect(prepared.order.bands.highlight).toBe(source.bands.highlight);
        expect(content).toEqual(originalOrder.slice(0, ELEMENT_COUNT / 2));
      } finally {
        rankReads.mockRestore();
      }
    },
  );
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
        bandScans: 1,
        fullStoreScans: 0,
        recordReplacements: 0,
      });
    }
  });
});
