import { describe, expect, it } from "vitest";

import type { InkElementV1, StrokeElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../../../src/editor/selection/public";

import { highlighter } from "../fixtures";

describe("canonical stroke replacement ownership", () => {
  it("retains the proven reference when the caller swaps a batch entry during a handoff", async () => {
    const source = highlighter();
    const store = new ElementStore([source]);
    const before = store.get(source.id)!;
    const translated = await moveSelectionTimeSliced(
      [before.element as StrokeElementV1],
      { x: 1, y: 2 },
      { shouldYield: () => false, yieldControl: async () => undefined },
    );
    if (translated === null) throw new Error("Expected a canonical replacement.");
    const proven = translated[0]!;
    const batch: InkElementV1[] = [proven];
    let handoffs = 0;
    const prepared = await store.prepareElementReplacement(batch, {
      shouldYield: () => handoffs === 0,
      yieldControl: async () => {
        handoffs += 1;
        batch[0] = { ...source, points: [Number.NaN, 300, 0.5, 200, 300, 0.5] };
        expect(store.get(source.id)).toBe(before);
      },
    });
    expect(handoffs).toBe(1);
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    expect(store.get(source.id)).toBe(before);
    const committed = store.commitPreparedElementReplacement(prepared.token);
    expect(committed.status).toBe("committed");
    expect(committed.delta?.changes).toMatchObject([{ domains: ["geometry"], id: source.id }]);
    expect(store.get(source.id)!.element).toEqual(proven);
    expect(store.get(source.id)!.geometryVersion).toBe(before.geometryVersion + 1);
    expect(store.get(source.id)!.paintVersion).toBe(before.paintVersion);
  });
});
