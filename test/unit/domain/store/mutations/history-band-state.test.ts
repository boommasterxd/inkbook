import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import type { StoreDelta } from "../../../../../src/domain/store/types";
import * as renderBands from "../../../../../src/domain/commands/render-bands";
import {
  applyElementMutation,
  applyRetainedHistoryMutation as replay,
  uninterruptedMutationScheduler as scheduler,
} from "../../../../fixtures/domain/element-mutation";
import { mixedElement } from "../fixtures";

async function arrange(store: ElementStore, ids: readonly string[]) {
  const prepared = await store.prepareElementArrangement("bring-to-front", new Set(ids), scheduler);
  if (prepared.token === null) throw new Error("Expected arrangement.");
  const result = store.commitPreparedElementMutation(prepared.token);
  if (result.transition === null) throw new Error("Expected arrangement history.");
  return result.transition;
}

function fixture() {
  const elements = Array.from({ length: 6 }, (_, index) => mixedElement(index));
  const store = new ElementStore(elements);
  return { store, elements };
}

describe("exact history band-state witnesses", () => {
  it("restores nested same-band lineage and preserves writable Store operations", async () => {
    const { store, elements } = fixture();
    const a = await arrange(store, [elements[0]!.id]);
    const b = await arrange(store, [elements[2]!.id]);
    const validate = vi.spyOn(renderBands, "renderBandOf");
    try {
      await replay(store, b, "reverse");
      await replay(store, a, "reverse");
      expect(validate).not.toHaveBeenCalled();
      expect(store.materializeBandOrder("content")).toEqual([
        elements[0]!.id,
        elements[2]!.id,
        elements[4]!.id,
      ]);
      await replay(store, a, "forward");
      await replay(store, b, "forward");
      expect(validate).not.toHaveBeenCalled();
      store.create(mixedElement(10));
      store.create(mixedElement(11));
      expect(store.bandSize("content")).toBe(4);
      expect(store.bandSize("highlight")).toBe(4);
      expect(Object.isFrozen(a.forward.bands.content)).toBe(true);
    } finally {
      validate.mockRestore();
    }
  });

  it("preserves witnesses through replacements and rejects stale prepared tokens", async () => {
    const { store, elements } = fixture();
    const a = await arrange(store, [elements[0]!.id]);
    const prepared = await store.prepareHistoryReplay(a.reverse, scheduler, a);
    const untouched = elements[1]!;
    if (untouched.kind !== "stroke") throw new Error("Expected stroke.");
    store.updateStyle(untouched.id, { ...untouched.style, opacity: 0.25 });
    if (prepared.token === null) throw new Error("Expected token.");
    expect(store.commitPreparedElementMutation(prepared.token).status).toBe("cancelled");
    const validate = vi.spyOn(renderBands, "renderBandOf");
    try {
      await replay(store, a, "reverse");
      expect(validate).not.toHaveBeenCalled();
      expect(store.get(untouched.id)?.element.style).toMatchObject({ opacity: 0.25 });
    } finally {
      validate.mockRestore();
    }
  });
});

describe("replay witness transaction boundaries", () => {
  it("does not change witnesses during cancelled preparation", async () => {
    const { store, elements } = fixture();
    const a = await arrange(store, [elements[0]!.id]);
    let cancelled = false;
    const before = store.materializeBandOrder("content");
    const prepared = await store.prepareHistoryReplay(
      a.reverse,
      {
        shouldYield: () => true,
        isCancelled: () => cancelled,
        yieldControl: async () => {
          cancelled = true;
        },
      },
      a,
    );
    expect(prepared).toEqual({ status: "cancelled", token: null });
    expect(store.materializeBandOrder("content")).toEqual(before);
    const validate = vi.spyOn(renderBands, "renderBandOf");
    try {
      await replay(store, a, "reverse");
      expect(validate).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
    }
  });

  it("keeps public replay outside private lineage restoration", async () => {
    const { store, elements } = fixture();
    const a = await arrange(store, [elements[0]!.id]);
    const b = await arrange(store, [elements[2]!.id]);
    await applyElementMutation(store, b.reverse, b);
    const validate = vi.spyOn(renderBands, "renderBandOf");
    try {
      await replay(store, a, "reverse");
      expect(validate).toHaveBeenCalledTimes(elements.length);
      validate.mockClear();
      await replay(store, a, "forward");
      await replay(store, a, "reverse");
      expect(validate).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
    }
  });
});

