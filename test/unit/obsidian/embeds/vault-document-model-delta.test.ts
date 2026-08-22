import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import {
  changedElements,
  removedElementIds,
} from "../../../../src/obsidian/embeds/vault-document-model-delta";
import { CoalescedExportTarget } from "../../../../src/persistence/worker/coalesced-export";
import { connectedLine, IDS, rectangle } from "../../domain/store/fixtures";

describe("vault document model deltas", () => {
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
  });
});
