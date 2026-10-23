import { describe, expect, it, vi } from "vitest";

import * as renderBands from "../../../../../src/domain/commands/render-bands";
import { DocumentCapacity } from "../../../../../src/domain/store/records/document-capacity";
import type { ElementRecord } from "../../../../../src/domain/store/types";
import { restoreOwnedReplayBands } from "../../../../../src/domain/store/mutations/mutation-order";
import {
  captureOwnedMutationHistory,
  STABLE_RELATIVE_ORDER,
} from "../../../../../src/domain/store/mutations/owned-mutation-history";
import { MutationPreparationScheduler } from "../../../../../src/domain/store/mutations/mutation-preparation-scheduler";
import { ElementStore } from "../../../../../src/domain/store/public";
import {
  applyElementMutation as apply,
  applyRetainedHistoryMutation as applyRetained,
  uninterruptedMutationScheduler as scheduler,
} from "../../../../fixtures/domain/element-mutation";
import { connectedLine, highlighter, IDS, rectangle } from "../fixtures";

const rectangles = () => [rectangle(), rectangle(IDS.other), rectangle(IDS.line)];
const bands = (store: ElementStore) => ({
  content: store.materializeBandOrder("content"),
  highlight: store.materializeBandOrder("highlight"),
});

function ownedRemoval() {
  const elements = rectangles();
  const store = new ElementStore([...elements, highlighter()]);
  const removed = store.removeWithHistory([elements[0]!.id])!;
  return { elements, store, removed };
}

function observeHighlightValidation() {
  const check = vi.spyOn(renderBands, "renderBandOf");
  return {
    expectVisited(expected: boolean) {
      expect(
        check.mock.calls.some(([element]) => "id" in element && element.id === IDS.highlight),
      ).toBe(expected);
      check.mockClear();
    },
    restore: () => check.mockRestore(),
  };
}

function observeCapacityDirections() {
  const directions: Array<{ before: Array<string | null>; after: Array<string | null> }> = [];
  const prepare = Object.getOwnPropertyDescriptor(DocumentCapacity.prototype, "prepareTimeSliced")!
    .value as DocumentCapacity["prepareTimeSliced"];
  const spy = vi.spyOn(DocumentCapacity.prototype, "prepareTimeSliced");
  function* observe(records: Iterable<ElementRecord | null>, output: Array<string | null>) {
    for (const record of records) {
      output.push(record?.element.id ?? null);
      yield record;
    }
  }
  spy.mockImplementation(function (this: DocumentCapacity, previous, next, scheduler) {
    const direction = { before: [] as Array<string | null>, after: [] as Array<string | null> };
    directions.push(direction);
    return prepare.call(
      this,
      observe(previous, direction.before),
      observe(next, direction.after),
      scheduler,
    );
  });
  return { directions, restore: () => spy.mockRestore() };
}

describe("structural membership order deltas", () => {
  it.each(["tail", "all"])("marks %s removal dirty without survivor deltas", (scope) => {
    const elements = rectangles();
    const store = new ElementStore([...elements, highlighter()]);
    const ids = scope === "all" ? elements.map(({ id }) => id) : [elements[2]!.id];
    const delta = store.remove(ids)!;
    expect(delta.dirtyBands).toEqual({ content: true, highlight: false });
    expect(delta.changes.map(({ id }) => id)).toEqual(ids);
    expect(store.materializeBandOrder("highlight")).toEqual([IDS.highlight]);
  });

  it("publishes only removed and restored membership while keeping dense survivor ranks", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const first = elements[0]!.id;
    const removed = await apply(store, {
      bands: { content: elements.slice(1).map(({ id }) => id), highlight: [] },
      removeIds: [first],
    });
    expect(removed.delta.changes.map(({ id }) => id)).toEqual([first]);
    expect(store.getRank(elements[2]!.id)).toEqual({ band: "content", rank: 1 });
    const restored = await apply(store, removed.transition.reverse, removed.transition);
    expect(restored.delta.changes.map(({ id }) => id)).toEqual([first]);
    expect(store.getRank(elements[2]!.id)).toEqual({ band: "content", rank: 2 });
    const redone = await apply(store, removed.transition.forward, removed.transition);
    expect(redone.delta.changes.map(({ id }) => id)).toEqual([first]);
  });

  it("keeps complete order semantics when removal also reorders survivors", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const result = await apply(store, {
      bands: { content: [elements[2]!.id, elements[1]!.id], highlight: [] },
      removeIds: [elements[0]!.id],
    });
    expect(result.delta.changes.find(({ id }) => id === elements[2]!.id)?.domains).toEqual([
      "order",
    ]);
    expect(result.delta.dirtyBands.content).toBe(true);
    await apply(store, result.transition.reverse, result.transition);
    expect(bands(store).content).toEqual(elements.map(({ id }) => id));
    await apply(store, result.transition.forward, result.transition);
    expect(bands(store).content).toEqual([elements[2]!.id, elements[1]!.id]);
  });

  it("classifies membership, replacements and survivor reorders in the same delta", async () => {
    const elements = rectangles();
    const target = elements[1]!;
    const replacement = {
      ...target,
      x: target.x + 100,
      pivot: { ...target.pivot, x: target.pivot.x + 100 },
      style: { ...target.style, outlineOpacity: 0.5 },
    };
    const inserted = {
      ...connectedLine(replacement),
      id: "00000000-0000-4000-8000-000000000099",
    };
    const store = new ElementStore([...elements, highlighter()]);
    const capacity = observeCapacityDirections();
    try {
      const result = await apply(store, {
        bands: { content: [elements[2]!.id, target.id, inserted.id], highlight: [IDS.highlight] },
        removeIds: [elements[0]!.id],
        elements: [replacement, inserted],
      });
      expect(capacity.directions[0]).toEqual({
        before: [elements[0]!.id, target.id, null, null],
        after: [null, target.id, inserted.id, null],
      });
      expect(result.delta.changes.map(({ id, domains }) => ({ id, domains }))).toEqual([
        { id: elements[0]!.id, domains: ["order", "visibility", "connection"] },
        { id: target.id, domains: ["geometry", "paint"] },
        { id: inserted.id, domains: ["geometry", "paint", "order", "visibility", "connection"] },
        { id: elements[2]!.id, domains: ["order"] },
      ]);
      expect(result.delta.dirtyBands).toEqual({ content: true, highlight: false });
      await apply(store, result.transition.reverse, result.transition);
      expect(bands(store).content).toEqual(elements.map(({ id }) => id));
      expect(store.get(target.id)?.element).toEqual(target);
      expect(store.get(inserted.id)).toBeUndefined();
    } finally {
      capacity.restore();
    }
  });
});