describe("ordinary publication witness invalidation", () => {
  it.each(["arrange", "reorder", "create-remove", "append-remove", "remove-create"])(
    "requires complete validation after ordinary %s publication returns to the same order",
    async (mode) => {
      const { store, elements } = fixture();
      const a = await arrange(store, [elements[0]!.id]);
      const highlight = store.materializeBandOrder("highlight");
      if (mode === "arrange") {
        store.arrange(new Set([highlight[0]!]), "bring-to-front");
        store.arrange(new Set([highlight[0]!]), "send-to-back");
      } else if (mode === "reorder") {
        const content = store.materializeBandOrder("content");
        store.reorderBands({ content, highlight: [...highlight].reverse() });
        store.reorderBands({ content, highlight });
      } else if (mode === "remove-create") {
        store.remove([highlight[highlight.length - 1]!]);
        store.create(elements[5]!);
      } else {
        const inserted = mixedElement(11);
        if (mode === "create-remove") store.create(inserted);
        else {
          const prepared = await store.prepareElementAppend([inserted], scheduler);
          if (prepared.token === null) throw new Error("Expected append.");
          expect(store.commitPreparedElementMutation(prepared.token).status).toBe("committed");
        }
        store.remove([inserted.id]);
      }
      expect(store.materializeBandOrder("highlight")).toEqual(highlight);
      const validate = vi.spyOn(renderBands, "renderBandOf");
      try {
        await replay(store, a, "reverse");
        expect(validate).toHaveBeenCalledTimes(elements.length);
      } finally {
        validate.mockRestore();
      }
    },
  );
});

describe("synchronous removal observer boundaries", () => {
  it("registers exact removal history before observers can mutate an untouched band", async () => {
    const { store, elements } = fixture();
    const content = store.materializeBandOrder("content");
    const highlight = store.materializeBandOrder("highlight");
    const older = await arrange(store, [highlight[0]!]);
    const afterOlder = store.materializeBandOrder("highlight");
    let mutated = false;
    const publications = vi.fn((delta: StoreDelta) => {
      if (mutated || !delta.changes.some(({ after }) => after === null)) return;
      mutated = true;
      store.arrange(new Set([afterOlder[0]!]), "bring-to-front");
    });
    const unsubscribe = store.subscribe(publications);
    const removed = store.removeWithHistory([elements[0]!.id]);
    unsubscribe();
    if (removed === null) throw new Error("Expected removal history.");
    expect(publications).toHaveBeenCalledTimes(2);
    expect(store.materializeBandOrder("highlight")).not.toEqual(afterOlder);
    expect(removed.transition.forward.bands.highlight).toEqual(afterOlder);
    const validate = vi.spyOn(renderBands, "renderBandOf");
    try {
      await replay(store, removed.transition, "reverse");
      expect(
        validate.mock.calls.filter(([element]) => "id" in element && element.id === highlight[0]),
      ).toHaveLength(1);
      expect(store.materializeBandOrder("content")).toEqual(content);
      expect(store.materializeBandOrder("highlight")).toEqual(afterOlder);
      validate.mockClear();
      await replay(store, older, "reverse");
      expect(validate).not.toHaveBeenCalled();
      expect(store.materializeBandOrder("highlight")).toEqual(highlight);
    } finally {
      validate.mockRestore();
    }
  });
});
