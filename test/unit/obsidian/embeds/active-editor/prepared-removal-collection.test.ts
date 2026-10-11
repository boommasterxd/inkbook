import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ActiveDocumentHistory } from "../../../../../src/obsidian/embeds/active-editor/document-history";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-model-port";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { invalidatePendingHistory } from "../../../../fixtures/obsidian/active-editor";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";

function removalFixture(elements: readonly InkElementV1[] = [indexedStroke(0), indexedStroke(1)]) {
  const store = new ElementStore(elements);
  let revision = 0;
  let leased = false;
  const release = vi.fn(() => {
    leased = false;
  });
  const model = {
    get revision() {
      return revision;
    },
    store,
    ...elementMutationPorts(store, () => {
      revision += 1;
    }),
    beginInteractiveOperation: () => {
      leased = true;
      return release;
    },
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const pending: boolean[] = [];
  const documentHistory = new ActiveDocumentHistory({
    history,
    model,
    onPendingChanged: (value) => pending.push(value),
  });
  const prepare = vi.spyOn(model, "prepareElementRemoval");
  const commit = vi.spyOn(model, "commitPreparedElementMutation");
  return {
    commit,
    documentHistory,
    elements,
    history,
    model,
    pending,
    prepare,
    release,
    store,
    assertLeased: () => expect(leased).toBe(true),
    advanceRevision: () => {
      revision += 1;
    },
  };
}

describe("prepared removal ID collection", () => {
  it("filters missing selection IDs before the callback and restores removed records through history", async () => {
    const fixture = removalFixture();
    const stroke = fixture.elements[0]!;
    const reads = vi.spyOn(fixture.store, "get");
    reads.mockImplementation((...args) => {
      fixture.assertLeased();
      return ElementStore.prototype.get.apply(fixture.store, args);
    });
    const collected = vi.fn((ids: readonly string[]) => {
      fixture.assertLeased();
      expect(fixture.prepare).not.toHaveBeenCalled();
      expect(ids).toEqual([stroke.id]);
    });

    await expect(
      fixture.documentHistory.removeSelection(
        new Set(["missing", stroke.id]),
        immediateWorkScheduler(),
        () => true,
        collected,
      ),
    ).resolves.toBe("applied");
    expect(collected).toHaveBeenCalledOnce();
    expect(fixture.prepare.mock.calls[0]![0]).toEqual([stroke.id]);
    reads.mockRestore();
    expect(fixture.store.get(stroke.id)).toBeUndefined();
    expect(fixture.store.get(fixture.elements[1]!.id)?.element).toEqual(fixture.elements[1]);
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.store.get(stroke.id)?.element).toEqual(stroke);
    await expect(fixture.history.redoAsync()).resolves.toBe(true);
    expect(fixture.store.get(stroke.id)).toBeUndefined();
    expect(fixture.history.commandCount).toBe(1);
  });
});

