import { describe, expect, it } from "vitest";

import {
  LEFT_HANDED_TOOL_TRANSLATION_PX,
  resolveToolbarLayout,
} from "../../../../src/rendering/ui/toolbar-layout";

describe("toolbar layout", () => {
  it("keeps the tool group exactly centered when both sides fit", () => {
    expect(
      resolveToolbarLayout({
        availableWidth: 700,
        centerWidth: 300,
        leftWidth: 120,
        mergedWidth: 600,
        rightWidth: 160,
      }),
    ).toBe("wide");
  });

  it("merges groups when the centered layout collides but one row still fits", () => {
    expect(
      resolveToolbarLayout({
        availableWidth: 620,
        centerWidth: 300,
        leftWidth: 160,
        mergedWidth: 600,
        rightWidth: 180,
      }),
    ).toBe("merged");
  });

  it("accounts for the exact left-handed translation before choosing the wide layout", () => {
    const measurements = {
      availableWidth: 616,
      centerTranslation: LEFT_HANDED_TOOL_TRANSLATION_PX,
      centerWidth: 300,
      leftWidth: 120,
      mergedWidth: 580,
      rightWidth: 160,
    };

    expect(resolveToolbarLayout(measurements)).toBe("wide");
    expect(resolveToolbarLayout({ ...measurements, availableWidth: 615 })).toBe("merged");
  });

  it("uses horizontal scrolling without shrinking controls", () => {
    expect(
      resolveToolbarLayout({
        availableWidth: 500,
        centerWidth: 300,
        leftWidth: 160,
        mergedWidth: 600,
        rightWidth: 180,
      }),
    ).toBe("scrollable");
  });
});
