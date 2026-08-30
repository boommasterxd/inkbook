import { describe, expect, it } from "vitest";

import {
  resolveToolbarLayout,
  TOOLBAR_CONTEXT_CORRIDOR_PX,
} from "../../../../src/rendering/ui/toolbar-layout";

describe("toolbar layout", () => {
  it("uses one fitted row while the complete toolbar content fits", () => {
    expect(
      resolveToolbarLayout({
        availableWidth: 620 + TOOLBAR_CONTEXT_CORRIDOR_PX,
        contentWidth: 620,
      }),
    ).toBe("wide");
  });

  it("keeps transient context actions from changing the primary layout decision", () => {
    expect(
      resolveToolbarLayout({
        availableWidth: 620 + TOOLBAR_CONTEXT_CORRIDOR_PX,
        contentWidth: 620,
      }),
    ).toBe("wide");
  });

  it("uses horizontal scrolling without shrinking controls when content overflows", () => {
    expect(
      resolveToolbarLayout({
        availableWidth: 619 + TOOLBAR_CONTEXT_CORRIDOR_PX,
        contentWidth: 620,
      }),
    ).toBe("scrollable");
  });

  it("treats a zero-width owner as scrollable", () => {
    expect(resolveToolbarLayout({ availableWidth: 0, contentWidth: 1 })).toBe("scrollable");
  });
});
