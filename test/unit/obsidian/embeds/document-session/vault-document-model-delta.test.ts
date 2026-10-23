import { describe, expect, it } from "vitest";

import { ElementStore, type StoreDelta } from "../../../../../src/domain/store/public";
import { MAX_ELEMENT_CELLS, SPATIAL_CELL_SIZE } from "../../../../../src/domain/spatial/index";
import { prepareVaultStoreDelta } from "../../../../../src/obsidian/embeds/document-session/vault-document-model-delta";
import { CoalescedExportTarget } from "../../../../../src/persistence/worker/coalesced-export";
import { connectedLine, highlighter, IDS, rectangle } from "../../../domain/store/fixtures";

function removalExportTarget(delta: StoreDelta) {
  const target = new CoalescedExportTarget(7, ({ id }: { readonly id: string }) => id);
  target.record({
    ...prepareVaultStoreDelta(delta),
    dirtyBands: (["highlight", "content"] as const).filter((band) => delta.dirtyBands[band]),
    modelRevision: 8,
  });
  return target;
}

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
      const target = removalExportTarget(delta);
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

    const target = removalExportTarget(delta);
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

    const prepared = prepareVaultStoreDelta(delta);
    expect(prepared.changedElements.map(({ id }) => id)).toEqual([line.id]);
    expect(prepared.removedIds).toEqual([targetElement.id]);
    expect(prepared.changedElementDerivations[0]?.bounds).toBe(store.get(line.id)?.bounds);
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

    expect(prepareVaultStoreDelta(arranged).changedElements).toEqual([]);
    const prepared = prepareVaultStoreDelta(replaced);
    expect(prepared.changedElements).toEqual([painted]);
    expect(prepared.changedElementDerivations).toEqual([
      expect.objectContaining({
        bounds: replaced.changes[0]!.after!.bounds,
        elementId: painted.id,
      }),
    ]);
  });
});

describe("vault delta projection boundaries", () => {
  it("preserves mixed delta order, record identity, and fragment domain classification", () => {
    const source = rectangle();
    const store = new ElementStore([source]);
    const after = store.get(source.id)!;
    const domains: StoreDelta["changes"][number]["domains"][] = [
      ["order"],
      ["connection"],
      ["visibility"],
      ["paint"],
      [],
      ["geometry", "paint"],
    ];
    const delta: StoreDelta = {
      changes: domains.map((domain, index) => ({
        after: index === 4 ? null : after,
        before: after,
        domains: domain,
        id: String(index),
      })),
      dirtyBands: { content: true, highlight: false },
      geometryVersion: 1,
      paintVersion: 1,
    };
    const prepared = prepareVaultStoreDelta(delta);

    expect(prepared.changedElements).toEqual([after.element, after.element, after.element]);
    expect(prepared.changedElements.every((element) => element === after.element)).toBe(true);
    expect(prepared.changedElementDerivations.map(({ elementId }) => elementId)).toEqual([
      "1",
      "3",
      "5",
    ]);
    expect(prepared.changedElementDerivations.every(({ bounds }) => bounds === after.bounds)).toBe(
      true,
    );
    expect(prepared.removedIds).toEqual(["4"]);
    expect(prepareVaultStoreDelta({ ...delta, changes: [] })).toEqual({
      changedElementDerivations: [],
      changedElements: [],
      removedIds: [],
    });
  });

  it("retains the spatial membership limit, overflow sentinel, and invalid bounds failure", () => {
    const source = rectangle();
    const store = new ElementStore([source]);
    const record = store.get(source.id)!;
    const changes = [MAX_ELEMENT_CELLS - 1, MAX_ELEMENT_CELLS].map((lastCell) => ({
      after: {
        ...record,
        bounds: { minX: 0, minY: 0, maxX: lastCell * SPATIAL_CELL_SIZE, maxY: 0 },
      },
      before: null,
      domains: ["geometry"] as const,
      id: source.id,
    }));
    const delta: StoreDelta = {
      changes,
      dirtyBands: { content: true, highlight: false },
      geometryVersion: 1,
      paintVersion: 0,
    };

    expect(prepareVaultStoreDelta(delta).changedElementDerivations).toMatchObject([
      { spatialMemberships: MAX_ELEMENT_CELLS, spatialOverflow: false },
      { spatialMemberships: 0, spatialOverflow: true },
    ]);
    const invalid = {
      ...changes[0]!,
      after: { ...record, bounds: { ...record.bounds, minX: NaN } },
    };
    expect(() => prepareVaultStoreDelta({ ...delta, changes: [invalid] })).toThrow(TypeError);
  });
});
