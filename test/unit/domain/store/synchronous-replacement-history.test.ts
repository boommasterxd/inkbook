import { describe, expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import * as recordFactory from "../../../../src/domain/store/records/record-factory";
import type { ElementReplacementHistoryData } from "../../../../src/domain/store/types";
import {
  moveSelection,
  rotateSelection,
} from "../../../../src/editor/selection/transform/transforms";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import { scaleSelectionUniformForTest } from "../../../fixtures/editor/selection-transform-reference";
import { connectedLine, highlighter, rectangle } from "./fixtures";

const transforms = {
  move: (element: InkElementV1) => moveSelection([element], { x: 25, y: 10 }),
  rotate: (element: InkElementV1) => rotateSelection([element], { x: 0, y: 0 }, 37),
  scale: (element: InkElementV1) => scaleSelectionUniformForTest([element], { x: 0, y: 0 }, 2),
};

function replaceWithHistory(store: ElementStore, elements: readonly InkElementV1[]) {
  let history: ElementReplacementHistoryData | undefined;
  const delta = store.replaceMany(elements, (captured) => {
    history = captured;
  });
  if (delta === null || history === undefined) throw new Error("Expected replacement history.");
  return { delta, history };
}

describe("synchronous replacement history", () => {
  it.each(["move", "rotate", "scale"] as const)(
    "reuses actual owned records through %s Undo and Redo",
    async (transform) => {
      const source = highlighter();
      const { store } = await hydrateRuntimeStroke(source);
      const original = store.get(source.id)!;
      const { history } = replaceWithHistory(
        store,
        transforms[transform](original.element as InkElementV1),
      );
      const changed = store.get(source.id)!;
      expect(history.previous[0]).toBe(original.element);
      expect(history.replacements[0]).toBe(changed.element);
      expect(history.payloadBytes).toBeGreaterThan(0);
      expect(Object.isFrozen(history.previous)).toBe(true);
      const copy = vi.spyOn(recordFactory, "createReplacementRecord");
      const translation = vi.spyOn(recordFactory, "createOwnedTranslatedReplacementRecord");
      try {
        expect(store.replaceMany(history.previous as readonly InkElementV1[])).not.toBeNull();
        const restored = store.get(source.id)!;
        expect(restored.element).toBe(original.element);
        expect(restored.bounds).toBe(original.bounds);
        expect(restored.geometryVersion).toBeGreaterThan(changed.geometryVersion);
        expect(restored.paintVersion).toBe(original.paintVersion);
        expect(store.replaceMany(history.replacements as readonly InkElementV1[])).not.toBeNull();
        const redone = store.get(source.id)!;
        expect(redone.element).toBe(changed.element);
        expect(redone.bounds).toBe(changed.bounds);
        expect(redone.geometryVersion).toBeGreaterThan(restored.geometryVersion);
        expect(copy).not.toHaveBeenCalled();
        expect(translation).not.toHaveBeenCalled();
      } finally {
        copy.mockRestore();
        translation.mockRestore();
      }
    },
  );

  it("captures propagated endpoint replacements in both history directions", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const originals = [store.get(target.id)!, store.get(line.id)!];
    const { delta, history } = replaceWithHistory(
      store,
      moveSelection([originals[0]!.element as InkElementV1], { x: 25, y: 10 }),
    );
    expect(delta.changes).toHaveLength(2);
    expect(history.previous.map(({ id }) => id)).toEqual([target.id, line.id]);
    const changed = [store.get(target.id)!, store.get(line.id)!];
    expect(store.replaceMany(history.previous as readonly InkElementV1[])).not.toBeNull();
    for (const original of originals) {
      expect(store.get(original.element.id)?.element).toBe(original.element);
      expect(store.get(original.element.id)?.bounds).toBe(original.bounds);
    }
    expect(store.replaceMany(history.replacements as readonly InkElementV1[])).not.toBeNull();
    for (const record of changed)
      expect(store.get(record.element.id)?.element).toBe(record.element);
  });

  it("copies public clones and foreign retained identities through the normal fallback", () => {
    const source = highlighter();
    const store = new ElementStore([source]);
    const original = store.get(source.id)!;
    const { history } = replaceWithHistory(
      store,
      transforms.scale(original.element as InkElementV1),
    );
    const other = new ElementStore(transforms.scale(source));
    const copy = vi.spyOn(recordFactory, "createReplacementRecord");
    try {
      expect(other.replaceMany(history.previous as readonly InkElementV1[])).not.toBeNull();
      expect(copy).toHaveBeenCalledTimes(1);
      expect(other.get(source.id)?.element).not.toBe(original.element);
      expect(other.get(source.id)?.bounds).not.toBe(original.bounds);

      const clone = { ...original.element, points: [...source.points] } as InkElementV1;
      expect(store.replaceMany([clone])).not.toBeNull();
      expect(copy).toHaveBeenCalledTimes(2);
      expect(store.get(source.id)?.element).not.toBe(original.element);
    } finally {
      copy.mockRestore();
    }
  });
});
