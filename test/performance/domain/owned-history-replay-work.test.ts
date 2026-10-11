import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import * as runtimeCopy from "../../../src/domain/elements/runtime-element-copy";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import * as validation from "../../../src/domain/elements/runtime-replacement-validation";
import * as equality from "../../../src/domain/store/element-comparison";
import * as payload from "../../../src/domain/store/mutation-payload";
import * as connections from "../../../src/domain/store/connections";
import * as anchors from "../../../src/domain/geometry/anchors";
import * as ownedHistory from "../../../src/domain/store/owned-mutation-history";
import * as mutationOrder from "../../../src/domain/store/mutation-order";
import * as mutationElements from "../../../src/domain/store/mutation-elements";
import { DocumentCapacity } from "../../../src/domain/store/document-capacity";
import type { ElementRecord } from "../../../src/domain/store/types";
import { MutationPreparationScheduler } from "../../../src/domain/store/mutation-preparation-scheduler";
import { createStandardRuntimeDomainFixture } from "./standard-domain-fixture";
import { uninterruptedMutationScheduler as scheduler } from "../../fixtures/domain/element-mutation";

function observeRetainedRecordLookups() {
  const maps = new Set<ReadonlyMap<string, ElementRecord>>();
  const restorers: (() => void)[] = [];
  let lookups = 0;
  const resolve = ownedHistory.ownedReplayRecords;
  const proof = vi.spyOn(ownedHistory, "ownedReplayRecords").mockImplementation((...args) => {
    const records = resolve(...args);
    if (records !== undefined && !maps.has(records)) {
      maps.add(records);
      const get = records.get.bind(records);
      const spy = vi.spyOn(records, "get").mockImplementation((id) => {
        lookups += 1;
        return get(id);
      });
      restorers.push(() => spy.mockRestore());
    }
    return records;
  });
  return {
    count: () => lookups,
    restore: () => {
      for (const restore of restorers) restore();
      proof.mockRestore();
    },
  };
}

function observeDetachmentWork() {
  const collect = mutationElements.collectDesiredElements;
  let reads = 0;
  let probes = 0;
  const capture = vi
    .spyOn(mutationElements, "collectDesiredElements")
    .mockImplementation(async (...args) => {
      const get = vi.spyOn(args[0].reverseConnections, "get");
      const has = vi.spyOn(args[0].reverseConnections, "has");
      try {
        return await collect(...args);
      } finally {
        reads += get.mock.calls.length;
        probes += has.mock.calls.length;
        get.mockRestore();
        has.mockRestore();
      }
    });
  const detach = vi.spyOn(connections, "prepareConnectionDetachments");
  return {
    expectVisits(expected: number) {
      expect(probes).toBe(expected);
      expect(reads).toBe(0);
      expect(detach.mock.calls.length).toBe(0);
    },
    restore() {
      capture.mockRestore();
      detach.mockRestore();
    },
  };
}

function observeCapacityWork() {
  const prepare = Object.getOwnPropertyDescriptor(DocumentCapacity.prototype, "prepareTimeSliced")!
    .value as DocumentCapacity["prepareTimeSliced"];
  const spy = vi.spyOn(DocumentCapacity.prototype, "prepareTimeSliced");
  let slots = 0;
  let checkpoints = 0;
  function* observe(records: Iterable<ElementRecord | null>) {
    for (const record of records) {
      slots += 1;
      yield record;
    }
  }
  spy.mockImplementation(function (this: DocumentCapacity, previous, next, scheduler) {
    return prepare.call(this, observe(previous), observe(next), {
      ...scheduler,
      shouldYield: () => {
        checkpoints += 1;
        return scheduler.shouldYield();
      },
    });
  });
  return {
    expectVisits(expected: number) {
      expect(slots).toBe(expected);
      expect(checkpoints).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(3);
      // Nonempty capacity directions stay lazy; only entirely empty phases use arrays.
      expect(
        spy.mock.calls
          .flatMap(([previous, next]) => [previous, next])
          .every((records) => !Array.isArray(records) || records.length === 0),
      ).toBe(true);
    },
    restore: () => spy.mockRestore(),
  };
}

