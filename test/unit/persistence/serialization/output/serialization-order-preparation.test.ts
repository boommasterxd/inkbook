import { describe, expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { prepareDocumentDeltaSteps } from "../../../../../src/persistence/serialization/output/incremental-document-delta";
import type { DocumentSerializationDelta } from "../../../../../src/persistence/serialization/output/incremental-document-serializer-types";
import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/public";
import { completeSerializationSteps } from "../../../../../src/persistence/serialization/output/serialization-model-preparation";
import * as selection from "../../../../../src/persistence/serialization/output/serialization-selection";
import { highlighter, rectangle, IDS } from "../../../domain/store/fixtures";
import { createSnapshot, uuid } from "../fixtures";

function model() {
  const elements: InkElementV1[] = [highlighter(), rectangle(), rectangle(IDS.other)];
  return {
    currentElements: new Map(elements.map((element) => [element.id, element])),
    currentOrders: { highlight: [IDS.highlight], content: [IDS.target, IDS.other] },
    currentPage: createSnapshot().page,
  };
}

function prepare(delta: Partial<DocumentSerializationDelta>, current = model()) {
  return completeSerializationSteps(
    prepareDocumentDeltaSteps(
      {
        ...current,
        delta: { baseModelRevision: 7, modelRevision: 8, ...delta },
      },
      1,
    ),
  );
}

describe("incremental render-band order preparation", () => {
  it("reorders one band and preserves both orders for identical or explicitly empty changes", () => {
    const current = model();
    const reordered = prepare({ orderChanges: { content: [IDS.other, IDS.target] } }, current);
    expect(reordered).toMatchObject({ ok: true });
    if (!reordered.ok) throw new Error(reordered.error.message);
    expect(reordered.value.orders.content).toEqual([IDS.other, IDS.target]);
    expect(reordered.value.orders.highlight).toBe(current.currentOrders.highlight);
    for (const orderChanges of [{ content: [IDS.target, IDS.other] }, {}]) {
      const reused = prepare({ orderChanges }, current);
      if (!reused.ok) throw new Error(reused.error.message);
      expect(reused.value.orders).toBe(current.currentOrders);
    }
  });

  it("filters removed IDs and permits empty bands and unknown removals", () => {
    const current = model();
    const result = prepare({ removedIds: [IDS.highlight, IDS.target, uuid(99)] }, current);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.orders).toEqual({ highlight: [], content: [IDS.other] });
    expect(current.currentOrders).toEqual({
      highlight: [IDS.highlight],
      content: [IDS.target, IDS.other],
    });
    const unknown = prepare({ removedIds: [uuid(99)] }, current);
    if (!unknown.ok) throw new Error(unknown.error.message);
    expect(unknown.value.orders).toBe(current.currentOrders);
  });

  it("requires the complete destination order for insertion", () => {
    const added = rectangle(uuid(99));
    expect(prepare({ changedElements: [added] })).toMatchObject({
      ok: false,
      error: { code: "invalid-order" },
    });
    const inserted = prepare({
      changedElements: [added],
      orderChanges: { content: [IDS.target, added.id, IDS.other] },
    });
    expect(inserted).toMatchObject({
      ok: true,
      value: { orders: { content: [IDS.target, added.id, IDS.other] } },
    });
  });

  it("validates both affected bands when an existing stroke migrates", () => {
    const changed = { ...highlighter(), tool: "pen" as const };
    const validOrders = { highlight: [], content: [IDS.target, IDS.highlight, IDS.other] };
    expect(prepare({ changedElements: [changed], orderChanges: validOrders })).toMatchObject({
      ok: true,
      value: { orders: validOrders },
    });
    for (const orderChanges of [{ highlight: [] }, { content: validOrders.content }]) {
      expect(prepare({ changedElements: [changed], orderChanges })).toMatchObject({
        ok: false,
        error: { code: "invalid-order" },
      });
    }
  });

  it.each([
    { name: "missing", content: [IDS.target] },
    { name: "duplicate", content: [IDS.target, IDS.target] },
    { name: "foreign", content: [IDS.target, uuid(99)] },
    { name: "wrong-band", content: [IDS.target, IDS.highlight] },
    { name: "removed", content: [IDS.target, IDS.other], removedIds: [IDS.other] },
    { name: "non-ID", content: [IDS.target, 42] as unknown as string[] },
  ])("rejects $name IDs before publishing a replacement order", ({ content, removedIds }) => {
    const current = model();
    expect(
      prepare({ orderChanges: { content }, ...(removedIds ? { removedIds } : {}) }, current),
    ).toMatchObject({ ok: false, error: { code: "invalid-order" } });
    expect(current.currentOrders.content).toEqual([IDS.target, IDS.other]);
  });
});

