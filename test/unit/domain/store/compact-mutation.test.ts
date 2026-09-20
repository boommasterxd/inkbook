import { describe, expect, it, vi } from "vitest";

import { ElementStore, type ElementMutation } from "../../../../src/domain/store/public";
import { SpatialQueryScratch } from "../../../../src/domain/spatial";

import { connectedLine, highlighter, IDS, mixedElement, rectangle } from "./fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

async function prepare(store: ElementStore, mutation: ElementMutation) {
  const result = await store.prepareElementMutation(mutation, scheduler);
  if (result.token === null) throw new Error("Expected a prepared mutation.");
  return result.token;
}

async function commit(store: ElementStore, mutation: ElementMutation) {
  const result = store.commitPreparedElementMutation(await prepare(store, mutation));
  if (result.transition === null) throw new Error("Expected a committed mutation.");
  return result.transition;
}

function bands(store: ElementStore) {
  return {
    content: store.materializeBandOrder("content"),
    highlight: store.materializeBandOrder("highlight"),
  };
}

describe("compact element removal history", () => {
  it("removes sparse first, middle, and last positions in both bands and restores their order", async () => {
    const elements = Array.from({ length: 14 }, (_, index) => mixedElement(index));
    const store = new ElementStore(elements);
    const original = bands(store);
    const removed = [0, 1, 6, 7, 12, 13].map((index) => elements[index]!.id);
    const retained = store.get(elements[2]!.id);
    const listener = vi.fn();
    store.subscribe(listener);
    const transition = await commit(store, { removeIds: removed });
    const reduced = {
      content: original.content.filter((id) => !removed.includes(id)),
      highlight: original.highlight.filter((id) => !removed.includes(id)),
    };
    expect(bands(store)).toEqual(reduced);
    expect(store.get(elements[2]!.id)).toBe(retained);
    expect(transition.reverse.bands).toBeUndefined();
    expect(transition.reverse.placements).toHaveLength(removed.length);
    await commit(store, transition.reverse);
    expect(bands(store)).toEqual(original);
    for (const element of elements) expect(store.get(element.id)?.element).toEqual(element);
    await commit(store, transition.forward);
    expect(bands(store)).toEqual(reduced);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("detaches dependent endpoints and restores reverse connections through undo and redo", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const transition = await commit(store, { removeIds: [target.id] });
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(store.countReverseDependencies([target.id], 10)).toBe(0);
    await commit(store, transition.reverse);
    expect(store.get(line.id)?.element).toEqual(line);
    expect(store.countReverseDependencies([target.id], 10)).toBe(1);
    await commit(store, transition.forward);
    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(store.countReverseDependencies([target.id], 10)).toBe(0);
  });

  it("restores a target and its jointly removed dependent", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const transition = await commit(store, { removeIds: [line.id, target.id] });
    expect(store.size).toBe(0);
    await commit(store, transition.reverse);
    expect(store.get(line.id)?.element).toEqual(line);
    expect(store.countReverseDependencies([target.id], 10)).toBe(1);
    expect(bands(store).content).toEqual([target.id, line.id]);
  });

  it.each([129, 256])("preserves fallback removal history for %i elements", async (count) => {
    const elements = Array.from({ length: count + 4 }, (_, index) => mixedElement(index));
    const store = new ElementStore(elements);
    const original = bands(store);
    const transition = await commit(store, {
      removeIds: elements.slice(0, count).map(({ id }) => id),
    });
    expect(store.size).toBe(4);
    await commit(store, transition.reverse);
    expect(bands(store)).toEqual(original);
    await commit(store, transition.forward);
    expect(store.size).toBe(4);
  });

  it("restores overflow geometry, query membership, and extent through the fallback", async () => {
    const large = { ...rectangle(), pivot: { x: 50_100, y: 150 }, width: 100_000 };
    const store = new ElementStore([large, highlighter()]);
    const maximum = store.getMaximumBottom();
    const transition = await commit(store, { removeIds: [large.id] });
    const bounds = { minX: 90_000, maxX: 90_100, minY: 100, maxY: 150 };
    const scratch = new SpatialQueryScratch<string>();
    expect(store.query(bounds, scratch)).toBe(0);
    await commit(store, transition.reverse);
    expect(store.query(bounds, scratch)).toBe(1);
    expect(scratch.at(0)).toBe(large.id);
    expect(store.getMaximumBottom()).toBe(maximum);
    await commit(store, transition.forward);
    expect(store.query(bounds, scratch)).toBe(0);
  });
});