describe("order-only capacity projections", () => {
  it("prepares both capacity directions empty while retaining every source record", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const originals = elements.map(({ id }) => store.get(id));
    const capacity = observeCapacityDirections();
    try {
      const result = await apply(store, {
        bands: { content: elements.map(({ id }) => id).reverse(), highlight: [] },
      });
      expect(capacity.directions).toEqual([{ before: [], after: [] }]);
      expect(result.delta.changes.map(({ domains }) => domains)).toEqual([["order"], ["order"]]);
      for (let index = 0; index < elements.length; index += 1) {
        expect(store.get(elements[index]!.id)).toBe(originals[index]);
      }
    } finally {
      capacity.restore();
    }
  });
});

describe("private replay band proof", () => {
  it("skips unaffected band validation only for current exact owned directions", async () => {
    const { elements, store, removed } = ownedRemoval();
    const bandCheck = observeHighlightValidation();
    try {
      await applyRetained(store, removed.transition, "reverse");
      bandCheck.expectVisited(false);
      await applyRetained(store, removed.transition, "forward");
      bandCheck.expectVisited(false);
      store.updateStyle(elements[1]!.id, { ...elements[1]!.style, outlineOpacity: 0.5 });
      await applyRetained(store, removed.transition, "reverse");
      bandCheck.expectVisited(false);
    } finally {
      bandCheck.restore();
    }
    // The adopted unchanged band remains writable by later ordinary insertions.
    store.create({ ...highlighter(), id: "00000000-0000-4000-8000-000000000090" });
    expect(store.materializeBandOrder("highlight")).toHaveLength(2);
  });

  it("fully validates public element mutations instead of trusting frozen direction arrays", async () => {
    const { store, removed } = ownedRemoval();
    const retained = removed.transition.reverse.elements![0]!;
    if (retained.kind !== "rectangle") throw new Error("Expected retained rectangle.");
    Object.assign(retained.style, { outlineOpacity: 0.5 });
    const bandCheck = observeHighlightValidation();
    try {
      await apply(store, removed.transition.reverse, removed.transition);
      bandCheck.expectVisited(true);
    } finally {
      bandCheck.restore();
    }
  });

  it("does not admit frozen foreign directions or unfrozen cloned directions", async () => {
    const { elements, store: owner, removed } = ownedRemoval();
    const other = new ElementStore([...elements.slice(1), highlighter()]);
    const bandCheck = observeHighlightValidation();
    try {
      await apply(other, removed.transition.reverse, removed.transition);
      bandCheck.expectVisited(true);
      await apply(owner, { ...removed.transition.reverse });
      bandCheck.expectVisited(true);
    } finally {
      bandCheck.restore();
    }
  });
});

describe("replay order cancellation and misuse", () => {
  it("rejects altered public membership before installing the retained order", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const removed = store.removeWithHistory([elements[0]!.id])!;
    removed.transition.reverse.elements![0]!.id = "00000000-0000-4000-8000-000000000099";
    await expect(
      store.prepareElementMutation(removed.transition.reverse, scheduler, removed.transition),
    ).rejects.toThrow("exactly once");
    expect(bands(store).content).toEqual(elements.slice(1).map(({ id }) => id));
    expect(store.instrumentation.publishedDeltas).toBe(1);
  });

  it("cancels retained-band copying without changing source arrays", async () => {
    const elements = rectangles();
    const store = new ElementStore(elements);
    const removed = store.removeWithHistory([elements[0]!.id])!;
    const sourceBands = { content: [...store.materializeBandOrder("content")], highlight: [] };
    let cancelled = false;
    expect(
      await restoreOwnedReplayBands(
        removed.transition.reverse.bands,
        { bands: sourceBands, records: new Map() },
        new Map(),
        captureOwnedMutationHistory(removed.delta, STABLE_RELATIVE_ORDER),
        new MutationPreparationScheduler({
          isCancelled: () => cancelled,
          shouldYield: () => true,
          yieldControl: async () => {
            cancelled = true;
          },
        }),
      ),
    ).toBe("cancelled");
    expect(sourceBands.content).toEqual(elements.slice(1).map(({ id }) => id));
  });
});
