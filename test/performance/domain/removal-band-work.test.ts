import { afterEach, expect, it, vi } from "vitest";

import { renderBandOf } from "../../../src/domain/commands/render-bands";
import { ElementStore } from "../../../src/domain/store/public";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { validateRuntimeInkSnapshotV1 } from "../../../src/domain/schema/snapshot-validation";
import type { ElementRank } from "../../../src/domain/store/types";
import { prepareRemovalMutation } from "../../../src/domain/store/mutations/removal-mutation";
import * as mutationOrder from "../../../src/domain/store/mutations/mutation-order";
import * as mutationRecordPatch from "../../../src/domain/store/mutations/mutation-record-patch";
import { prepareMutationHistory } from "../../../src/domain/store/mutations/mutation-history";
import { MutationPreparationScheduler } from "../../../src/domain/store/mutations/mutation-preparation-scheduler";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import { elementMutationPayloadBytes } from "../../../src/domain/store/mutations/mutation-payload";
import { uninterruptedMutationScheduler as scheduler } from "../../fixtures/domain/element-mutation";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { createStandardDomainFixture } from "./standard-domain-fixture";

afterEach(() => vi.restoreAllMocks());

function forwardRankWrites(ranks: Map<string, ElementRank>, onWrite: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(ranks, "set");
  const set = ranks.set.bind(ranks);
  ranks.set = (id, rank) => {
    onWrite();
    return set(id, rank);
  };
  return () => {
    if (descriptor === undefined) Reflect.deleteProperty(ranks, "set");
    else Object.defineProperty(ranks, "set", descriptor);
  };
}

function observeRankWrites() {
  let writes = 0;
  let order: ReturnType<typeof mutationOrder.createUnchangedMutationOrder> | undefined;
  let restoreSet: () => void = () => undefined;
  const create = mutationOrder.createUnchangedMutationOrder;
  const spy = vi
    .spyOn(mutationOrder, "createUnchangedMutationOrder")
    .mockImplementation((bands) => {
      restoreSet();
      order = create(bands);
      restoreSet = forwardRankWrites(order.ranks, () => {
        writes += 1;
      });
      return order;
    });
  return {
    count: () => writes,
    order: () => order,
    restore: () => {
      restoreSet();
      spy.mockRestore();
    },
  };
}

function observeCommitRankWrites() {
  const work = { writes: 0, swapped: false };
  const apply = mutationRecordPatch.applyMutationRecordPatches;
  const spy = vi
    .spyOn(mutationRecordPatch, "applyMutationRecordPatches")
    .mockImplementation((records, ranks, plan) => {
      const restore = forwardRankWrites(ranks, () => {
        work.writes += 1;
      });
      try {
        const result = apply(records, ranks, plan);
        work.swapped = result !== ranks;
        return result;
      } finally {
        restore();
      }
    });
  return { work, restore: () => spy.mockRestore() };
}

function observeBand(values: readonly string[]) {
  const { observed: band, work } = observeSchemaArray([...values]);
  return {
    band,
    reads: () => work.indexedReads,
    descriptors: () => work.descriptorReads,
    reset: () => {
      work.indexedReads = 0;
      work.descriptorReads = 0;
    },
  };
}

