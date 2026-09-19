// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { createToolStyleControls } from "../../../../src/obsidian/menus/tool-style-controls";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);

it("renders rounded style samples while preserving accessible choices and width samples", () => {
  const onChange = vi.fn();
  const content = createStyleMenuContent({
    controls: createToolStyleControls(createBuiltInSettings().toolDefaults, "line"),
    onChange,
    ownerDocument: document,
    renderIcon: () => undefined,
  });
  const styles = content.querySelector('[data-control="outline-style"]')!;
  for (const [style, dash] of [
    ["solid", null],
    ["dashed", "8 6"],
    ["dotted", "0 5"],
  ]) {
    const button = styles.querySelector<HTMLButtonElement>(`button[data-value='${style}']`)!;
    const svg = button.querySelector("svg");
    const path = svg?.querySelector("path");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(path?.getAttribute("stroke-linecap")).toBe("round");
    expect(path?.getAttribute("stroke-linejoin")).toBe("round");
    expect(path?.getAttribute("stroke-width")).toBe("2");
    expect(path?.getAttribute("stroke-dasharray")).toBe(dash);
    button.click();
    expect(onChange).toHaveBeenLastCalledWith("outline-style", style);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  }
  const widths = content.querySelector('[data-control="outline-width"]')!;
  expect(widths.querySelectorAll(".inkbook-menu-line-preview")).toHaveLength(5);
  expect(widths.querySelector("svg")).toBeNull();
});
