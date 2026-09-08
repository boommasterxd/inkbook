import { describe, expect, it } from "vitest";

import { selectElement } from "../../../../src/editor/selection/public";

describe("selection model", () => {
  it("replaces, preserves, and adds element selections", () => {
    const initial = new Set(["a", "b"]);
    expect(selectElement(initial, "a", "preserve-or-replace")).toBe(initial);
    expect([...selectElement(initial, "c", "replace")]).toEqual(["c"]);
    expect([...selectElement(initial, "c", "add")]).toEqual(["a", "b", "c"]);
  });
});
