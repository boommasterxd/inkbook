import { describe, expect, it } from "vitest";
import { prepareArrangementMutation } from "../../../../../src/domain/store/mutations/arrangement-mutation";
import { ElementStore } from "../../../../../src/domain/store/public";
import type { ElementRank } from "../../../../../src/domain/store/types";
import { highlighter, rectangle } from "../fixtures";

const immediate = { shouldYield: () => false, yieldControl: () => Promise.resolve() };

function arrangementSource() {
  const content = Array.from({ length: 5 }, (_, index) => `item-${index}`);
  const ranks = new Map<string, ElementRank>(
    content.map((id, rank) => [id, { band: "content", rank }]),
  );
  return { bands: { content, highlight: [] as string[] }, ranks };
}

describe("private arrangement preparation", () => {
  it("ignores missing selection IDs without accessing or copying a band", async () => {
    const source = arrangementSource();
    await expect(
      prepareArrangementMutation(source, "bring-forward", new Set(["missing"]), immediate),
    ).resolves.toBeNull();
    expect(source.bands.content).toEqual(["item-0", "item-1", "item-2", "item-3", "item-4"]);
  });

  it.each(["selection", "range", "permutation", "band-copy", "final"] as const)(
    "cancels at the %s boundary without changing authoritative arrays or ranks",
    async (phase) => {
      const source = arrangementSource();
      const original = [...source.bands.content];
      let reads = 0;
      let rankReads = 0;
      let cancelled = phase === "selection";
      const ranks = new Proxy(source.ranks, {
        get(target, key) {
          if (key === "get")
            return (id: string) => {
              rankReads += 1;
              return target.get(id);
            };
          return Reflect.get(target, key, target) as unknown;
        },
      });
      const content = new Proxy(source.bands.content, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/u.test(key)) {
            reads += 1;
            if (phase === "final" && key === "4") cancelled = true;
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const prepared = await prepareArrangementMutation(
        { bands: { content, highlight: [] }, ranks },
        "bring-forward",
        new Set(["item-1"]),
        {
          isCancelled: () => cancelled,
          shouldYield: () =>
            (phase === "range" && rankReads > 0) ||
            (phase === "permutation" && reads >= 2) ||
            (phase === "band-copy" && reads >= 3),
          yieldControl: async () => {
            cancelled = true;
          },
        },
      );
      expect(prepared).toBe("cancelled");
      expect(source.bands.content).toEqual(original);
      for (const [id, rank] of source.ranks) expect(rank.rank).toBe(original.indexOf(id));
    },
  );

  it("rejects a Store mutation during preparation and an overtaken prepared token", async () => {
    const first = rectangle();
    const second = rectangle("00000000-0000-4000-8000-000000000020");
    const store = new ElementStore([first, second]);
    const cancelled = await store.prepareElementArrangement("bring-forward", new Set([first.id]), {
      shouldYield: () => true,
      yieldControl: async () => {
        store.create(highlighter());
      },
    });
    expect(cancelled).toEqual({ status: "cancelled", token: null });
    expect(store.getRank(first.id)?.rank).toBe(0);
    const prepared = await store.prepareElementArrangement(
      "bring-forward",
      new Set([first.id]),
      immediate,
    );
    expect(prepared.status).toBe("prepared");
    store.remove([highlighter().id]);
    expect(store.commitPreparedElementMutation(prepared.token!).status).toBe("cancelled");
    expect(store.getRank(first.id)?.rank).toBe(0);
  });
});
