import { describe, expect, it, vi } from "vitest";

import { ElementStore, type ElementMutation } from "../../../../src/domain/store/public";

import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";

import { connectedLine, highlighter, IDS, mixedElement, rectangle } from "./fixtures";

describe("ElementStore atomic element mutation", () => {
  it("rejects target changes that leave an existing connected endpoint unresolved", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    await expect(
      store.prepareElementMutation(
        {
          bands: bands(store),
          elements: [{ ...target, x: target.x + 100 }],
        },
        scheduler,
      ),
    ).rejects.toThrow();
    expect(store.get(target.id)?.element).toEqual(target);
    expect(store.get(line.id)?.element).toEqual(line);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });

  it("captures detached dependent connections in both removal history directions", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);

    const removed = store.removeWithHistory([target.id]);

    expect(removed).not.toBeNull();
    if (removed === null) return;
    const lineDelta = removed.delta.changes.find(({ id }) => id === line.id);
    expect(lineDelta?.before?.element).toMatchObject({
      startConnection: { targetId: target.id },
    });
    expect(lineDelta?.after?.element).toMatchObject({ startConnection: null });
    expect(removed.transition.forward.elements).toEqual([]);
    expect(removed.transition.reverse.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: target.id }),
        expect.objectContaining({
          id: line.id,
          startConnection: { targetId: target.id, anchor: line.startConnection?.anchor },
        }),
      ]),
    );

    await commit(store, removed.transition.reverse);
    expect(store.get(target.id)).toBeDefined();
    expect(store.get(line.id)?.element).toMatchObject({
      startConnection: { targetId: target.id },
    });
    await commit(store, removed.transition.forward);
    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
  });

  it("detaches and restores both endpoints when both connection targets are removed", async () => {
    const startTarget = rectangle("00000000-0000-4000-8000-000000000020", 100);
    const endTarget = rectangle("00000000-0000-4000-8000-000000000021", 500);
    const line = {
      ...connectedLine(startTarget),
      end: { x: endTarget.x, y: endTarget.y },
      endConnection: {
        anchor: { kind: "box" as const, position: "top-left" as const },
        targetId: endTarget.id,
      },
      pivot: { x: (startTarget.x + endTarget.x) / 2, y: startTarget.y },
    };
    const store = new ElementStore([startTarget, endTarget, line]);

    const applied = await commit(store, {
      bands: { content: [line.id], highlight: [] },
      removeIds: [startTarget.id, endTarget.id],
    });

    expect(store.get(line.id)?.element).toMatchObject({
      endConnection: null,
      startConnection: null,
    });
    await commit(store, applied.reverse);
    expect(store.get(line.id)?.element).toMatchObject({
      endConnection: { targetId: endTarget.id },
      startConnection: { targetId: startTarget.id },
    });
  });
});

describe("ElementStore runtime stroke restoration", () => {
  it("deletes, restores, and re-deletes hydrated stroke buffers", async () => {
    const source = highlighter();
    const { store, points } = await hydrateRuntimeStroke(source);
    const applied = await commit(store, {
      bands: { content: [], highlight: [] },
      removeIds: [source.id],
    });
    expect(store.size).toBe(0);

    await commit(store, applied.reverse);
    const restored = store.get(source.id)?.element;
    expect(restored).toEqual({ ...source, points });
    expect(restored?.kind === "stroke" && restored.points).toBeInstanceOf(Float64Array);
    expect(restored?.kind === "stroke" && restored.points).not.toBe(points);
    expect(store.materializeBandOrder("highlight")).toEqual([source.id]);

    await commit(store, applied.forward);
    expect(store.size).toBe(0);
    expect(store.instrumentation.publishedDeltas).toBe(3);
  });

  it.each([
    new Float64Array([0, 0, Number.NaN]),
    new Float64Array([0, 0, 2]),
    new Float64Array([0, 0]),
    new Float32Array([0, 0, 0.5]),
  ])("rejects malformed runtime samples without publishing a mutation: %s", async (points) => {
    const source = highlighter();
    const store = new ElementStore();
    await expect(
      store.prepareElementMutation(
        {
          bands: { content: [], highlight: [source.id] },
          elements: [{ ...source, points } as unknown as typeof source],
        },
        scheduler,
      ),
    ).rejects.toThrow(RangeError);
    expect(store.size).toBe(0);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });
});

