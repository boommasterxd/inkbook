import { expect, it, vi } from "vitest";

import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
} from "../../../src/domain/store/public";

import * as cellMembership from "../../../src/domain/spatial/cell-membership";
import * as immutability from "../../../src/domain/store/immutability";
import * as recordFactory from "../../../src/domain/store/record-factory";
import { UniformSpatialIndex } from "../../../src/domain/spatial/index";
import { DocumentCapacity } from "../../../src/domain/store/document-capacity";
import { planElementMutation } from "../../../src/domain/store/element-mutation";
import { renderBandOf } from "../../../src/domain/commands/render-bands";
import * as renderBands from "../../../src/domain/commands/render-bands";
import type { ElementRank } from "../../../src/domain/store/types";

import { CheckpointSliceScheduler } from "./domain-scenarios";
import {
  createStandardDomainFixture,
  createStandardRuntimeDomainFixture,
} from "./standard-domain-fixture";

it("atomically cuts and restores 10,000 strokes while yielding during preparation", async () => {
  const fixture = createStandardDomainFixture();
  const store = new ElementStore(fixture.elements);
  const removed = new Set(fixture.strokeIds);
  const cut: ElementMutation = {
    bands: {
      content: remainingBand(store, "content", removed),
      highlight: remainingBand(store, "highlight", removed),
    },
    removeIds: fixture.strokeIds,
  };
  let publications = 0;
  const unsubscribe = store.subscribe(() => {
    publications += 1;
  });
  const cutTransition = await applyMutation(store, cut, 11_000);
  expect(store.size).toBe(1_000);
  expect(publications).toBe(1);
  await applyMutation(store, cutTransition.reverse, 1_000);
  expect(store.size).toBe(11_000);
  expect(publications).toBe(2);
  for (const id of fixture.strokeIds) expect(store.get(id)).toBeDefined();
  unsubscribe();
}, 60_000);

it("prepares a single end-of-band deletion without enumerating unaffected records", async () => {
  const fixture = createStandardRuntimeDomainFixture();
  const records = new Map(
    fixture.elements.map((element) => {
      const record = recordFactory.createInitialRecord(element);
      return [element.id, record] as const;
    }),
  );
  const capacity = new DocumentCapacity();
  capacity.commit(capacity.prepare([], [...records.values()]));
  const index = new UniformSpatialIndex<string>();
  index.insertMany(
    [...records.values()].map(({ element, bounds }) => ({ id: element.id, bounds })),
  );
  const content = fixture.elements
    .filter((element) => renderBandOf(element) === "content")
    .map(({ id }) => id);
  const highlight = fixture.elements
    .filter((element) => renderBandOf(element) === "highlight")
    .map(({ id }) => id);
  const ranks = new Map<string, ElementRank>();
  for (const [rank, id] of content.entries()) ranks.set(id, { band: "content", rank });
  for (const [rank, id] of highlight.entries()) ranks.set(id, { band: "highlight", rank });
  const removed = content[content.length - 1]!;
  const enumerate = vi.spyOn(records, Symbol.iterator);
  const keys = vi.spyOn(records, "keys");
  try {
    const plan = await planElementMutation(
      {
        capacity,
        index,
        bands: { content, highlight },
        geometryVersion: 0,
        paintVersion: 0,
        ranks,
        records,
        reverseConnections: new Map(),
      },
      { bands: { content: content.slice(0, -1), highlight }, removeIds: [removed] },
      {
        shouldYield: () => false,
        yieldControl: async () => undefined,
      },
    );
    if (plan === null || plan === "cancelled") throw new Error("Expected a prepared deletion.");
    expect(plan.records.size).toBe(1);
    expect(plan.ranks.size).toBe(0);
    expect(plan.delta.changes).toHaveLength(1);
    expect(enumerate).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  } finally {
    enumerate.mockRestore();
    keys.mockRestore();
  }
}, 30_000);

it("reuses store-owned removal order without revalidating every unaffected element", async () => {
  const fixture = createStandardDomainFixture();
  const store = new ElementStore(fixture.elements);
  const content = store.materializeBandOrder("content");
  const removed = content[content.length - 1]!;
  const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
  let cancelled = false;
  let yields = 0;
  expect(
    await store.createRemovalMutationTimeSliced(new Set(fixture.strokeIds), {
      isCancelled: () => cancelled,
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
        cancelled = true;
      },
    }),
  ).toBe("cancelled");
  expect(yields).toBe(1);
  expect(store.size).toBe(fixture.elements.length);
  const mutation = await store.createRemovalMutationTimeSliced(new Set([removed]), scheduler);
  if (mutation === null || mutation === "cancelled")
    throw new Error("Expected a removal mutation.");
  const bandCheck = vi.spyOn(renderBands, "renderBandOf");
  try {
    const prepared = await store.prepareElementMutation(mutation, scheduler);
    expect(prepared.status).toBe("prepared");
    expect(bandCheck).not.toHaveBeenCalled();
    if (prepared.token === null) throw new Error("Expected a prepared token.");
    const committed = store.commitPreparedElementMutation(prepared.token);
    expect(committed.delta?.changes).toHaveLength(1);
    expect(store.get(removed)).toBeUndefined();
  } finally {
    bandCheck.mockRestore();
  }
}, 30_000);

