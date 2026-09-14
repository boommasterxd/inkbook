// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  navigateOwnedMenu,
  OwnedMenuItem,
  renderOwnedMenuItems,
} from "../../../../src/obsidian/menus/owned-menu-item";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(items: readonly (OwnedMenuItem | null)[]) {
  const container = createDiv();
  document.body.append(container);
  const activate = vi.fn();
  const buttons = renderOwnedMenuItems(container, items, activate);
  return { container, activate, buttons };
}

describe("owned menu items", () => {
  it("preserves fragment titles without consuming them and renders plain titles as text", () => {
    const fragment = createFragment();
    const strong = createEl("strong");
    strong.textContent = "Rich title";
    fragment.append(strong);
    const { container } = render([
      new OwnedMenuItem().setTitle("<b>Plain title</b>"),
      new OwnedMenuItem().setTitleFragment(fragment),
    ]);
    expect(container.textContent).toBe("<b>Plain title</b>Rich title");
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("Rich title");
    expect(fragment.firstChild).toBe(strong);
  });

  it("exposes checked, disabled and label states and excludes inert rows from activation", () => {
    const checked = new OwnedMenuItem()
      .setTitle("Selected")
      .setChecked(true)
      .setIcon("check")
      .setWarning(true);
    const disabled = new OwnedMenuItem()
      .setTitle("Unavailable")
      .setChecked(false)
      .setDisabled(true);
    const label = new OwnedMenuItem().setTitle("Group").setIsLabel(true);
    const { container, activate, buttons } = render([checked, disabled, label]);
    expect(buttons).toHaveLength(1);
    expect(container.querySelector('[aria-checked="true"]')?.getAttribute("role")).toBe(
      "menuitemcheckbox",
    );
    expect(container.querySelector('[aria-checked="false"]')?.getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(container.querySelector('[data-label="true"]')?.getAttribute("role")).toBe(
      "presentation",
    );
    expect(container.querySelector('[data-warning="true"]')).not.toBeNull();
    for (const row of container.querySelectorAll<HTMLElement>(".inkbook-owned-menu-item"))
      row.click();
    expect(activate).toHaveBeenCalledExactlyOnceWith(checked, expect.any(Event));
  });

  it("does not render leading, repeated or trailing separators", () => {
    const { container } = render([
      null,
      null,
      new OwnedMenuItem().setTitle("One"),
      null,
      null,
      new OwnedMenuItem().setTitle("Two"),
      null,
    ]);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(container.firstElementChild?.textContent).toBe("One");
    expect(container.lastElementChild?.textContent).toBe("Two");
  });

  it("supports wrapping arrow navigation, Home, End, Enter and Space across enabled rows", () => {
    const { buttons } = render([
      new OwnedMenuItem().setTitle("One"),
      new OwnedMenuItem().setDisabled(true),
      new OwnedMenuItem().setTitle("Two"),
    ]);
    const activate = vi.fn();
    const key = (value: string) =>
      navigateOwnedMenu(new KeyboardEvent("keydown", { key: value }), buttons, activate);
    expect(key("ArrowUp")).toBe(true);
    expect(document.activeElement).toBe(buttons[1]);
    key("ArrowDown");
    expect(document.activeElement).toBe(buttons[0]);
    key("End");
    expect(document.activeElement).toBe(buttons[1]);
    key("Home");
    expect(document.activeElement).toBe(buttons[0]);
    key("Enter");
    key(" ");
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenLastCalledWith(buttons[0]);
    expect(key("Shift")).toBe(false);
  });

  it("focuses on mouse hover without stealing focus during touch dragging", () => {
    const { buttons } = render([new OwnedMenuItem().setTitle("Hover")]);
    const button = buttons[0]!;
    button.dispatchEvent(new PointerEvent("pointermove", { pointerType: "touch" }));
    expect(document.activeElement).not.toBe(button);
    button.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse" }));
    expect(document.activeElement).toBe(button);
  });

  it("handles empty menus and activation without a selected row", () => {
    const activate = vi.fn();
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "]) {
      expect(navigateOwnedMenu(new KeyboardEvent("keydown", { key }), [], activate)).toBe(true);
    }
    expect(activate).not.toHaveBeenCalled();
  });
});