describe("ElementStore prepared mutation traversal", () => {
  it("cuts and restores ranks, connections, and derived state with one delta per direction", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([highlighter(), target, line]);
    const originalBands = bands(store);
    const listener = vi.fn();
    store.subscribe(listener);

    const applied = await commit(store, {
      bands: { content: [line.id], highlight: [IDS.highlight] },
      removeIds: [target.id],
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(store.materializeBandOrder("content")).toEqual([line.id]);

    await commit(store, applied.reverse);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(bands(store)).toEqual(originalBands);
    expect(store.get(line.id)?.element).toMatchObject({
      startConnection: { targetId: target.id },
    });

    await commit(store, applied.forward);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
  });

  it("pastes and reverses both fixed bands atomically", async () => {
    const existing = rectangle();
    const pastedContent = rectangle("00000000-0000-4000-8000-000000000010", 500);
    const pastedHighlight = {
      ...highlighter(),
      id: "00000000-0000-4000-8000-000000000011",
    };
    const store = new ElementStore([existing]);
    const listener = vi.fn();
    store.subscribe(listener);

    const applied = await commit(store, {
      bands: {
        content: [existing.id, pastedContent.id],
        highlight: [pastedHighlight.id],
      },
      elements: [pastedContent, pastedHighlight],
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bands(store)).toEqual({
      content: [existing.id, pastedContent.id],
      highlight: [pastedHighlight.id],
    });
    await commit(store, applied.reverse);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(bands(store)).toEqual({ content: [existing.id], highlight: [] });
    await commit(store, applied.forward);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(bands(store).content).toEqual([existing.id, pastedContent.id]);
  });

  it("rejects stale prepared mutations without partial publication", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const prepared = await store.prepareElementMutation(
      { bands: { content: [], highlight: [] }, removeIds: [target.id] },
      scheduler,
    );
    if (prepared.token === null) throw new Error("Expected prepared mutation token.");
    store.create(highlighter());

    expect(store.commitPreparedElementMutation(prepared.token)).toEqual({
      delta: null,
      status: "cancelled",
      transition: null,
    });
    expect(store.get(target.id)).toBeDefined();
  });
});

describe("ElementStore time-sliced element mutation", () => {
  it("prepares a mixed mutation above one thousand elements before one atomic swap", async () => {
    const elements = Array.from({ length: 1_200 }, (_, index) => mixedElement(index));
    const store = new ElementStore(elements);
    const removedIds = elements.filter((_, index) => index % 3 === 0).map(({ id }) => id);
    const removed = new Set(removedIds);
    const before = store.get(elements[1]!.id);
    let checks = 0;
    let yields = 0;
    const prepared = await store.prepareElementMutation(
      {
        bands: {
          content: store.materializeBandOrder("content").filter((id) => !removed.has(id)),
          highlight: store.materializeBandOrder("highlight").filter((id) => !removed.has(id)),
        },
        removeIds: removedIds,
      },
      {
        shouldYield: () => ++checks % 32 === 0,
        yieldControl: async () => {
          yields += 1;
          expect(store.size).toBe(1_200);
          expect(store.get(elements[1]!.id)).toBe(before);
        },
      },
    );
    if (prepared.token === null) throw new Error("Expected prepared mutation token.");

    expect(yields).toBeGreaterThan(10);
    expect(store.commitPreparedElementMutation(prepared.token).status).toBe("committed");
    expect(store.size).toBe(800);
    expect(store.instrumentation.publishedDeltas).toBe(1);
  });
});

async function commit(store: ElementStore, mutation: ElementMutation) {
  const prepared = await store.prepareElementMutation(mutation, scheduler);
  if (prepared.token === null) throw new Error("Expected prepared mutation token.");
  const committed = store.commitPreparedElementMutation(prepared.token);
  if (committed.transition === null) throw new Error("Expected applied mutation transition.");
  return committed.transition;
}

const scheduler = {
  shouldYield: () => false,
  yieldControl: async () => undefined,
};

function bands(store: ElementStore) {
  return {
    content: store.materializeBandOrder("content"),
    highlight: store.materializeBandOrder("highlight"),
  };
}
