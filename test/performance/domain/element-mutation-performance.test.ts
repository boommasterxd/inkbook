import { expect, it, vi } from "vitest";

import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
} from "../../../src/domain/store/public";

import * as cellMembership from "../../../src/domain/spatial/cell-membership";
import * as immutability from "../../../src/domain/store/records/immutability";
import * as recordFactory from "../../../src/domain/store/records/record-factory";
import * as bounds from "../../../src/domain/geometry/bounds";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import * as sampleValidation from "../../../src/domain/schema/stroke-sample-range-validation";
import * as strokePosition from "../../../src/domain/geometry/stroke-position";
import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { DEFAULT_HISTORY_BYTE_LIMIT } from "../../../src/domain/commands/history";
import { UniformSpatialIndex } from "../../../src/domain/spatial/index";
import { DocumentCapacity } from "../../../src/domain/store/records/document-capacity";
import { planElementMutation } from "../../../src/domain/store/mutations/element-mutation";
import { renderBandOf } from "../../../src/domain/commands/render-bands";
import * as renderBands from "../../../src/domain/commands/render-bands";
import type { ElementRank } from "../../../src/domain/store/types";
import { restoreOwnedReplayBands } from "../../../src/domain/store/mutations/mutation-order";
import {
  captureOwnedMutationHistory,
  STABLE_RELATIVE_ORDER,
} from "../../../src/domain/store/mutations/owned-mutation-history";
import { MutationPreparationScheduler } from "../../../src/domain/store/mutations/mutation-preparation-scheduler";

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
  const removed = new Set(elements.map(({ id }) => id));
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  await builder.appendOwnedRuntime(elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected hydrated store.");
  const originalRecords = new Map(elements.map(({ id }) => [id, store.get(id)!]));
  const publications = vi.fn();
  store.subscribe(publications);
  const recordBuild = vi.spyOn(recordFactory, "createOwnedInitialRecordSteps");
  const cloneElement = vi.spyOn(immutability, "mutableElementSteps");
  const indexInsert = vi.spyOn(UniformSpatialIndex.prototype, "insert");
  const cellRange = vi.spyOn(cellMembership, "createCellRange");
  const deriveBounds = vi.spyOn(bounds, "calculateElementBoundsSteps");
  const copyElement = vi.spyOn(immutability, "immutableElementSteps");
  try {
    const deletion = await prepareAndApply({
      bands: {
        content: remainingBand(store, "content", removed),
        highlight: remainingBand(store, "highlight", removed),
      },
      removeIds: [...removed],
    });
    expect(store.size).toBe(0);
    expect(deletion.payloadBytes).toBeLessThanOrEqual(DEFAULT_HISTORY_BYTE_LIMIT);
    await prepareAndApply(deletion.reverse, deletion);
    expect(store.size).toBe(10_000);
    for (const [id, original] of originalRecords) {
      expect(store.get(id)?.element).toBe(original.element);
      expect(store.get(id)?.bounds).toBe(original.bounds);
    }
    await prepareAndApply(deletion.forward, deletion);
    expect(store.size).toBe(0);
    expect(publications).toHaveBeenCalledTimes(3);
    expect(cloneElement.mock.calls.every(([element]) => removed.has(element.id))).toBe(true);
  } finally {
    recordBuild.mockRestore();
    cloneElement.mockRestore();
    indexInsert.mockRestore();
    cellRange.mockRestore();
    deriveBounds.mockRestore();
    copyElement.mockRestore();
  }

  async function prepareAndApply(mutation: ElementMutation, replay?: AppliedElementMutation) {
    const previousClones = cloneElement.mock.calls.length;
    deriveBounds.mockClear();
    copyElement.mockClear();
    cellRange.mockClear();
    let yields = 0;
    const previousSize = store!.size;
    const assertSlice = () => {
      if (replay !== undefined) expect(recordBuild).not.toHaveBeenCalled();
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
      expect(recordBuild).not.toHaveBeenCalled();
      expect(deriveBounds).not.toHaveBeenCalled();
      expect(copyElement).not.toHaveBeenCalled();
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

it("publishes local membership deltas and replays without validating unchanged 10,000-stroke bands", async () => {
  const elements = createStandardDomainFixture().elements.slice(0, 10_000);
  const store = new ElementStore(elements);
  const stroke = elements[0]!;
  if (stroke.kind !== "stroke") throw new Error("Expected stroke fixture.");
  const highlightId = "00000000-0000-4000-8000-000000020000";
  store.create({
    ...stroke,
    id: highlightId,
    tool: "highlighter",
    style: { ...stroke.style, pressureEnabled: false },
  });
  const initialEntries = store.instrumentation.deltaEntries;
  const removed = store.removeWithHistory([stroke.id])!;
  expect(removed.delta.changes).toHaveLength(1);
  expect(store.getRank(elements[9_999]!.id)?.rank).toBe(9_998);
  const bandCheck = vi.spyOn(renderBands, "renderBandOf");
  try {
    for (const mutation of [
      removed.transition.reverse,
      removed.transition.forward,
      removed.transition.reverse,
    ]) {
      const prepared = await store.prepareHistoryReplay(
        mutation,
        { shouldYield: () => false, yieldControl: async () => undefined },
        removed.transition,
      );
      if (prepared.token === null) throw new Error("Expected prepared replay.");
      expect(store.commitPreparedElementMutation(prepared.token).delta?.changes).toHaveLength(1);
    }
    expect(store.instrumentation.deltaEntries - initialEntries).toBe(4);
    expect(
      bandCheck.mock.calls.some(([element]) => "id" in element && element.id === highlightId),
    ).toBe(false);
    expect(
      bandCheck.mock.calls.filter(([element]) => !("id" in element && element.id === stroke.id)),
    ).toHaveLength(0);
  } finally {
    bandCheck.mockRestore();
  }
  const highlightRemoval = store.removeWithHistory([highlightId])!;
  const retained = captureOwnedMutationHistory(highlightRemoval.delta, STABLE_RELATIVE_ORDER);
  let bandReads = 0;
  const content = new Proxy([...store.materializeBandOrder("content")], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) bandReads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  expect(content.length).toBe(10_000);
  const restored = await restoreOwnedReplayBands(
    { content, highlight: [highlightId] },
    { bands: { content, highlight: [] }, records: new Map() },
    new Map(),
    retained,
    new MutationPreparationScheduler({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    }),
  );
  if (restored === "cancelled") throw new Error("Expected restored bands.");
  expect(restored.bands.content).toBe(content);
  expect(bandReads).toBe(0);
  expect(Object.isFrozen(restored.bands.highlight)).toBe(false);
});

it("slices actual sample work for one maximum-length insertion and owned Undo", async () => {
  const template = createStandardRuntimeDomainFixture().elements[0]!;
  if (template.kind !== "stroke") throw new Error("Expected stroke template.");
  const points = new Float64Array(MAX_STROKE_POINTS * 3);
  for (let index = 0; index < points.length; index += 3) {
    points[index] = index % 60;
    points[index + 1] = index % 30;
    points[index + 2] = 0.5;
  }
  const store = new ElementStore();
  let work = 0;
  let yields = 0;
  const charge = (count: number) => {
    work += count;
  };
  const copy = sampleCopy.copySampleRange;
  const compare = sampleCopy.compareSampleRange;
  const validate = sampleValidation.assertStrokeSampleRange;
  const worldPoint = strokePosition.strokeWorldPoint;
  const spies = [
    vi
      .spyOn(sampleCopy, "copySampleRange")
      .mockImplementation((source, target, start, end, proof) => {
        charge(end - start);
        return copy(source, target, start, end, proof);
      }),
    vi
      .spyOn(sampleCopy, "compareSampleRange")
      .mockImplementation((source, expected, start, end) => {
        charge(end - start);
        return compare(source, expected, start, end);
      }),
    vi
      .spyOn(sampleValidation, "assertStrokeSampleRange")
      .mockImplementation((value, path, context, offset, range) => {
        charge(range.end - range.start);
        return validate(value, path, context, offset, range);
      }),
    vi.spyOn(strokePosition, "strokeWorldPoint").mockImplementation((...args) => {
      charge(3);
      return worldPoint(...args);
    }),
  ];
  const scheduler = {
    shouldYield: () => work >= 768,
    yieldControl: async () => {
      expect(work).toBeLessThanOrEqual(768);
      work = 0;
      yields += 1;
    },
  };
  try {
    const inserted = await store.prepareElementMutation(
      {
        bands: { content: [template.id], highlight: [] },
        elements: [{ ...template, points: points as unknown as number[] }],
      },
      scheduler,
    );
    if (inserted.token === null) throw new Error("Expected insertion.");
    const transition = store.commitPreparedElementMutation(inserted.token).transition!;
    const original = store.get(template.id)!;
    const removal = await store.prepareElementMutation(transition.reverse, scheduler, transition);
    if (removal.token === null) throw new Error("Expected removal.");
    store.commitPreparedElementMutation(removal.token);
    for (const spy of spies) spy.mockClear();
    const restored = await store.prepareElementMutation(transition.forward, scheduler, transition);
    if (restored.token === null) throw new Error("Expected owned Undo.");
    store.commitPreparedElementMutation(restored.token);
    expect(store.get(template.id)?.element).toBe(original.element);
    expect(spies[0]).not.toHaveBeenCalled();
    expect(spies[2]).toHaveBeenCalledTimes(1);
    expect(spies[2]!.mock.calls[0]![0]).toHaveLength(3);
    expect(spies[3]).not.toHaveBeenCalled();
    expect(spies[1]!.mock.calls.length).toBe(Math.ceil(MAX_STROKE_POINTS / 256));
    expect(work).toBeLessThanOrEqual(768);
    expect(yields).toBeGreaterThan(1);
    expect(transition.payloadBytes).toBeLessThan(DEFAULT_HISTORY_BYTE_LIMIT);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
