import { afterEach, expect, it, vi } from "vitest";

import { renderBandOf } from "../../../src/domain/commands/render-bands";
import { ElementStore } from "../../../src/domain/store/public";
import { prepareRemovalMutation } from "../../../src/domain/store/removal-mutation";
import * as mutationOrder from "../../../src/domain/store/mutation-order";
import { prepareMutationHistory } from "../../../src/domain/store/mutation-history";
import { MutationPreparationScheduler } from "../../../src/domain/store/mutation-preparation-scheduler";
import { uninterruptedMutationScheduler as scheduler } from "../../fixtures/domain/element-mutation";
import { createStandardDomainFixture } from "./standard-domain-fixture";

afterEach(() => vi.restoreAllMocks());

function observeRankWrites() {
  let writes = 0;
  const create = mutationOrder.createUnchangedMutationOrder;
  vi.spyOn(mutationOrder, "createUnchangedMutationOrder").mockImplementation((bands) => {
    const order = create(bands);
    const set = order.ranks.set.bind(order.ranks);
    vi.spyOn(order.ranks, "set").mockImplementation((id, position) => {
      writes += 1;
      return set(id, position);
    });
    return order;
  });
  return () => writes;
}

function observeBand(values: readonly string[]) {
  let reads = 0;
  const band = new Proxy([...values], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    band,
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

function fixture() {
  const elements = createStandardDomainFixture()
    .elements.slice(0, 10_000)
    .map((element, index) => {
      if (element.kind !== "stroke") throw new Error("Expected stroke fixture.");
      return index % 2 === 0
        ? element
        : {
            ...element,
            tool: "highlighter" as const,
            style: { ...element.style, pressureEnabled: false },
          };
    });
  const store = new ElementStore(elements);
  const content = observeBand(store.materializeBandOrder("content"));
  const highlight = observeBand(store.materializeBandOrder("highlight"));
  return {
    content,
    highlight,
    source: {
      bands: { content: content.band, highlight: highlight.band },
      records: new Map(elements.map(({ id }) => [id, store.get(id)!])),
      ranks: new Map(elements.map(({ id }) => [id, store.getRank(id)!])),
    },
  };
}

it.each([1_000, 2_000])(
  "prepares private removal and shared history bands with one public copy in a mixed 10,000-stroke document (%i selected)",
  async (selectionSize) => {
    const { source, content, highlight } = fixture();
    const selected = source.bands.content.slice(0, selectionSize);
    content.reset();
    const rankWrites = observeRankWrites();
    const rankReads = vi.spyOn(source.ranks, "get");
    const membershipReads = vi.spyOn(source.records, "has");
    const prepared = await prepareRemovalMutation(selected, source, scheduler);
    if (prepared === null || prepared === "cancelled") throw new Error("Expected removal.");
    // Numeric reads observe the actual ID-copy/filter boundary, including untouched public bands.
    expect(content.reads()).toBe(5_000);
    expect(highlight.reads()).toBe(5_000);
    expect(prepared.order.bands.highlight).toBe(source.bands.highlight);
    expect(prepared.order.bands.content).not.toBe(prepared.mutation.bands.content);
    expect(prepared.order.ranks.size).toBe(5_000 - selectionSize);
    expect(rankWrites()).toBe(5_000 - selectionSize);
    expect(rankReads).toHaveBeenCalledTimes(selectionSize);
    expect(membershipReads).toHaveBeenCalledTimes(selectionSize);
    expect(prepared.order.dirtyBands).toEqual({ content: true, highlight: false });
    for (const [id, position] of prepared.order.ranks) {
      expect(prepared.order.bands.content[position.rank]).toBe(id);
      expect(renderBandOf(source.records.get(id)!.element)).toBe("content");
    }
    content.reset();
    highlight.reset();
    const transition = await prepareMutationHistory(
      {
        requested: prepared.mutation,
        source,
        desired: new Map(),
        removeIds: new Set(selected),
        dirtyBands: prepared.order.dirtyBands,
      },
      new MutationPreparationScheduler(scheduler),
      undefined,
      true,
    );
    if (transition === "cancelled") throw new Error("Unexpected cancellation.");
    expect(content.reads()).toBe(5_000);
    expect(highlight.reads()).toBe(0);
    expect(transition.reverse.bands.highlight).toBe(transition.forward.bands.highlight);
    expect(transition.reverse.bands.content).toEqual(source.bands.content);
    expect(transition.reverse.elements?.length).toBe(selectionSize);
    expect(source.records.size).toBe(10_000);
    expect(source.bands.content.length).toBe(5_000);
    expect(source.bands.highlight.length).toBe(5_000);
  },
);