async function applyMutation(
  store: ElementStore,
  mutation: ElementMutation,
  expectedSizeBeforeCommit: number,
): Promise<AppliedElementMutation> {
  let yielded = 0;
  const scheduler = new CheckpointSliceScheduler(40, () => {
    yielded += 1;
    expect(store.size).toBe(expectedSizeBeforeCommit);
  });
  const prepared = await store.prepareElementMutation(mutation, scheduler);
  if (prepared.status !== "prepared" || prepared.token === null) {
    throw new Error("Clipboard mutation could not prepare its atomic transaction.");
  }
  const committed = store.commitPreparedElementMutation(prepared.token);
  scheduler.finish();
  if (committed.status !== "committed" || committed.transition === null) {
    throw new Error("Clipboard mutation could not commit its atomic transaction.");
  }
  expect(yielded).toBeGreaterThan(0);
  expect(scheduler.checkpointCounts.every((count) => count <= 40)).toBe(true);
  return committed.transition;
}

function remainingBand(
  store: ElementStore,
  band: "content" | "highlight",
  removed: ReadonlySet<string>,
): readonly string[] {
  return store.materializeBandOrder(band).filter((id) => !removed.has(id));
}

it("bounds heavy work and scheduler handoffs for loaded-stroke deletion, Undo, and Redo", async () => {
  const fixture = createStandardRuntimeDomainFixture();
  const elements = fixture.elements.slice(0, 10_000);
  const removed = new Set(elements.slice(0, 2_000).map(({ id }) => id));
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  await builder.appendOwnedRuntime(elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected hydrated store.");
  const publications = vi.fn();
  store.subscribe(publications);
  const recordBuild = vi.spyOn(recordFactory, "createInitialRecord");
  const cloneElement = vi.spyOn(immutability, "mutableElement");
  const indexInsert = vi.spyOn(UniformSpatialIndex.prototype, "insert");
  const cellRange = vi.spyOn(cellMembership, "createCellRange");
  try {
    const deletion = await prepareAndApply({
      bands: {
        content: remainingBand(store, "content", removed),
        highlight: remainingBand(store, "highlight", removed),
      },
      removeIds: [...removed],
    });
    expect(store.size).toBe(8_000);
    await prepareAndApply(deletion.reverse, deletion);
    expect(store.size).toBe(10_000);
    await prepareAndApply(deletion.forward, deletion);
    expect(store.size).toBe(8_000);
    expect(publications).toHaveBeenCalledTimes(3);
    expect(cloneElement.mock.calls.every(([element]) => removed.has(element.id))).toBe(true);
  } finally {
    recordBuild.mockRestore();
    cloneElement.mockRestore();
    indexInsert.mockRestore();
    cellRange.mockRestore();
  }

  async function prepareAndApply(mutation: ElementMutation, replay?: AppliedElementMutation) {
    const previousClones = cloneElement.mock.calls.length;
    cellRange.mockClear();
    let yields = 0;
    const previousSize = store!.size;
    const assertSlice = () => {
      expect(recordBuild.mock.calls.length).toBeLessThanOrEqual(128);
      expect(indexInsert.mock.calls.length).toBeLessThanOrEqual(128);
      recordBuild.mockClear();
      indexInsert.mockClear();
      expect(store!.size).toBe(previousSize);
    };
    const prepared = await store!.prepareElementMutation(
      mutation,
      {
        shouldYield: () =>
          recordBuild.mock.calls.length >= 128 || indexInsert.mock.calls.length >= 128,
        yieldControl: async () => {
          yields += 1;
          assertSlice();
        },
      },
      replay,
    );
    assertSlice();
    if (replay !== undefined) {
      expect(cloneElement.mock.calls.length - previousClones).toBe(0);
    }
    // Retained band-order validation still visits cheap IDs; unaffected geometry stays untouched.
    expect(yields).toBeLessThanOrEqual(190);
    if (prepared.token === null) throw new Error("Expected prepared history mutation.");
    const committed = store!.commitPreparedElementMutation(prepared.token);
    expect(cellRange).toHaveBeenCalledTimes(mutation.elements?.length ?? 0);
    expect(indexInsert).not.toHaveBeenCalled();
    if (committed.transition === null) throw new Error("Expected committed history mutation.");
    if (replay !== undefined) expect(committed.transition).toBe(replay);
    return committed.transition;
  }
});
