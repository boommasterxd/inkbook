// @vitest-environment happy-dom
import { createElement, forwardRef, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createSettingsLayoutMotion } from "../../../../src/obsidian/settings/settings-layout-motion";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const motionState = vi.hoisted(() => ({ durations: [] as number[] }));

vi.mock("motion/react", () => ({
  motion: {
    div: forwardRef<
      HTMLDivElement,
      {
        children?: ReactNode;
        layout?: string;
        transition?: { duration: number };
      }
    >(({ children, layout, transition }, ref) => {
      if (layout === "size" && transition !== undefined)
        motionState.durations.push(transition.duration);
      return createElement("div", { ref }, children);
    }),
  },
}));

beforeEach(() => {
  installObsidianDomHelpers();
  motionState.durations.length = 0;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([
  { preference: "reduced" as const, systemReduced: false, duration: 0 },
  { preference: "full" as const, systemReduced: true, duration: 0.18 },
])(
  "honors $preference device motion over the system preference",
  ({ preference, systemReduced, duration }) => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: systemReduced } as MediaQueryList);
    const content = document.body.createDiv();
    const layout = createSettingsLayoutMotion(content, () => preference);
    layout.mutate(() => {
      content.createEl("button");
    });
    expect(content.querySelector("button")).not.toBeNull();
    expect(motionState.durations[motionState.durations.length - 1]).toBe(duration);
    layout.dispose();
  },
);

it("ignores a queued layout update after disposal", () => {
  const content = document.body.createDiv();
  const layout = createSettingsLayoutMotion(content, () => "full");
  const update = vi.fn();
  layout.dispose();
  expect(() => layout.mutate(update)).not.toThrow();
  expect(update).not.toHaveBeenCalled();
});

it("retargets running layout to Reduced without replacing the focused native control", () => {
  let preference: "full" | "reduced" = "full";
  let changed: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const content = document.body.createDiv();
  const input = content.createEl("input");
  const layout = createSettingsLayoutMotion(
    content,
    () => preference,
    (listener) => {
      changed = listener;
      return unsubscribe;
    },
  );
  input.focus();
  layout.mutate(() => {
    content.createEl("button");
  });
  preference = "reduced";
  changed();
  expect(motionState.durations[motionState.durations.length - 1]).toBe(0);
  expect(content.querySelector("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  layout.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
