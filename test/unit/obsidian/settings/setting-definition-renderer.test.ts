// @vitest-environment happy-dom

import type { SettingDefinitionControl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingDefinitionRenderer } from "../../../../src/obsidian/settings/setting-definition-renderer";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
});

describe("settings control layout ownership", () => {
  it.each(["dropdown", "text", "folder"] as const)(
    "exposes separate information and full-width %s controls for phone layout",
    (type) => {
      const renderer = createRenderer();
      const control =
        type === "dropdown"
          ? { type, key: "profile", options: { auto: "Automatic" } }
          : { type, key: "profile" };
      renderer.render(document.body, [{ name: "Display refresh rate", control }]);

      const row = document.body.querySelector(".inkbook-setting-stacked-control");
      const info = row?.querySelector(".inkbook-setting-info");
      const controls = row?.querySelector(".inkbook-setting-controls");
      expect(info).not.toBeNull();
      expect(controls).not.toBeNull();
      expect(info?.querySelector("input, select")).toBeNull();
      expect(controls?.querySelector<HTMLInputElement>("input, select")?.value).toBe("auto");
      renderer.dispose();
    },
  );

  it("keeps toggles inline and leaves custom content layout to its renderer", () => {
    const renderer = createRenderer();
    const custom = vi.fn();
    const toggle: SettingDefinitionControl = {
      name: "Left-handed toolbar",
      control: { type: "toggle", key: "leftHandedToolbar" },
    };
    renderer.render(document.body, [toggle, { name: "Tool style", render: custom }]);

    expect(document.querySelector(".inkbook-setting-stacked-control")).toBeNull();
    expect(document.querySelectorAll(".inkbook-setting-control-row")).toHaveLength(1);
    expect(
      document.querySelector('.inkbook-setting-controls input[type="checkbox"]'),
    ).not.toBeNull();
    expect(custom).toHaveBeenCalledOnce();
    renderer.dispose();
  });
});

function createRenderer(): SettingDefinitionRenderer {
  return new SettingDefinitionRenderer(
    { getControlValue: () => "auto", setControlValue: vi.fn() },
    vi.fn(),
  );
}
