import { expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { prepareDocumentDeltaSteps } from "../../../src/persistence/serialization/incremental-document-delta";
import type { DocumentSerializationDelta } from "../../../src/persistence/serialization/incremental-document-serializer-types";
import { IncrementalDocumentSerializer } from "../../../src/persistence/serialization/public";
import { completeSerializationSteps } from "../../../src/persistence/serialization/serialization-model-preparation";
import {
  prepareSerializationRankUpdate,
  prepareSerializationRanks,
} from "../../../src/persistence/serialization/serialization-selection";
import { createStandardDomainFixture } from "../domain/standard-domain-fixture";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";

type Band = "content" | "highlight";

function capacityModel() {
  const elements = createStandardDomainFixture().elements.flatMap((element, index) =>
    element.kind === "stroke"
      ? [
          {
            ...element,
            tool: index % 2 === 0 ? ("highlighter" as const) : ("pen" as const),
            style: { ...element.style, pressureEnabled: false },
          },
        ]
      : [],
  );
  const orders = { content: [] as string[], highlight: [] as string[] };
  for (const element of elements)
    orders[element.tool === "highlighter" ? "highlight" : "content"].push(element.id);
  expect(elements).toHaveLength(10_000);
  expect(orders.content).toHaveLength(5_000);
  expect(orders.highlight).toHaveLength(5_000);
  return {
    currentElements: new Map<string, InkElementV1>(
      elements.map((element) => [element.id, element]),
    ),
    currentOrders: orders,
    currentPage: createSnapshot().page,
    elements,
  };
}

function observeWork(model: ReturnType<typeof capacityModel>) {
  const reads = { content: 0, highlight: 0 };
  const ranks = completeSerializationSteps(prepareSerializationRanks(model.currentOrders, 256));
  const currentOrders = {
    content: observeSchemaArray(model.currentOrders.content, () => reads.content++).observed,
    highlight: observeSchemaArray(model.currentOrders.highlight, () => reads.highlight++).observed,
  };
  const iterations = [Symbol.iterator, "entries", "values", "keys", "forEach"] as const;
  const scans = iterations.map((method) => vi.spyOn(model.currentElements, method));
  const gets = vi.spyOn(model.currentElements, "get");
  const rankGets = {
    content: vi.spyOn(ranks.content, "get"),
    highlight: vi.spyOn(ranks.highlight, "get"),
  };
  const mutations = ["set", "delete", "clear"] as const;
  const rankWrites = [ranks.content, ranks.highlight].flatMap((band) =>
    mutations.map((method) => vi.spyOn(band, method)),
  );
  const stagedWrites = { content: 0, highlight: 0 };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The probe forwards the observed receiver through call().
  const originalSet = Map.prototype.set;
  const staging = vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    if (isRank(value)) stagedWrites[value.band]++;
    return originalSet.call(this, key, value);
  });
  return {
    ...model,
    currentOrders,
    ranks,
    reads,
    stagedWrites,
    gets,
    rankGets,
    assertNoCanonicalMutation() {
      for (const scan of scans) expect(scan).not.toHaveBeenCalled();
      for (const spy of rankWrites) expect(spy).not.toHaveBeenCalled();
    },
    restore() {
      staging.mockRestore();
      for (const spy of [...scans, gets, ...Object.values(rankGets), ...rankWrites])
        spy.mockRestore();
    },
  };
}

function isRank(value: unknown): value is { band: Band; rank: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "band" in value &&
    (value.band === "content" || value.band === "highlight") &&
    "rank" in value
  );
}

function selectedGeometryReplacements(model: ReturnType<typeof capacityModel>, count: number) {
  return model.elements
    .filter((element) => element.tool === "pen")
    .slice(0, count)
    .map((element) => ({
      ...element,
      offset: { x: 4, y: 8 },
      pivot: { x: element.pivot.x + 4, y: element.pivot.y + 8 },
    }));
}

function rankUpdateSteps(
  work: ReturnType<typeof observeWork>,
  nextOrders: Readonly<Record<Band, readonly string[]>>,
) {
  return prepareSerializationRankUpdate(
    {
      currentOrders: work.currentOrders,
      nextOrders,
      currentRanks: work.ranks,
    },
    256,
  );
}

function assertNoRankPreparation(work: ReturnType<typeof observeWork>) {
  expect(work.rankGets.content).not.toHaveBeenCalled();
  expect(work.rankGets.highlight).not.toHaveBeenCalled();
  expect(work.stagedWrites).toEqual({ content: 0, highlight: 0 });
  work.assertNoCanonicalMutation();
}

