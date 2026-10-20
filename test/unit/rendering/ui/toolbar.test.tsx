import { describe, expect, it } from "vitest";

import {
  nextToolbarIndex,
  resolveToolbarFocusRecovery,
} from "../../../../src/rendering/ui/toolbar-focus";
import { resolveToolbarNavigationKey } from "../../../../src/rendering/ui/toolbar";

describe("Inkbook toolbar", () => {
  it("resolves group keyboard navigation", () => {
    expect(nextToolbarIndex("ArrowRight", 2, 4)).toBe(3);
    expect(nextToolbarIndex("ArrowRight", 3, 4)).toBe(0);
    expect(nextToolbarIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(nextToolbarIndex("Home", 3, 4)).toBe(0);
    expect(nextToolbarIndex("End", 0, 4)).toBe(3);
    expect(nextToolbarIndex("Escape", 0, 4)).toBeNull();
    expect(nextToolbarIndex("ArrowRight", 0, 0)).toBeNull();
    expect(resolveToolbarNavigationKey("ArrowLeft", true)).toBe("ArrowRight");
    expect(resolveToolbarNavigationKey("ArrowRight", false)).toBe("ArrowRight");
  });

  it("recovers focus to the nearest remaining control when a conditional control disappears", () => {
    expect(resolveToolbarFocusRecovery(["copy", "cut", "delete", "lock"], ["lock"], "cut")).toBe(
      "lock",
    );
    expect(
      resolveToolbarFocusRecovery(
        ["copy", "cut", "delete", "lock", "overflow"],
        ["lock", "overflow"],
        "cut",
      ),
    ).toBe("lock");
    expect(resolveToolbarFocusRecovery(["undo", "redo"], ["undo"], "redo")).toBe("undo");
    expect(resolveToolbarFocusRecovery(["undo"], [], "undo")).toBeNull();
  });
});