describe("removal collection cancellation and failure", () => {
  it.each(["selection", "revision", "dispose"] as const)(
    "cancels %s during collection without a fade callback or mutation",
    async (reason) => {
      const fixture = removalFixture();
      let current = true;
      let resume = () => undefined as void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reads = vi.spyOn(fixture.store, "get");
      const scheduler = { ...immediateWorkScheduler(), checkpoint: vi.fn(() => gate) };
      const collected = vi.fn();
      const result = fixture.documentHistory.removeSelection(
        new Set(fixture.elements.map(({ id }) => id)),
        scheduler,
        () => current,
        collected,
      );
      fixture.assertLeased();
      expect(fixture.pending).toEqual([true]);
      expect(reads).not.toHaveBeenCalled();
      expect(scheduler.checkpoint).toHaveBeenCalledOnce();
      current = invalidatePendingHistory(reason, fixture.documentHistory, fixture.advanceRevision);
      resume();
      await expect(result).resolves.toBe("stale");
      expect(collected).not.toHaveBeenCalled();
      expect(fixture.prepare).not.toHaveBeenCalled();
      expect(fixture.commit).not.toHaveBeenCalled();
      expect(fixture.history.commandCount).toBe(0);
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.pending).toEqual([true, false]);
    },
  );

  it.each(["empty", "missing", "checkpoint", "preparation"] as const)(
    "releases ownership without mutation at the %s boundary",
    async (boundary) => {
      const fixture = removalFixture();
      const collected = vi.fn();
      const noop = boundary === "empty" || boundary === "missing";
      const scheduler = {
        ...immediateWorkScheduler(),
        checkpoint: () =>
          boundary === "checkpoint" ? Promise.reject(new Error("collection failed")) : undefined,
      };
      if (boundary === "preparation")
        fixture.prepare.mockRejectedValue(new Error("preparation failed"));
      const ids =
        boundary === "empty" ? [] : [boundary === "missing" ? "missing" : fixture.elements[0]!.id];
      await expect(
        fixture.documentHistory.removeSelection(new Set(ids), scheduler, () => true, collected),
      ).resolves.toBe(noop ? "noop" : "failed");
      if (noop) expect(fixture.prepare).not.toHaveBeenCalled();
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.pending).toEqual([true, false]);
      expect(collected).toHaveBeenCalledTimes(boundary === "preparation" ? 1 : 0);
      expect(fixture.commit).not.toHaveBeenCalled();
      expect(fixture.history.commandCount).toBe(0);
    },
  );
});

describe("prepared remove-all collection", () => {
  it("collects both bands under its lease without materializing order and restores them", async () => {
    const pen = indexedStroke(0);
    const highlight = {
      ...indexedStroke(1),
      tool: "highlighter" as const,
      style: { ...pen.style, pressureEnabled: false, width: 8 as const },
    };
    const fixture = removalFixture([pen, highlight]);
    const beginOrder = vi.spyOn(fixture.store, "beginOrder");
    beginOrder.mockImplementation((...args) => {
      fixture.assertLeased();
      return ElementStore.prototype.beginOrder.apply(fixture.store, args);
    });
    const materialize = vi.spyOn(fixture.store, "materializeBandOrder");

    await expect(
      fixture.documentHistory.removeAll(immediateWorkScheduler(), () => true),
    ).resolves.toBe("applied");
    expect(beginOrder).toHaveBeenCalledOnce();
    expect(materialize).not.toHaveBeenCalled();
    expect(fixture.prepare.mock.calls[0]![0]).toEqual([highlight.id, pen.id]);
    expect(fixture.store.size).toBe(0);
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.store.get(pen.id)?.element).toEqual(pen);
    expect(fixture.store.get(highlight.id)?.element).toEqual(highlight);
    expect(fixture.store.getRank(pen.id)).toEqual({ band: "content", rank: 0 });
    expect(fixture.store.getRank(highlight.id)).toEqual({ band: "highlight", rank: 0 });
  });

  it("closes the order cursor when cancellation interrupts collection", async () => {
    const fixture = removalFixture();
    const cursor = fixture.store.beginOrder();
    const cancel = vi.spyOn(cursor, "cancel");
    vi.spyOn(fixture.store, "beginOrder").mockImplementation(() => {
      fixture.assertLeased();
      return cursor;
    });
    let current = true;
    const scheduler = {
      ...immediateWorkScheduler(() => true),
      checkpoint: () => {
        current = false;
        return Promise.resolve();
      },
    };

    await expect(fixture.documentHistory.removeAll(scheduler, () => current)).resolves.toBe(
      "stale",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.store.size).toBe(2);
    expect(fixture.history.commandCount).toBe(0);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("releases ownership for an empty document", async () => {
    const fixture = removalFixture([]);
    await expect(
      fixture.documentHistory.removeAll(immediateWorkScheduler(), () => true),
    ).resolves.toBe("noop");
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.pending).toEqual([true, false]);
    expect(fixture.history.commandCount).toBe(0);
  });
});
