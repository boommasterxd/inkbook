// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { createToolStyleControls } from "../../../../src/obsidian/menus/tool-style-controls";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);

it("distinguishes accessible line-style samples and applies the chosen style", () => {
  const onChange = vi.fn();
  const content = createStyleMenuContent({
    controls: createToolStyleControls(createBuiltInSettings().toolDefaults, "line"),
    onChange,
    ownerDocument: document,
    renderIcon: () => undefined,
  });
  const styles = content.querySelector('[data-control="outline-style"]')!;
  for (const [style, label, dash] of [
    ["solid", "Solid", null],
    ["dashed", "Dashed", "8 6"],
    ["dotted", "Dotted", "0 5"],
  ]) {
    const button = styles.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!;
    const svg = button.querySelector("svg");
    const path = svg?.querySelector("path");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(path?.getAttribute("stroke-dasharray")).toBe(dash);
    button.click();
    expect(onChange).toHaveBeenLastCalledWith("outline-style", style);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  }
});