function preparedDelta(
  work: ReturnType<typeof observeWork>,
  delta: Partial<DocumentSerializationDelta>,
) {
  const prepared = completeSerializationSteps(
    prepareDocumentDeltaSteps({
      currentElements: work.currentElements,
      currentOrders: work.currentOrders,
      currentPage: work.currentPage,
      delta: { baseModelRevision: 7, modelRevision: 8, ...delta },
    }),
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
}

it.each([1_000, 2_000])(
  "applies %i selected geometry replacements through the real serializer without rebuilding ranks",
  (count) => {
    const model = capacityModel();
    const serializer = new IncrementalDocumentSerializer();
    const initialElements = [...model.currentOrders.highlight, ...model.currentOrders.content].map(
      (id) => model.currentElements.get(id)!,
    );
    expect(serializer.reset(createSnapshot(initialElements))).toEqual({
      ok: true,
      value: undefined,
    });
    const changedElements = selectedGeometryReplacements(model, count);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The probe forwards the observed receiver through call().
    const originalGet = Map.prototype.get;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The probe forwards the observed receiver through call().
    const originalSet = Map.prototype.set;
    let rankReads = 0;
    let rankWrites = 0;
    const gets = vi.spyOn(Map.prototype, "get").mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
    ) {
      const value = originalGet.call(this, key) as unknown;
      if (isRank(value)) rankReads++;
      return value;
    });
    const sets = vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      if (isRank(value)) rankWrites++;
      return originalSet.call(this, key, value);
    });
    try {
      expect(
        serializer.applyDelta({
          baseModelRevision: 7,
          modelRevision: 8,
          changedElements,
        }),
      ).toEqual({ ok: true, value: undefined });
      expect(rankReads).toBe(0);
      expect(rankWrites).toBe(0);
      expect(serializer.instrumentation).toMatchObject({
        fullValidationRuns: 1,
        incrementalValidationRuns: 1,
        fragmentBuilds: 0,
      });
      expect(serializer.currentElementCount()).toBe(10_000);
      expect(serializer.currentRevision()).toBe(8);
    } finally {
      gets.mockRestore();
      sets.mockRestore();
      serializer.clear();
    }
  },
);

it.each([1_000, 2_000])(
  "does not visit either band or rebuild ranks for %i same-band geometry changes at 10k capacity",
  (count) => {
    const model = capacityModel();
    const changedElements = selectedGeometryReplacements(model, count);
    const work = observeWork(model);
    try {
      const prepared = preparedDelta(work, { changedElements });
      expect(prepared.orders).toBe(work.currentOrders);
      expect(completeSerializationSteps(rankUpdateSteps(work, prepared.orders))).toBe(work.ranks);
      expect(work.reads).toEqual({ content: 0, highlight: 0 });
      expect(work.gets).toHaveBeenCalledTimes(count);
      assertNoRankPreparation(work);
    } finally {
      work.restore();
    }
  },
);

it.each([
  { count: 1_000, kind: "remove" },
  { count: 2_000, kind: "remove" },
  { count: 1_000, kind: "reorder" },
  { count: 2_000, kind: "reorder" },
])("limits $kind of $count selected IDs to their 5k band", ({ count, kind }) => {
  const model = capacityModel();
  const selected = model.currentOrders.content.slice(0, count);
  const next = [...model.currentOrders.content.slice(count), ...selected];
  const work = observeWork(model);
  try {
    const prepared = preparedDelta(
      work,
      kind === "remove" ? { removedIds: selected } : { orderChanges: { content: next } },
    );
    expect(prepared.orders.highlight).toBe(work.currentOrders.highlight);
    expect(prepared.orders.content).toHaveLength(kind === "remove" ? 5_000 - count : 5_000);
    expect(work.gets.mock.calls.length).toBe(5_000);
    expect(work.reads.highlight).toBe(0);
    expect(work.reads.content).toBeLessThanOrEqual(10_000);
    const updated = completeSerializationSteps(rankUpdateSteps(work, prepared.orders));
    const nextSize = prepared.orders.content.length;
    const contentRankReads = work.rankGets.content.mock.calls.length;
    const highlightRankReads = work.rankGets.highlight.mock.calls.length;
    expect(contentRankReads).toBe(nextSize);
    expect(highlightRankReads).toBe(0);
    expect(updated.highlight).toBe(work.ranks.highlight);
    expect(updated.content).not.toBe(work.ranks.content);
    expect(work.stagedWrites).toEqual({ content: nextSize, highlight: 0 });
    expect(work.reads.highlight).toBe(0);
    expect(work.reads.content).toBeLessThanOrEqual(10_000);
    expect(updated.content.size).toBe(nextSize);
    for (const id of selected) expect(updated.content.has(id)).toBe(kind !== "remove");
    work.assertNoCanonicalMutation();
  } finally {
    work.restore();
  }
});

it("rejects an incomplete replacement without scanning unrelated records or touching ranks", () => {
  const model = capacityModel();
  const partial = model.currentOrders.content.slice(0, 2_000);
  const work = observeWork(model);
  try {
    const result = completeSerializationSteps(
      prepareDocumentDeltaSteps({
        currentElements: work.currentElements,
        currentOrders: work.currentOrders,
        currentPage: work.currentPage,
        delta: { baseModelRevision: 7, modelRevision: 8, orderChanges: { content: partial } },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-order" } });
    expect(work.gets).toHaveBeenCalledTimes(2_000);
    expect(work.reads).toEqual({ content: 2_000, highlight: 0 });
    assertNoRankPreparation(work);
  } finally {
    work.restore();
  }
});

it("releases cancelled staged rank work without changing the authoritative 10k band rank maps", () => {
  const model = capacityModel();
  const next = [...model.currentOrders.content].reverse();
  const work = observeWork(model);
  try {
    const prepared = preparedDelta(work, { orderChanges: { content: next } });
    const steps = rankUpdateSteps(work, prepared.orders);
    expect(steps.next().done).toBe(false);
    expect(work.rankGets.content).toHaveBeenCalledTimes(256);
    expect(work.rankGets.highlight).not.toHaveBeenCalled();
    expect(work.stagedWrites).toEqual({ content: 256, highlight: 0 });
    expect(steps.return(work.ranks).done).toBe(true);
    expect(steps.next().done).toBe(true);
    work.assertNoCanonicalMutation();
    work.rankGets.content.mockClear();
    expect(work.ranks.content.size + work.ranks.highlight.size).toBe(10_000);
    expect(work.ranks.content.get(model.currentOrders.content[0]!)).toEqual({
      band: "content",
      rank: 0,
    });
  } finally {
    work.restore();
  }
});
