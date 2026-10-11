import { describe, expect, it, vi } from "vitest";
import { ElementStore, type AppliedElementMutation } from "../../../../src/domain/store/public";
import { DocumentCapacity } from "../../../../src/domain/store/document-capacity";
import {
  applyElementMutation,
  uninterruptedMutationScheduler as scheduler,
} from "../../../fixtures/domain/element-mutation";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import { connectedLine, highlighter, rectangle } from "./fixtures";

async function replay(
  store: ElementStore,
  transition: AppliedElementMutation,
  direction: "forward" | "reverse",
) {
  const prepared = await store.prepareHistoryReplay(transition[direction], scheduler, transition);
  expect(prepared.status).toBe("prepared");
  if (prepared.token === null) throw new Error("Expected retained replay token.");
  const result = store.commitPreparedElementMutation(prepared.token);
  expect(result.status).toBe("committed");
  expect(result.transition).toBe(transition);
  return result;
}

async function removedStroke() {
  const { store } = await hydrateRuntimeStroke(highlighter());
  const record = store.get(highlighter().id)!;
  const { transition } = await applyElementMutation(store, {
    bands: { content: [], highlight: [] },
    removeIds: [record.element.id],
  });
  return { store, record, transition };
}

describe("private retained history replay", () => {
  it("restores canonical values independently of changed public sample and header copies", async () => {
    const { store, record, transition } = await removedStroke();
    const input = transition.reverse.elements![0]!;
    if (input.kind !== "stroke") throw new Error("Expected stroke.");
    input.points[0] = NaN;
    input.id = "changed-public-id";
    input.style.opacity = NaN;
    const restored = await replay(store, transition, "reverse");
    expect(store.get(record.element.id)?.element).toBe(record.element);
    expect(store.get(record.element.id)?.bounds).toBe(record.bounds);
    expect(store.get(record.element.id)?.geometryVersion).toBeGreaterThan(record.geometryVersion);
    expect(restored.delta?.changes).toHaveLength(1);
    await replay(store, transition, "forward");
    expect(store.size).toBe(0);
  });

  it("rejects foreign transitions, unrelated directions and changed source records", async () => {
    const { store, record, transition } = await removedStroke();
    const other = new ElementStore();
    await expect(
      other.prepareHistoryReplay(transition.reverse, scheduler, transition),
    ).rejects.toThrow("not retained");
    await expect(
      store.prepareHistoryReplay({ ...transition.reverse }, scheduler, transition),
    ).rejects.toThrow("retained transition direction");
    await replay(store, transition, "reverse");
    const changed = { ...record.element, style: { ...record.element.style, opacity: 0.25 } };
    store.replace(record.element.id, changed as Parameters<ElementStore["replace"]>[1]);
    const publications = vi.fn();
    store.subscribe(publications);
    await expect(
      store.prepareHistoryReplay(transition.forward, scheduler, transition),
    ).rejects.toThrow("source no longer matches");
    expect(store.size).toBe(1);
    expect(publications).not.toHaveBeenCalled();
  });

  it("restores independent older transitions after intervening history traversal", async () => {
    const first = rectangle();
    const second = { ...first, id: "00000000-0000-4000-8000-000000000099" };
    const store = new ElementStore([first, second]);
    const a = await applyElementMutation(store, {
      bands: { content: [second.id], highlight: [] },
      removeIds: [first.id],
    });
    const b = await applyElementMutation(store, {
      bands: { content: [], highlight: [] },
      removeIds: [second.id],
    });
    await replay(store, b.transition, "reverse");
    await replay(store, a.transition, "reverse");
    expect(store.materializeBandOrder("content")).toEqual([first.id, second.id]);
    await replay(store, a.transition, "forward");
    await replay(store, b.transition, "forward");
    expect(store.size).toBe(0);
  });

  it("preserves canonical endpoint detachments and restoration in both directions", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const originalLine = store.get(line.id)!;
    const { transition } = await applyElementMutation(store, {
      bands: { content: [line.id], highlight: [] },
      removeIds: [target.id],
    });
    const detached = store.get(line.id)!;
    await replay(store, transition, "reverse");
    expect(store.get(line.id)?.element).toBe(originalLine.element);
    await replay(store, transition, "forward");
    expect(store.get(line.id)?.element).toBe(detached.element);
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
  });
});

describe("retained replay transaction boundaries", () => {
  it("rejects newly introduced connection detachments without publication", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const { transition } = await applyElementMutation(store, {
      bands: { content: [], highlight: [] },
      removeIds: [target.id],
    });
    await replay(store, transition, "reverse");
    const line = connectedLine(target);
    store.create(line);
    const publications = vi.fn();
    store.subscribe(publications);
    await expect(
      store.prepareHistoryReplay(transition.forward, scheduler, transition),
    ).rejects.toThrow("resulting membership");
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: line.startConnection });
    expect(store.size).toBe(2);
    expect(publications).not.toHaveBeenCalled();
  });

  it("rejects restored endpoints against a changed external target", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const { transition } = await applyElementMutation(store, {
      bands: { content: [target.id], highlight: [] },
      removeIds: [line.id],
    });
    store.replace(target.id, rectangle(target.id, 200, 200));
    const publications = vi.fn();
    store.subscribe(publications);
    await expect(
      store.prepareHistoryReplay(transition.reverse, scheduler, transition),
    ).rejects.toThrow();
    expect(store.size).toBe(1);
    expect(publications).not.toHaveBeenCalled();
  });

  it("cancels private replay preparation and rejects a stale token without publication", async () => {
    const { store, transition } = await removedStroke();
    let cancelled = false;
    const preparation = await store.prepareHistoryReplay(
      transition.reverse,
      {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      },
      transition,
    );
    expect(preparation).toEqual({ status: "cancelled", token: null });
    expect(store.size).toBe(0);
    const prepared = await store.prepareHistoryReplay(transition.reverse, scheduler, transition);
    store.create(rectangle());
    if (prepared.token === null) throw new Error("Expected token.");
    expect(store.commitPreparedElementMutation(prepared.token).status).toBe("cancelled");
    expect(store.size).toBe(1);
  });

  it("retains capacity validation and never publishes a failed preparation", async () => {
    const { store, transition } = await removedStroke();
    const capacity = vi
      .spyOn(DocumentCapacity.prototype, "prepareTimeSliced")
      .mockRejectedValue(new RangeError("capacity"));
    try {
      await expect(
        store.prepareHistoryReplay(transition.reverse, scheduler, transition),
      ).rejects.toThrow("capacity");
      expect(capacity).toHaveBeenCalledOnce();
      expect(store.size).toBe(0);
    } finally {
      capacity.mockRestore();
    }
  });
});