function fixture(highlightEvery = 2) {
  const elements = createStandardDomainFixture()
    .elements.slice(0, 10_000)
    .map((element, index) => {
      if (element.kind !== "stroke") throw new Error("Expected stroke fixture.");
      return highlightEvery === 0 || index % highlightEvery !== highlightEvery - 1
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
    store,
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
  "shares immutable removal snapshots without reading untouched bands in a mixed 10,000-stroke document (%i selected)",
  async (selectionSize) => {
    const { source, content, highlight } = fixture();
    const selected = source.bands.content.slice(0, selectionSize);
    content.reset();
    const rankWrites = observeRankWrites();
    let rankReads = 0;
    let membershipReads = 0;
    const getRank = source.ranks.get.bind(source.ranks);
    const hasRecord = source.records.has.bind(source.records);
    source.ranks.get = (id) => {
      rankReads += 1;
      return getRank(id);
    };
    source.records.has = (id) => {
      membershipReads += 1;
      return hasRecord(id);
    };
    const prepared = await prepareRemovalMutation(selected, source, scheduler);
    if (prepared === null || prepared === "cancelled") throw new Error("Expected removal.");
    // Observe the real ID filter boundary. Frozen untouched bands need no ID traversal.
    expect(content.reads()).toBe(5_000);
    expect(highlight.reads()).toBe(0);
    expect(prepared.order.bands.highlight).toBe(source.bands.highlight);
    expect(prepared.order.bands.content).toBe(prepared.mutation.bands.content);
    expect(prepared.order.ranks.size).toBe(5_000 - selectionSize);
    expect(rankWrites.count()).toBe(5_000 - selectionSize);
    expect(rankReads).toBe(selectionSize);
    expect(membershipReads).toBe(selectionSize);
    rankWrites.restore();
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
    expect(content.reads()).toBe(0);
    expect(highlight.reads()).toBe(0);
    expect(transition.reverse.bands.highlight).toBe(transition.forward.bands.highlight);
    expect(transition.reverse.bands.content).toEqual(source.bands.content);
    expect(transition.reverse.elements?.length).toBe(selectionSize);
    expect(source.records.size).toBe(10_000);
    expect(source.bands.content.length).toBe(5_000);
    expect(source.bands.highlight.length).toBe(5_000);
    content.reset();
    highlight.reset();
    const repeated = await prepareRemovalMutation(selected, source, scheduler);
    if (repeated === null || repeated === "cancelled") throw new Error("Expected removal.");
    expect(highlight.reads()).toBe(0);
    expect(highlight.descriptors()).toBe(0);
    expect(repeated.mutation.bands.highlight).toBe(transition.forward.bands.highlight);
  },
);

it.each([
  { start: 237, complete: true, changed: 9_531 },
  { start: 4_884, complete: false, changed: 4_884 },
  { start: 9_740, complete: false, changed: 28 },
])(
  "prepares and commits 232 removals with $changed survivor rank changes (complete=$complete)",
  async ({ start, complete, changed }) => {
    const { store, source } = fixture(0);
    const selected = source.bands.content.slice(start, start + 232);
    const originalRank = store.getRank(source.bands.content[start + 232]!)!;
    const preparation = observeRankWrites();
    const commit = observeCommitRankWrites();
    try {
      const prepared = await store.prepareElementRemoval(selected, scheduler);
      if (prepared.token === null) throw new Error("Expected removal.");
      expect(preparation.order()?.ranksComplete).toBe(complete);
      expect(preparation.count()).toBe(complete ? 9_768 : changed);
      preparation.restore();
      expect(commit.work.writes).toBe(0);
      expect(store.size).toBe(10_000);
      expect(store.getRank(source.bands.content[start + 232]!)).toEqual(originalRank);
      expect(store.commitPreparedElementMutation(prepared.token).status).toBe("committed");
      expect(commit.work.writes).toBe(complete ? 0 : changed);
      expect(commit.work.swapped).toBe(complete);
      expect(store.size).toBe(9_768);
      expect(store.getRank(source.bands.content[start + 232]!)).toEqual({
        band: "content",
        rank: start,
      });
      expect(originalRank.rank).toBe(start + 232);
    } finally {
      preparation.restore();
      commit.restore();
    }
  },
);

it("builds a complete rank map once while reusing prefix and untouched-band rank objects", async () => {
  const { source, content, highlight } = fixture(10);
  const selected = source.bands.content.slice(237, 469);
  content.reset();
  const writes = observeRankWrites();
  try {
    const prepared = await prepareRemovalMutation(selected, source, scheduler);
    if (prepared === null || prepared === "cancelled") throw new Error("Expected removal.");
    expect(prepared.order.ranksComplete).toBe(true);
    expect(content.reads()).toBe(9_000);
    expect(highlight.reads()).toBe(1_000);
    expect(writes.count()).toBe(9_768);
    expect(prepared.order.ranks.size).toBe(9_768);
    for (const id of source.bands.content.slice(0, 237)) {
      expect(prepared.order.ranks.get(id)).toBe(source.ranks.get(id));
    }
    for (const id of source.bands.highlight) {
      expect(prepared.order.ranks.get(id)).toBe(source.ranks.get(id));
    }
    const shifted = source.bands.content[469]!;
    expect(prepared.order.ranks.get(shifted)).not.toBe(source.ranks.get(shifted));
    expect(prepared.order.ranks.get(shifted)).toEqual({ band: "content", rank: 237 });
    expect(prepared.order.bands.highlight).toBe(source.bands.highlight);
  } finally {
    writes.restore();
  }
});

it.each(["cancelled", "stale"] as const)(
  "discards a partially prepared complete 10,000-stroke rank map when %s",
  async (reason) => {
    const { store, source } = fixture(0);
    const selected = source.bands.content.slice(237, 469);
    const survivorId = source.bands.content[469]!;
    const originalRank = store.getRank(survivorId);
    const writes = observeRankWrites();
    let cancelled = false;
    let publications = 0;
    store.subscribe(() => {
      publications += 1;
    });
    try {
      const prepared = await store.prepareElementRemoval(selected, {
        isCancelled: () => cancelled,
        shouldYield: () => writes.count() >= 512,
        yieldControl: async () => {
          expect(store.getRank(survivorId)).toEqual(originalRank);
          expect(store.size).toBe(10_000);
          expect(publications).toBe(0);
          if (reason === "cancelled") cancelled = true;
          else {
            store.create({
              ...source.records.get(survivorId)!.element,
              id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            } as InkElementV1);
          }
        },
      });
      expect(prepared).toEqual({ status: "cancelled", token: null });
      expect(writes.count()).toBe(512);
      expect(store.getRank(survivorId)).toEqual(originalRank);
      expect(store.size).toBe(reason === "stale" ? 10_001 : 10_000);
      expect(publications).toBe(reason === "stale" ? 1 : 0);
      for (const id of selected) expect(store.get(id)).toBeDefined();
    } finally {
      writes.restore();
    }
  },
);

async function observedSampleStore() {
  const elements = createStandardDomainFixture().elements.slice(0, 10_000);
  const validation = validateRuntimeInkSnapshotV1(createWorkerSnapshot(elements));
  if (!validation.ok) throw new Error("Expected valid removal fixture.");
  expect(validation.statistics).toMatchObject({ strokes: 10_000, strokePoints: 500_000 });
  const observed = elements.map((element) => {
    if (element.kind !== "stroke") throw new Error("Expected stroke.");
    // Observe retained samples after validation; hydration reuses its exact bounds/extrema.
    Object.freeze(element.points);
    const { observed: points, work } = observeSchemaArray(element.points);
    return {
      element: Object.freeze({
        ...element,
        pivot: Object.freeze({ ...element.pivot }),
        style: Object.freeze({
          ...element.style,
          color: Object.freeze({ ...element.style.color }),
        }),
        points,
      }),
      work,
    };
  });
  const builder = ElementStore.createBuilder(scheduler);
  await builder.appendOwnedValidatedRuntime(
    observed.map(({ element }) => element),
    validation.derivations.elements,
  );
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected hydrated store.");
  for (const { work } of observed) {
    work.indexedReads = 0;
    work.descriptorReads = 0;
  }
  return { store, observed };
}

it.each([1, 2_000])(
  "deletes, undoes and redoes %i of 10,000 strokes without sample reads or duplicate sample buffers",
  async (selectedCount) => {
    const { store, observed } = await observedSampleStore();
    const records = observed.slice(0, selectedCount).map(({ element }) => store.get(element.id)!);
    const ids = records.map(({ element }) => element.id);
    const copy = vi.spyOn(sampleCopy, "copySampleRange");
    const allocation = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const prepared = await store.prepareElementRemoval(ids, scheduler);
    if (prepared.token === null) throw new Error("Expected removal token.");
    expect(store.size).toBe(10_000);
    const transition = store.commitPreparedElementMutation(prepared.token).transition;
    if (transition === null) throw new Error("Expected retained history.");
    expect(transition.retainedOnly).toBe(true);
    expect(transition.reverse.elements).toBeUndefined();
    const expectedPayload =
      (20_000 - selectedCount) * 80 +
      256 +
      records.reduce((bytes, { element }) => bytes + 208 + elementMutationPayloadBytes(element), 0);
    expect(transition.payloadBytes).toBe(expectedPayload);
    for (const direction of ["reverse", "forward"] as const) {
      const replay = await store.prepareHistoryReplay(transition[direction], scheduler, transition);
      if (replay.token === null) throw new Error("Expected replay token.");
      const result = store.commitPreparedElementMutation(replay.token);
      expect(result.transition).toBe(transition);
      if (direction === "reverse") {
        for (const record of records) {
          expect(store.get(record.element.id)?.element).toBe(record.element);
          expect(store.get(record.element.id)?.bounds).toBe(record.bounds);
        }
      }
    }
    expect(store.size).toBe(10_000 - selectedCount);
    expect(observed.reduce((reads, { work }) => reads + work.indexedReads, 0)).toBe(0);
    expect(observed.reduce((reads, { work }) => reads + work.descriptorReads, 0)).toBe(0);
    expect(copy).not.toHaveBeenCalled();
    expect(allocation).not.toHaveBeenCalled();
  },
);
