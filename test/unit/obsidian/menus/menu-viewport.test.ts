import { describe, expect, it } from "vitest";

import { PhoneSheetHeight } from "../../../../src/obsidian/menus/menu-viewport";

describe("phone sheet height limits", () => {
  it("reserves the menu grabber without exceeding the keyboard viewport", () => {
    const height = new PhoneSheetHeight();
    expect(height.maximum({ width: 360, height: 800 }, 800, 16)).toBe(496);
    expect(height.maximum({ width: 360, height: 400 }, 400, 16)).toBe(400);
  });

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

describe("phone sheet keyboard overlay geometry", () => {
  const normal = { width: 360, height: 800, top: 0, left: 0 };

  it("moves above host keyboard overlays and restores its normal height", () => {
    const height = new PhoneSheetHeight();
    const results = [0, 200, 350, 0].map((keyboard) => {
      const viewport = height.viewport(normal, 800, keyboard);
      return [viewport.height, height.maximum(viewport, 800)];
    });
    expect(results).toEqual([
      [800, 480],
      [600, 480],
      [450, 450],
      [800, 480],
    ]);
  });

  it.each([800, 450])("does not subtract the keyboard twice with layout height %s", (layout) => {
    const height = new PhoneSheetHeight();
    height.viewport(normal, 800, 0);
    const viewport = height.viewport({ ...normal, height: 450 }, layout, 350);
    expect(viewport.height).toBe(450);
    expect(height.maximum(viewport, layout)).toBe(450);
  });

  it("accounts for viewport offset and clamps a fully obstructed viewport", () => {
    const height = new PhoneSheetHeight();
    expect(height.viewport({ ...normal, top: 100, left: 12 }, 800, 350)).toEqual({
      ...normal,
      top: 100,
      left: 12,
      height: 350,
    });
    expect(height.viewport(normal, 800, 900).height).toBe(0);
  });

  it.each([0, -1])("ignores inactive keyboard inset %s", (keyboard) => {
    const height = new PhoneSheetHeight();
    const viewport = { ...normal, top: 100 };
    expect(height.viewport(viewport, 800, keyboard)).toEqual(viewport);
  });

  it("resets the unobstructed baseline when orientation changes", () => {
    const height = new PhoneSheetHeight();
    height.viewport(normal, 800, 0);
    expect(height.viewport({ ...normal, width: 800, height: 360 }, 360, 100).height).toBe(260);
  });
});
