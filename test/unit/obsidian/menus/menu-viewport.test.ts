import { describe, expect, it } from "vitest";

import { PhoneSheetHeight } from "../../../../src/obsidian/menus/menu-viewport";

describe("phone sheet height limits", () => {
  it.each([false, true])(
    "keeps the normal height when keyboard also resizes layout: %s",
    (adjustResize) => {
      const height = new PhoneSheetHeight();
      const maximums = [800, 450, 400, 800].map((current) =>
        height.maximum({ width: 360, height: current }, adjustResize ? current : 800),
      );
      expect(maximums).toEqual([480, 450, 400, 480]);
    },
  );

  it("resets the baseline for a different viewport width", () => {
    const height = new PhoneSheetHeight();
    expect(height.maximum({ width: 360, height: 800 }, 800)).toBe(480);
    expect(height.maximum({ width: 800, height: 360 }, 360)).toBe(216);
    expect(height.maximum({ width: 800, height: 200 }, 200)).toBe(200);
  });

  it("uses only observable height when opened into an already reduced layout", () => {
    const height = new PhoneSheetHeight();
    expect(height.maximum({ width: 360, height: 400 }, 400)).toBe(240);
    expect(height.maximum({ width: 360, height: 800 }, 800)).toBe(480);
  });
});
