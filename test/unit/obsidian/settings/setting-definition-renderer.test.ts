// @vitest-environment happy-dom

import type { SettingDefinitionControl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingDefinitionRenderer } from "../../../../src/obsidian/settings/setting-definition-renderer";
import { nameSettingToggle } from "../../../../src/obsidian/settings/settings-row";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
});

describe("named settings controls", () => {
  it.each(["dropdown", "text", "folder"] as const)(
    "names %s controls and persists user changes",
    (type) => {
      const setControlValue = vi.fn();
      const renderer = new SettingDefinitionRenderer(
        { getControlValue: () => "auto", setControlValue },
        vi.fn(),
      );
      const control =
        type === "dropdown"
          ? { type, key: "profile", options: { auto: "Automatic", "60": "60 Hz" } }
          : { type, key: "profile" };
      renderer.render(document.body, [{ name: "Display refresh rate", control }]);

      const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(
        '[aria-label="Display refresh rate"]',
      )!;
      expect(input.value).toBe("auto");
      input.focus();
      input.value = "60";
      input.dispatchEvent(new Event(type === "dropdown" ? "change" : "input"));
      return vi.waitFor(() => {
        expect(setControlValue).toHaveBeenCalledExactlyOnceWith("profile", "60");
        renderer.dispose();
      });
    },
  );

  it("names toggles and persists their activation", () => {
    const setControlValue = vi.fn();
    const renderer = new SettingDefinitionRenderer(
      { getControlValue: () => false, setControlValue },
      vi.fn(),
    );
    const toggle: SettingDefinitionControl = {
      name: "Left-handed toolbar",
      control: { type: "toggle", key: "leftHandedToolbar" },
    };
    renderer.render(document.body, [toggle]);
    const input = document.querySelector<HTMLInputElement>('[aria-label="Left-handed toolbar"]')!;
    input.click();
    expect(setControlValue).toHaveBeenCalledExactlyOnceWith("leftHandedToolbar", true);
    expect(input.labels?.[0]?.hasAttribute("aria-label")).toBe(false);
    renderer.dispose();
  });

  it("names legacy host toggles on their exposed checkbox element", () => {
    const checkbox = document.body.createDiv();
    checkbox.setAttribute("role", "checkbox");
    nameSettingToggle(checkbox, "Finger drawing");
    expect(checkbox.getAttribute("aria-label")).toBe("Finger drawing");
  });
});