it.each([false, true])(
  "replays 10,000 privately retained strokes without public staging, point scans or payload recounts (external connections: %s)",
  async (connected) => {
    const fixture = createStandardRuntimeDomainFixture();
    const elements = connected ? fixture.elements : fixture.elements.slice(0, fixture.strokeCount);
    const builder = ElementStore.createBuilder(scheduler);
    await builder.appendOwnedRuntime(elements);
    const store = await builder.finalize();
    if (store === null) throw new Error("Expected hydrated store.");
    const originals = fixture.strokeIds.map((id) => store.get(id)!);
    const removed = await store.prepareElementMutation(
      {
        bands: { content: elements.slice(fixture.strokeCount).map(({ id }) => id), highlight: [] },
        removeIds: fixture.strokeIds,
      },
      scheduler,
    );
    if (removed.token === null) throw new Error("Expected removal token.");
    const transition = store.commitPreparedElementMutation(removed.token).transition;
    if (transition === null) throw new Error("Expected transition.");
    const spies = [
      vi.spyOn(runtimeCopy, "captureRuntimeElementHeader"),
      vi.spyOn(sampleCopy, "compareSampleRange"),
      vi.spyOn(sampleCopy, "copySampleRange"),
      vi.spyOn(validation, "validateRuntimeReplacementSteps"),
    ];
    const payloadBytes = vi.spyOn(payload, "elementMutationPayloadBytes");
    const compare = vi.spyOn(equality, "elementsEqualSteps");
    const preparationRuns = vi.spyOn(MutationPreparationScheduler.prototype, "run");
    const orderComparisons = vi.spyOn(mutationOrder, "mutationOrderPreserved");
    const retainedLookups = observeRetainedRecordLookups();
    const detachments = observeDetachmentWork();
    const capacity = observeCapacityWork();
    const capacityReferences = vi.spyOn(connections, "connectionReferences");
    const resolvedConnections = vi.spyOn(connections, "assertResolvedConnections");
    const published = vi.fn();
    store.subscribe(published);
    let interrupted = false;
    let yielded = 0;
    const work = {
      shouldYield: () => !interrupted,
      yieldControl: async () => {
        expect(store.size).toBe(elements.length - fixture.strokeCount);
        expect(published).not.toHaveBeenCalled();
        interrupted = true;
        yielded += 1;
      },
    };
    try {
      for (const direction of ["reverse", "forward", "reverse"] as const) {
        const prepared = await store.prepareHistoryReplay(transition[direction], work, transition);
        if (prepared.token === null) throw new Error("Expected replay token.");
        expect(store.commitPreparedElementMutation(prepared.token).status).toBe("committed");
      }
      for (const spy of spies) expect(spy.mock.calls.length).toBe(0);
      // Capacity accounting still observes each removed/restored record once.
      // Recounting the retained history directions would exceed this bound.
      expect(payloadBytes.mock.calls.length).toBeLessThanOrEqual(fixture.strokeCount * 3);
      expect(compare.mock.calls.length).toBeLessThanOrEqual(fixture.strokeCount * 2);
      expect(compare.mock.calls.every(([left, right]) => left === right)).toBe(true);
      // Each restoration reads retained records once during element collection,
      // the combined connection/membership proof and record construction. A
      // separate resulting-membership traversal exceeds this six-read bound.
      expect(retainedLookups.count()).toBeLessThanOrEqual(fixture.strokeCount * 6);
      // Capacity and reverse-map maintenance each inspect every changed record,
      // but no document-sized record arrays cross the capacity boundary.
      expect(capacityReferences.mock.calls.length).toBe(fixture.strokeCount * 6);
      expect(resolvedConnections).not.toHaveBeenCalled();
      capacity.expectVisits(fixture.strokeCount * 3);
      expect(yielded).toBe(1);
      // Only the two record restorations and three retained-direction producers
      // need generators. Membership delta classification adds no producer/rank work.
      expect(preparationRuns.mock.calls.length).toBeLessThanOrEqual(fixture.strokeCount * 2 + 3);
      expect(orderComparisons.mock.calls.length).toBe(0);
      detachments.expectVisits(connected ? fixture.strokeCount : 0);
      expect(
        preparationRuns.mock.results.filter(({ value }) => value instanceof Promise).length,
      ).toBe(1);
      expect(published).toHaveBeenCalledTimes(3);
      expect(store.size).toBe(elements.length);
      for (const original of originals) {
        const restored = store.get(original.element.id)!;
        expect(restored.element === original.element && restored.bounds === original.bounds).toBe(
          true,
        );
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      for (const spy of [compare, payloadBytes, preparationRuns, orderComparisons])
        spy.mockRestore();
      retainedLookups.restore();
      detachments.restore();
      capacity.restore();
      capacityReferences.mockRestore();
      resolvedConnections.mockRestore();
    }
  },
);

it("validates canonical connected destinations once in a 10,000-stroke document", async () => {
  const fixture = createStandardRuntimeDomainFixture();
  const builder = ElementStore.createBuilder(scheduler);
  await builder.appendOwnedRuntime(fixture.elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected hydrated store.");
  const targetId = fixture.connectedTargetId;
  const original = store.get(targetId)!;
  const referenceCount = store.countReverseDependencies([targetId], 513);
  expect(referenceCount).toBe(512);
  const removal = await store.prepareElementMutation(
    {
      bands: {
        content: store.materializeBandOrder("content").filter((id) => id !== targetId),
        highlight: store.materializeBandOrder("highlight"),
      },
      removeIds: [targetId],
    },
    scheduler,
  );
  if (removal.token === null) throw new Error("Expected removal token.");
  const transition = store.commitPreparedElementMutation(removal.token).transition;
  if (transition === null) throw new Error("Expected transition.");
  const resolveAnchor = vi.spyOn(anchors, "resolveShapeAnchor");
  const validateConnections = vi.spyOn(connections, "assertResolvedConnections");
  const detachments = vi.spyOn(connections, "prepareConnectionDetachments");
  const retainedLookups = observeRetainedRecordLookups();
  try {
    for (const direction of ["reverse", "forward", "reverse"] as const) {
      const prepared = await store.prepareHistoryReplay(
        transition[direction],
        scheduler,
        transition,
      );
      if (prepared.token === null) throw new Error("Expected replay token.");
      expect(store.commitPreparedElementMutation(prepared.token).status).toBe("committed");
    }
    // Both restorations resolve every retained endpoint exactly once. Removal
    // destinations are detached and need no anchor lookup; derived-state work
    // must not repeat the already completed canonical connection proof.
    expect(resolveAnchor).toHaveBeenCalledTimes(referenceCount * 2);
    expect(validateConnections).toHaveBeenCalledTimes((referenceCount / 2) * 3);
    expect(detachments.mock.calls.length).toBe(1);
    // Collection, connection/membership checks, restoration and derived-state
    // proof identity together need at most five retained reads per destination.
    expect(retainedLookups.count()).toBeLessThanOrEqual((1 + referenceCount / 2) * 5 * 3);
    expect(store.get(targetId)?.element).toBe(original.element);
    expect(store.countReverseDependencies([targetId], 513)).toBe(referenceCount);
    expect(store.size).toBe(fixture.elements.length);
  } finally {
    resolveAnchor.mockRestore();
    validateConnections.mockRestore();
    detachments.mockRestore();
    retainedLookups.restore();
  }
});
