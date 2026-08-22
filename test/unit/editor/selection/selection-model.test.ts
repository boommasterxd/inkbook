import { describe, expect, it } from "vitest";

import { lassoBounds, selectByLasso, selectElement } from "../../../../src/editor/selection/public";

describe("selection model", () => {
  it("replaces, preserves, and adds element selections", () => {
    const initial = new Set(["a", "b"]);
    expect(selectElement(initial, "a", "preserve-or-replace")).toBe(initial);
    expect([...selectElement(initial, "c", "replace")]).toEqual(["c"]);
    expect([...selectElement(initial, "c", "add")]).toEqual(["a", "b", "c"]);
  });

  it("selects every intersecting lasso candidate and supports additive selection", () => {
    const candidates = [
      ["a", { minX: 0, minY: 0, maxX: 10, maxY: 10 }],
      ["b", { minX: 20, minY: 20, maxX: 30, maxY: 30 }],
    ] as const;
    const bounds = lassoBounds({ x: 15, y: 15 }, { x: 5, y: 5 });
    expect([...selectByLasso(new Set(["old"]), bounds, candidates, false)]).toEqual(["a"]);
    expect([...selectByLasso(new Set(["old"]), bounds, candidates, true)]).toEqual(["old", "a"]);
  });
});