describe("compact mutation validation", () => {
  it("returns no-op for empty requests and identical replacements", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    for (const mutation of [{}, { removeIds: [] }, { elements: [target] }]) {
      expect(await store.prepareElementMutation(mutation, scheduler)).toEqual({
        status: "noop",
        token: null,
      });
    }
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });

  it("rejects missing removals without publishing and deduplicates repeated removal IDs", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    await expect(
      store.prepareElementMutation({ removeIds: [target.id, IDS.other] }, scheduler),
    ).rejects.toThrow();
    expect(store.size).toBe(1);
    expect(store.instrumentation.publishedDeltas).toBe(0);
    const transition = await commit(store, { removeIds: [target.id, target.id] });
    expect(transition.reverse.elements).toHaveLength(1);
    expect(transition.reverse.placements).toHaveLength(1);
    expect(store.size).toBe(0);
  });

  it.each([
    [],
    [{ id: IDS.target, band: "content" as const, rank: 1 }],
    [{ id: IDS.target, band: "highlight" as const, rank: 0 }],
    [{ id: IDS.other, band: "content" as const, rank: 0 }],
    [{ id: IDS.target, band: "content" as const, rank: -1 }],
    [{ id: IDS.target, band: "content" as const, rank: 0.5 }],
    [
      { id: IDS.target, band: "content" as const, rank: 0 },
      { id: IDS.target, band: "content" as const, rank: 1 },
    ],
  ])("rejects missing or invalid insertion placements %j", async (...placements) => {
    const store = new ElementStore();
    await expect(
      store.prepareElementMutation({ elements: [rectangle()], placements }, scheduler),
    ).rejects.toThrow();
    expect(store.size).toBe(0);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });
});

describe("compact mutation token lifecycle", () => {
  it("honors cancellation after preparation and consumes the cancelled token", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    let cancelled = false;
    const result = await store.prepareElementMutation(
      { removeIds: [target.id] },
      { ...scheduler, isCancelled: () => cancelled },
    );
    if (result.token === null) throw new Error("Expected prepared mutation.");
    cancelled = true;
    expect(store.commitPreparedElementMutation(result.token).status).toBe("cancelled");
    cancelled = false;
    expect(store.commitPreparedElementMutation(result.token).status).toBe("cancelled");
    expect(store.get(target.id)).toBeDefined();
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });

  it("rejects foreign, reused, and stale tokens without partial publication", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const other = new ElementStore([target]);
    const token = await prepare(store, { removeIds: [target.id] });
    expect(other.commitPreparedElementMutation(token).status).toBe("cancelled");
    expect(store.commitPreparedElementMutation(token).status).toBe("committed");
    expect(store.commitPreparedElementMutation(token).status).toBe("cancelled");
    const stale = await prepare(other, { removeIds: [target.id] });
    other.create(highlighter());
    expect(other.commitPreparedElementMutation(stale).status).toBe("cancelled");
    expect(other.get(target.id)).toBeDefined();
    expect(other.size).toBe(2);
  });

  it("retains its removal plan independently of caller-owned arrays", async () => {
    const target = rectangle();
    const store = new ElementStore([target, highlighter()]);
    const removeIds: string[] = [target.id];
    const token = await prepare(store, { removeIds });
    removeIds[0] = IDS.highlight;
    expect(store.commitPreparedElementMutation(token).status).toBe("committed");
    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(IDS.highlight)).toBeDefined();
  });

  it("retains insertion geometry and placement independently of caller mutations", async () => {
    const store = new ElementStore([rectangle(IDS.other)]);
    const element = rectangle();
    const placement = { id: element.id, band: "content" as const, rank: 0 };
    const token = await prepare(store, { elements: [element], placements: [placement] });
    element.x = 900;
    placement.rank = 1;
    expect(store.commitPreparedElementMutation(token).status).toBe("committed");
    expect(store.get(element.id)?.element).toMatchObject({ x: 100 });
    expect(bands(store).content).toEqual([element.id, IDS.other]);
  });
});

