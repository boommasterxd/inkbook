import { afterEach, describe, expect, it, vi } from "vitest";

import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import * as strokePosition from "../../../../src/domain/geometry/stroke-position";
import type { InkElementV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import type { ImmutableInkElement } from "../../../../src/domain/store/types";
import {
  moveSelection,
  rotateSelection,
  scaleElement,
} from "../../../../src/editor/selection/transform/transforms";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import { highlighter } from "./fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
afterEach(() => vi.restoreAllMocks());

async function apply(store: ElementStore, replacements: readonly ImmutableInkElement[]) {
  const prepared = await store.prepareElementReplacement(
    replacements as readonly InkElementV1[],
    scheduler,
  );
  if (prepared.token === null) throw new Error("Expected replacement token.");
  const result = store.commitPreparedElementReplacement(prepared.token);
  if (result.history === null) throw new Error("Expected replacement history.");
  return result.history;
}

function replacementsFor(stroke: StrokeElementV1, mode: string): InkElementV1[] {
  if (mode === "translation") return moveSelection([stroke], { x: 20, y: 30 });
  if (mode === "rotation") return rotateSelection([stroke], { x: 0, y: 0 }, 90);
  if (mode === "scale") return [scaleElement(stroke, { x: 0, y: 0 }, { x: 2, y: 2 })];
  return [{ ...stroke, style: { ...stroke.style, width: 14 } }];
}

describe("prepared owned replacement replay", () => {
  it.each(["style", "translation", "rotation", "scale"])(
    "restores exact element and bounds identities for %s undo and redo",
    async (mode) => {
      const source = highlighter();
      const { store, stroke } = await hydrateRuntimeStroke(source);
      const before = store.get(source.id)!;
      const replacements = replacementsFor(stroke, mode);
      const history = await apply(store, replacements);
      const after = store.get(source.id)!;
      const copy = vi.spyOn(sampleCopy, "copySampleRange");
      const geometry = vi.spyOn(strokePosition, "strokeWorldPoint");

      await apply(store, history.previous);
      expect(store.get(source.id)!.element).toBe(before.element);
      expect(store.get(source.id)!.bounds).toBe(before.bounds);
      expect(store.get(source.id)!.geometryVersion).toBeGreaterThan(after.geometryVersion);

      await apply(store, history.replacements);
      expect(store.get(source.id)!.element).toBe(after.element);
      expect(store.get(source.id)!.bounds).toBe(after.bounds);
      expect(copy).not.toHaveBeenCalled();
      expect(geometry).not.toHaveBeenCalled();
    },
  );

  it("rebuilds an equal foreign-store history element through its own geometry boundary", async () => {
    const source = highlighter();
    const { store, stroke } = await hydrateRuntimeStroke(source);
    const history = await apply(store, [{ ...stroke, style: { ...stroke.style, width: 14 } }]);
    const other = (await hydrateRuntimeStroke(source)).store;
    const geometry = vi.spyOn(strokePosition, "strokeWorldPoint");
    await apply(other, history.replacements);
    expect(other.get(source.id)!.element).not.toBe(store.get(source.id)!.element);
    expect(other.get(source.id)!.bounds).not.toBe(store.get(source.id)!.bounds);
    expect(geometry).toHaveBeenCalledTimes(source.points.length / 3);
  });
});
