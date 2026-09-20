import { describe, expect, it } from "vitest";
import type { LineElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { validateMutationConnectionCycles } from "../../../../src/domain/store/mutation-connection-validation";
import { connectedLine, mixedElement } from "./fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

function chain(count: number): LineElementV1[] {
  const ids = Array.from({ length: count }, (_, index) => mixedElement(index).id);
  return ids.map((id, index) => ({
    ...connectedLine(),
    id,
    startConnection:
      index + 1 === count
        ? null
        : {
            anchor: { endpoint: "start", kind: "linear-endpoint" },
            targetId: ids[index + 1]!,
          },
  }));
}

describe("mutation connection validation", () => {
  it.each([2, 514])(
    "rejects a %i-element cycle in the explicit or fallback full planner",
    async (count) => {
      const elements = chain(count);
      const store = new ElementStore(elements);
      const original = store.materializeBandOrder("content");
      const last = elements[elements.length - 1]!;
      const replacement: LineElementV1 = {
        ...last,
        startConnection: {
          anchor: { endpoint: "start", kind: "linear-endpoint" },
          targetId: elements[0]!.id,
        },
      };
      const bands = count === 2 ? { content: original, highlight: [] } : undefined;
      await expect(
        store.prepareElementMutation(
          { ...(bands === undefined ? {} : { bands }), elements: [replacement] },
          scheduler,
        ),
      ).rejects.toThrow(/cycle/);
      expect(store.get(last.id)?.element).toEqual(last);
      expect(store.materializeBandOrder("content")).toEqual(original);
      expect(store.instrumentation.publishedDeltas).toBe(0);
    },
  );

  it("checks a long acyclic graph and permits cancellation at dependency checkpoints", async () => {
    const elements = chain(514);
    const store = new ElementStore(elements);
    const records = new Map(elements.map(({ id }) => [id, store.get(id)!]));
    let yields = 0;
    expect(
      await validateMutationConnectionCycles(records, {
        shouldYield: () => true,
        yieldControl: async () => {
          yields += 1;
        },
      }),
    ).toBe("valid");
    expect(yields).toBeGreaterThan(elements.length);
    let cancelled = false;
    expect(
      await validateMutationConnectionCycles(records, {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      }),
    ).toBe("cancelled");
  });
});