describe("compact mutation transition and scheduling regressions", () => {
  it("retains an explicit connection detachment alongside an unrelated deletion on redo", async () => {
    const target = rectangle();
    const unrelated = rectangle(IDS.other, 800);
    const line = connectedLine(target);
    const store = new ElementStore([target, unrelated, line]);
    const transition = await commit(store, {
      elements: [{ ...line, startConnection: null }],
      removeIds: [unrelated.id],
    });
    const firstBands = bands(store);
    const firstLine = store.get(line.id)?.element;
    expect(firstLine).toMatchObject({ startConnection: null });
    await commit(store, transition.reverse);
    expect(store.get(line.id)?.element).toEqual(line);
    expect(store.get(unrelated.id)).toBeDefined();
    await commit(store, transition.forward);
    expect(bands(store)).toEqual(firstBands);
    expect(store.get(line.id)?.element).toEqual(firstLine);
    expect(store.countReverseDependencies([target.id], 10)).toBe(0);
  });

  it.each([false, true])(
    "reverses the generated undo transition when the connected line is removed: %s",
    async (removeLine) => {
      const target = rectangle();
      const line = connectedLine(target);
      const store = new ElementStore([target, line]);
      const removed = await commit(store, {
        removeIds: removeLine ? [target.id, line.id] : [target.id],
      });
      const firstBands = bands(store);
      const firstLine = store.get(line.id)?.element;
      const undone = await commit(store, removed.reverse);
      expect(store.get(target.id)?.element).toEqual(target);
      expect(store.get(line.id)?.element).toEqual(line);
      await commit(store, undone.reverse);
      expect(bands(store)).toEqual(firstBands);
      expect(store.get(target.id)).toBeUndefined();
      expect(store.get(line.id)?.element).toEqual(firstLine);
      expect(store.countReverseDependencies([target.id], 10)).toBe(0);
    },
  );

  it("rejects duplicate explicit elements even when they override a derived detachment", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const detached = { ...line, startConnection: null };
    const store = new ElementStore([target, line]);
    await expect(
      store.prepareElementMutation(
        { elements: [detached, detached], removeIds: [target.id] },
        scheduler,
      ),
    ).rejects.toThrow("Duplicate mutation element ID");
    expect(store.get(target.id)?.element).toEqual(target);
    expect(store.get(line.id)?.element).toEqual(line);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });

  it("isolates validated insertion input from caller mutations at a later scheduling checkpoint", async () => {
    const element = rectangle();
    const expected = rectangle();
    const store = new ElementStore();
    let yields = 0;
    const result = await store.prepareElementMutation(
      { elements: [element], placements: [{ id: element.id, band: "content", rank: 0 }] },
      {
        shouldYield: () => true,
        yieldControl: async () => {
          yields += 1;
          if (yields === 2) {
            element.width = -100;
            Object.assign(element.style, { outlineWidth: -1 });
          }
        },
      },
    );
    expect(yields).toBeGreaterThanOrEqual(2);
    if (result.token === null) throw new Error("Expected prepared mutation.");
    const applied = store.commitPreparedElementMutation(result.token);
    expect(applied.status).toBe("committed");
    expect(store.get(element.id)?.element).toEqual(expected);
    expect(applied.transition?.forward.elements).toEqual([expected]);
  });
});

describe("compact mutation atomic failures", () => {
  it("rejects exhausted endpoint capacity without publishing or changing the store", async () => {
    const target = rectangle();
    const lines = Array.from({ length: 512 }, (_, index) => ({
      ...connectedLine(target),
      id: mixedElement(index).id,
    }));
    const store = new ElementStore([target, ...lines]);
    const addition = { ...connectedLine(target), id: IDS.other };
    const original = bands(store);
    const retained = store.get(target.id);
    const publish = vi.fn();
    store.subscribe(publish);
    await expect(
      store.prepareElementMutation(
        { elements: [addition], placements: [{ id: addition.id, band: "content", rank: 513 }] },
        scheduler,
      ),
    ).rejects.toThrow(/per-target/);
    expect(store.size).toBe(513);
    expect(store.get(target.id)).toBe(retained);
    expect(store.get(addition.id)).toBeUndefined();
    expect(bands(store)).toEqual(original);
    expect(store.countReverseDependencies([target.id], 600)).toBe(512);
    const scratch = new SpatialQueryScratch<string>();
    expect(store.query({ minX: 0, minY: 0, maxX: 500, maxY: 300 }, scratch)).toBe(513);
    expect(publish).not.toHaveBeenCalled();
  });

  it("cancels during preparation before any visible change", async () => {
    const element = rectangle();
    const store = new ElementStore([element]);
    let cancelled = false;
    const publish = vi.fn();
    store.subscribe(publish);
    const result = await store.prepareElementMutation(
      { removeIds: [element.id] },
      {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      },
    );
    expect(result).toEqual({ status: "cancelled", token: null });
    expect(store.size).toBe(1);
    expect(store.get(element.id)?.element).toEqual(element);
    expect(publish).not.toHaveBeenCalled();
  });
});
