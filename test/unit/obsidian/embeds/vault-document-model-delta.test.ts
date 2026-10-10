import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import {
  changedElementDerivations,
  changedElements,
  removedElementIds,
} from "../../../../src/obsidian/embeds/vault-document-model-delta";
import { CoalescedExportTarget } from "../../../../src/persistence/worker/coalesced-export";
import { connectedLine, highlighter, IDS, rectangle } from "../../domain/store/fixtures";

describe("vault document model deltas", () => {
  it.each(["tail", "whole-band"] as const)(
    "preserves the complete worker order update for %s removal",
    (scope) => {
      const first = rectangle();
      const last = rectangle(IDS.other, 500, 100);
      const highlight = highlighter();
      const store = new ElementStore([highlight, first, last]);
      const removed = scope === "tail" ? [last.id] : [first.id, last.id];
      const delta = store.remove(removed);
      if (delta === null) throw new Error("Expected a removal delta.");
      const target = new CoalescedExportTarget(7, ({ id }: { readonly id: string }) => id);
      target.record({
        changedElements: changedElements(delta),
        dirtyBands: (["highlight", "content"] as const).filter((band) => delta.dirtyBands[band]),
        modelRevision: 8,
        removedIds: removedElementIds(delta),
      });
      const plan = target.materialize({
        orderByBand: { content: store.materializeBandOrder("content") },
      });

      expect(delta.dirtyBands).toEqual({ content: true, highlight: false });
      expect(plan).toMatchObject({
        changedElements: [],
        orderChanges: { content: scope === "tail" ? [first.id] : [] },
        removedIds: removed,
        type: "incremental",
      });
      expect(store.materializeBandOrder("highlight")).toEqual([highlight.id]);
    },
  );

  it("keeps removal rank shifts order-only through export planning", () => {
    const first = rectangle();
    const second = rectangle(IDS.other, 500, 100);
    const store = new ElementStore([first, second]);
    const delta = store.remove([first.id]);
    if (delta === null) throw new Error("Expected a removal delta.");

    const target = new CoalescedExportTarget(7, ({ id }: { readonly id: string }) => id);
    target.record({
      changedElements: changedElements(delta),
      dirtyBands: ["content"],
      modelRevision: 8,
      removedIds: removedElementIds(delta),
    });
    const plan = target.materialize({ orderByBand: { content: [second.id] } });

    expect(plan).toMatchObject({
      changedElements: [],
      orderChanges: { content: [second.id] },
      removedIds: [first.id],
      type: "incremental",
    });
  });

  it("retains geometry and connection changes caused by removal", () => {
    const targetElement = rectangle();
    const line = connectedLine(targetElement);
    const store = new ElementStore([targetElement, line]);
    const delta = store.remove([targetElement.id]);
    if (delta === null) throw new Error("Expected a connected removal delta.");

    expect(changedElements(delta).map(({ id }) => id)).toEqual([line.id]);
    expect(removedElementIds(delta)).toEqual([targetElement.id]);
  });

  it("excludes pure arrange changes while retaining paint replacements", () => {
    const first = rectangle();
    const second = rectangle(IDS.other, 500, 100);
    const store = new ElementStore([first, second]);
    const arranged = store.arrange(new Set([first.id]), "bring-to-front");
    if (arranged === null) throw new Error("Expected an arrange delta.");
    const painted = { ...first, style: { ...first.style, outlineOpacity: 0.5 } };
    const replaced = store.replace(first.id, painted);
    if (replaced === null) throw new Error("Expected a paint delta.");

    expect(changedElements(arranged)).toEqual([]);
    expect(changedElements(replaced)).toEqual([painted]);
    expect(changedElementDerivations(replaced)).toEqual([
      expect.objectContaining({
        bounds: replaced.changes[0]!.after!.bounds,
        elementId: painted.id,
      }),
    ]);
  });
});
