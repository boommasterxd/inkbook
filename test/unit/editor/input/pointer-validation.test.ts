import { describe, expect, it } from "vitest";

import { classifyPointerDown, isValidPointerSample } from "../../../../src/editor/input/index";
import { classifyPenRole, hasPenContact } from "../../../../src/editor/input/pointer-validation";

function classify(
  overrides: Partial<Parameters<typeof classifyPointerDown>[0]> = {},
): ReturnType<typeof classifyPointerDown> {
  return classifyPointerDown({
    button: 0,
    buttons: 1,
    controlKey: false,
    controlOrMeta: false,
    isMacPlatform: false,
    isPrimary: true,
    pointerType: "mouse",
    ...overrides,
  });
}

describe("pointer-down classification", () => {
  it.each([
    ["right drag", { button: 2, buttons: 2 }],
    ["auxiliary drag", { button: 1, buttons: 4 }],
    ["combined primary and secondary buttons", { button: 0, buttons: 3 }],
    ["unknown button mask", { button: 0, buttons: 4 }],
    [
      "macOS Control drag",
      { button: 0, controlKey: true, controlOrMeta: true, isMacPlatform: true },
    ],
    ["temporary Eraser modifier", { button: 0, controlOrMeta: true }],
    ["non-primary contact", { button: 0, isPrimary: false }],
  ] as const)("keeps %s away from selection handles", (_label, overrides) => {
    expect(classify(overrides).handleEligible).toBe(false);
  });

  it("recognizes only mouse context clicks as platform context input", () => {
    expect(classify({ button: 2, buttons: 2 }).isPlatformContextClick).toBe(true);
    expect(
      classify({
        controlKey: true,
        controlOrMeta: true,
        isMacPlatform: true,
      }).isPlatformContextClick,
    ).toBe(true);
    expect(classify({ button: 2, buttons: 2, pointerType: "pen" }).isPlatformContextClick).toBe(
      false,
    );
  });

  it.each([
    ["barrel button", { button: 2, buttons: 2 }, "side-button"],
    ["barrel button mask", { button: 0, buttons: 2 }, "side-button"],
    ["auxiliary barrel", { button: 1, buttons: 4 }, "side-button"],
    ["chorded barrel", { button: -1, buttons: 3 }, "side-button"],
    ["chorded auxiliary barrel", { button: -1, buttons: 5 }, "side-button"],
    ["eraser tip", { button: 5, buttons: 32 }, "eraser"],
    ["eraser tip with primary contact mask", { button: 5, buttons: 1 }, "eraser"],
    ["eraser mask", { button: 0, buttons: 32 }, "eraser"],
    ["eraser with barrel", { button: -1, buttons: 38 }, "eraser"],
  ] as const)("classifies a pen %s before handle eligibility", (_label, input, penRole) => {
    expect(classify({ ...input, pointerType: "pen" })).toEqual({
      handleEligible: false,
      isPlatformContextClick: false,
      penRole,
    });
  });

  it.each(["mouse", "pen", "touch"] as const)(
    "allows an unmodified primary %s pointer to start a handle",
    (pointerType) => {
      expect(classify({ pointerType }).handleEligible).toBe(true);
    },
  );
});

describe("pen button and contact classification", () => {
  it.each([1, 2, 5])("ignores released button %s", (button) => {
    expect(classifyPenRole({ pointerType: "pen", button, buttons: 0 })).toBe("normal");
    if (button !== 5) {
      expect(classifyPenRole({ pointerType: "pen", button, buttons: 1 })).toBe("normal");
    }
  });

  it.each([
    [1, "side-button"],
    [2, "side-button"],
    [5, "eraser"],
  ] as const)("uses button %s with a non-contact held mask", (button, role) => {
    expect(classifyPenRole({ pointerType: "pen", button, buttons: 8 })).toBe(role);
  });

  it.each(["mouse", "touch"] as const)("does not claim %s buttons", (pointerType) => {
    expect(classifyPenRole({ pointerType, button: 5, buttons: 38 })).toBe("normal");
  });

  it.each([
    [0, undefined, false],
    [2, 0, false],
    [4, 0, false],
    [1, 0, true],
    [3, 0, true],
    [5, 0, true],
    [32, 0, true],
    [0, 0.1, true],
  ] as const)("resolves contact for buttons %s and pressure %s", (buttons, pressure, expected) => {
    expect(hasPenContact({ buttons, ...(pressure === undefined ? {} : { pressure }) })).toBe(
      expected,
    );
  });
});

describe("pointer sample validation", () => {
  it("accepts the coordinate boundary and rejects values beyond it", () => {
    const sample = { pointerId: 1, pointerType: "pen" as const, pressure: 0.5, x: 0, y: 0 };
    expect(isValidPointerSample({ ...sample, x: 1_000_000, y: -1_000_000 })).toBe(true);
    expect(isValidPointerSample({ ...sample, x: 1_000_000.001 })).toBe(false);
  });

  it("rejects unsafe pointer identities and non-finite numeric input", () => {
    const sample = { pointerId: 1, pointerType: "pen" as const, pressure: 0.5, x: 0, y: 0 };
    expect(isValidPointerSample({ ...sample, pointerId: -1 })).toBe(false);
    expect(isValidPointerSample({ ...sample, pressure: Number.NaN })).toBe(false);
    expect(isValidPointerSample({ ...sample, pressure: 1.001 })).toBe(false);
    expect(isValidPointerSample({ ...sample, y: Number.POSITIVE_INFINITY })).toBe(false);
  });
});
