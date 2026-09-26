import { describe, expect, it, vi } from "vitest";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import * as validation from "../../../../src/domain/schema/element-validation";
import { moveSelection } from "../../../../src/editor/selection/transforms";
import { ElementStore } from "../../../../src/domain/store/public";
import { applySelectionStyleChange } from "../../../../src/editor/tools/style-change";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import type { InkElementV1 } from "../../../../src/domain/schema/public";

describe("owned stroke style validation", () => {
  it.each([false, true])("validates style without revisiting samples (typed=%s)", async (typed) => {
    const source = { ...indexedStroke(0), points: [20, 20, 0.5, 21, 21, 0.6] };
    const store = typed ? (await hydrateRuntimeStroke(source)).store : new ElementStore([source]);
    const before = store.get(indexedStroke(0).id)!.element as InkElementV1;
    if (before.kind !== "stroke") throw new Error("Expected stroke");
    const validate = vi.spyOn(validation, "validateRuntimeInkElementV1");
    try {
      const replacement = applySelectionStyleChange([before], { property: "opacity", value: 0.4 });
      const planned = store.planReplacements(replacement.elements)!;
      store.replaceMany(planned.replacements);
      expect(validate).toHaveBeenCalled();
      for (const [element] of validate.mock.calls) {
        expect((element as { points: unknown }).points).not.toBe(before.points);
        expect((element as { points: number[] }).points).toHaveLength(3);
      }
      const after = store.get(before.id)!.element;
      expect(after.kind === "stroke" && after.points).toBe(before.points);
      expect(after.kind === "stroke" && after.style.opacity).toBe(0.4);
    } finally {
      validate.mockRestore();
    }
  });

  it("adopts canonical translation samples without a second point-buffer copy", () => {
    const store = new ElementStore([indexedStroke(0)]);
    const record = store.get(indexedStroke(0).id)!;
    const [replacement] = moveSelection([record.element as InkElementV1], { x: 3, y: 4 });
    if (replacement?.kind !== "stroke") throw new Error("Expected stroke");
    store.replaceMany([replacement]);
    const moved = store.get(replacement.id)!;
    expect(moved.element).toBe(replacement);
    expect(moved.bounds).toEqual({
      minX: record.bounds.minX + 3,
      maxX: record.bounds.maxX + 3,
      minY: record.bounds.minY + 4,
      maxY: record.bounds.maxY + 4,
    });
  });

  it("does not reuse validation for an unowned source with invalid samples", () => {
    const source = { ...indexedStroke(0), points: [NaN, 20, 0.5] };
    expect(() =>
      applySelectionStyleChange([source], { property: "opacity", value: 0.4 }),
    ).toThrow();
  });

  it("still rejects malformed replacement fields and newly supplied samples", () => {
    const store = new ElementStore([{ ...indexedStroke(0), points: [20, 20, 0.5, 21, 21, 0.6] }]);
    const before = store.get(indexedStroke(0).id)!.element as InkElementV1;
    expect(() =>
      store.replaceMany([{ ...before, unexpected: true } as unknown as InkElementV1]),
    ).toThrow();
    expect(() =>
      store.replaceMany([{ ...before, style: { ...before.style, opacity: 2 } } as InkElementV1]),
    ).toThrow();
    expect(() =>
      store.replaceMany([{ ...before, points: [NaN, 0, 0.5] } as InkElementV1]),
    ).toThrow();
    expect(store.get(before.id)!.element).toBe(before);
  });
});
