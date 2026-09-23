// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { createStructuralStyleControls } from "../../../../src/obsidian/menus/structural-style-controls";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);
afterEach(() => document.body.replaceChildren());

function render(value: number | null = 2, numberInputMode: "clamp" | "reject" = "clamp") {
  const onChange = vi.fn();
  const onInvalidValue = vi.fn();
  const content = createStyleMenuContent({
    controls: createStructuralStyleControls({ tableColumns: value }),
    numberInputMode,
    onChange,
    onInvalidValue,
    ownerDocument: document,
    renderIcon: () => undefined,
  });
  const input = content.querySelector<HTMLInputElement>('input[type="number"]')!;
  const buttons = content.querySelectorAll<HTMLButtonElement>("button");
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input"));
  };
  const commit = () => input.dispatchEvent(new Event("change"));
  return { input, buttons, type, commit, onChange, onInvalidValue };
}

describe("editable table column count", () => {
  it("finishes keyboard editing with Enter while preserving the control", () => {
    const view = render();
    document.body.append(view.input);
    view.input.focus();
    view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(document.activeElement).toBe(view.input);
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    view.input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(view.input);
    expect(view.input.isConnected).toBe(true);
  });

  it("commits a typed value once and keeps both stepper buttons synchronized", () => {
    const view = render();
    expect(view.input.getAttribute("aria-label")).toBe("Columns");
    expect(view.input.inputMode).toBe("numeric");
    expect([view.input.min, view.input.max, view.input.step]).toEqual(["1", "12", "1"]);
    view.type("8");
    expect(view.onChange).not.toHaveBeenCalled();
    view.commit();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith("table-columns", 8);
    view.buttons[1]!.click();
    expect(view.input.value).toBe("9");
    view.buttons[0]!.click();
    expect(view.input.value).toBe("8");
    expect(view.onChange.mock.calls).toEqual([
      ["table-columns", 8],
      ["table-columns", 9],
      ["table-columns", 8],
    ]);
  });

  it.each([
    ["0", 1],
    ["99", 12],
    ["3.6", 4],
  ])("normalizes %s to a valid whole column count", (text, expected) => {
    const view = render();
    view.type(text);
    view.commit();
    expect(view.input.value).toBe(String(expected));
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith("table-columns", expected);
  });

  it.each([2, null])("restores the previous value after an empty draft: %s", (value) => {
    const view = render(value);
    view.type("");
    view.commit();
    expect(view.input.value).toBe(value === null ? "" : "2");
    expect(view.input.placeholder).toBe(value === null ? "—" : "");
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.onInvalidValue).toHaveBeenCalledExactlyOnceWith("table-columns");
  });

  it("rejects out-of-range settings input without changing the committed count", () => {
    const view = render(4, "reject");
    view.type("13");
    view.commit();
    expect(view.input.value).toBe("4");
    expect(view.onChange).not.toHaveBeenCalled();
    view.buttons[1]!.click();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith("table-columns", 5);
  });

  it("accepts a count for mixed tables and retains the button limits", () => {
    const view = render(null);
    view.type("12");
    view.commit();
    view.buttons[1]!.click();
    expect(view.input.value).toBe("12");
    view.type("1");
    view.commit();
    view.buttons[0]!.click();
    expect(view.input.value).toBe("1");
  });
});