describe("staged selection ranks", () => {
  it.each([
    { name: "reorder", next: { highlight: [IDS.highlight], content: [IDS.other, IDS.target] } },
    { name: "remove", next: { highlight: [IDS.highlight], content: [IDS.other] } },
    {
      name: "insert",
      next: { highlight: [IDS.highlight], content: [IDS.target, uuid(99), IDS.other] },
    },
    { name: "migrate", next: { highlight: [], content: [IDS.highlight, IDS.target, IDS.other] } },
  ])("stages $name ranks without mutating canonical ranks", ({ next }) => {
    const currentOrders = model().currentOrders;
    const currentRanks = completeSerializationSteps(
      selection.prepareSerializationRanks(currentOrders, 1),
    );
    const original = {
      content: new Map(currentRanks.content),
      highlight: new Map(currentRanks.highlight),
    };
    const nextOrders = {
      ...next,
      highlight: next.highlight.length > 0 ? currentOrders.highlight : next.highlight,
    };
    const updated = completeSerializationSteps(
      selection.prepareSerializationRankUpdate(
        {
          currentOrders,
          nextOrders,
          currentRanks,
        },
        1,
      ),
    );
    expect(currentRanks).toEqual(original);
    expect(updated).toEqual(
      completeSerializationSteps(selection.prepareSerializationRanks(nextOrders, 1)),
    );
    expect(updated.content).not.toBe(currentRanks.content);
    if (next.highlight.length > 0) {
      expect(updated.highlight).toBe(currentRanks.highlight);
      expect(updated.highlight.get(IDS.highlight)).toBe(original.highlight.get(IDS.highlight));
    }
    if (next.content[0] === IDS.target) {
      expect(updated.content.get(IDS.target)).toBe(original.content.get(IDS.target));
    }
  });

  it("does not stage ranks for reused orders", () => {
    const currentOrders = model().currentOrders;
    const currentRanks = completeSerializationSteps(
      selection.prepareSerializationRanks(currentOrders, 1),
    );
    expect(
      completeSerializationSteps(
        selection.prepareSerializationRankUpdate(
          {
            currentOrders,
            nextOrders: { ...currentOrders },
            currentRanks,
          },
          1,
        ),
      ),
    ).toBe(currentRanks);
  });
});

describe("serializer order and selection trust boundary", () => {
  it("keeps clipboard selection order correct after append, removal and reorder", () => {
    const current = model();
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.reset(createSnapshot([...current.currentElements.values()])).ok).toBe(true);
    const added = rectangle(uuid(99));
    const deltas: DocumentSerializationDelta[] = [
      {
        baseModelRevision: 7,
        modelRevision: 8,
        changedElements: [added],
        orderChanges: { content: [IDS.target, IDS.other, added.id] },
      },
      { baseModelRevision: 8, modelRevision: 9, removedIds: [IDS.target] },
      { baseModelRevision: 9, modelRevision: 10, orderChanges: { content: [added.id, IDS.other] } },
    ];
    const expected = [
      [IDS.highlight, IDS.target, IDS.other, added.id],
      [IDS.highlight, IDS.other, added.id],
      [IDS.highlight, added.id, IDS.other],
    ];
    for (const [index, delta] of deltas.entries()) {
      expect(serializer.applyDelta(delta).ok).toBe(true);
      const ids = expected[index]!;
      const selected = completeSerializationSteps(serializer.selectionSteps([...ids].reverse()));
      expect(selected?.map(({ id }) => id)).toEqual(ids);
      expect(serializer.currentSnapshot()?.elements.map(({ id }) => id)).toEqual(ids);
    }
    expect(completeSerializationSteps(serializer.selectionSteps([IDS.target]))).toBeNull();
    serializer.clear();
    expect(completeSerializationSteps(serializer.selectionSteps([added.id]))).toBeNull();
  });

  it("fully rejects malformed changed fields despite reusing the existing band order", () => {
    const serializer = new IncrementalDocumentSerializer();
    const snapshot = createSnapshot([highlighter(), rectangle()]);
    expect(serializer.reset(snapshot).ok).toBe(true);
    const invalid = { ...rectangle(), width: Number.NaN };
    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        modelRevision: 8,
        changedElements: [invalid],
      }),
    ).toMatchObject({ ok: false, error: { code: "snapshot-invalid" } });
    expect(serializer.currentSnapshot()).toEqual(snapshot);
  });
});

describe("atomic serializer rank publication", () => {
  it.each(["abort", "supersede"] as const)(
    "does not publish partially prepared ranks when sliced work is %s",
    async (mode) => {
      const elements = [
        highlighter(),
        ...Array.from({ length: 300 }, (_, index) => rectangle(uuid(index + 100))),
      ];
      const serializer = new IncrementalDocumentSerializer();
      expect(serializer.reset(createSnapshot(elements)).ok).toBe(true);
      const ids = elements.slice(1).map(({ id }) => id);
      const controller = new AbortController();
      const original = selection.prepareSerializationRankUpdate;
      let preparingRanks = false;
      const spy = vi
        .spyOn(selection, "prepareSerializationRankUpdate")
        .mockImplementation(function* (...args) {
          preparingRanks = true;
          return yield* original(...args);
        });
      let interrupted = false;
      try {
        const pending = serializer.applyDeltaSliced(
          {
            baseModelRevision: 7,
            modelRevision: 8,
            orderChanges: { content: [...ids].reverse() },
          },
          {
            signal: controller.signal,
            checkpoint: () => {
              if (preparingRanks && !interrupted) {
                interrupted = true;
                if (mode === "abort") controller.abort();
                else
                  expect(serializer.applyDelta({ baseModelRevision: 7, modelRevision: 9 }).ok).toBe(
                    true,
                  );
              }
              return undefined;
            },
          },
          true,
        );
        if (mode === "abort") await expect(pending).rejects.toThrow();
        else
          await expect(pending).resolves.toMatchObject({
            ok: false,
            error: { code: "base-revision-mismatch" },
          });
        expect(interrupted).toBe(true);
        expect(serializer.currentRevision()).toBe(mode === "abort" ? 7 : 9);
        const expected = [IDS.highlight, ...ids];
        expect(serializer.currentSnapshot()?.elements.map(({ id }) => id)).toEqual(expected);
        expect(
          completeSerializationSteps(serializer.selectionSteps([...expected].reverse()))?.map(
            ({ id }) => id,
          ),
        ).toEqual(expected);
      } finally {
        spy.mockRestore();
        serializer.clear();
      }
    },
  );
});
