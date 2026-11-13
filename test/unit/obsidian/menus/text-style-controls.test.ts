import { layoutTextElement } from "../../../fixtures/editor/text-style";
// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { Localization } from "../../../../src/domain/localization";
import { summarizeSelectionStyle } from "../../../../src/editor/tools/style-summary";
import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { createTextStyleControls } from "../../../../src/obsidian/menus/text-style-controls";
import { createToolStyleControls } from "../../../../src/obsidian/menus/tool-style-controls";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { textElement } from "../../domain/schema/fixtures";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";

beforeEach(installObsidianDomHelpers);

it("toggles mixed text flags independently and reversibly through the shared icon row", async () => {
  const text = await layoutTextElement({
    ...textElement(),
    ranges: [{ start: 0, end: 2, style: { bold: true } }],
  });
  const summary = summarizeSelectionStyle([text]);
  if (summary?.kind !== "text") throw new Error("Missing text summary");
  const onChange = vi.fn();
  const view = createStyleMenuContent({
    workScheduler: new ManualFrameScheduler(),
    controls: createTextStyleControls(summary),
    ownerDocument: document,
    onChange,
    renderIcon: () => undefined,
  });
  const bold = view.querySelector<HTMLButtonElement>('[data-control="text-bold"] button')!;
  const italic = view.querySelector<HTMLButtonElement>('[data-control="text-italic"] button')!;
  const row = bold.closest(".inkbook-menu-choice-grid")!;
  expect(row.querySelectorAll("button")).toHaveLength(4);
  expect(italic.closest(".inkbook-menu-choice-grid")).toBe(row);
  expect(bold.getAttribute("aria-pressed")).toBe("mixed");
  bold.click();
  expect(bold.getAttribute("aria-pressed")).toBe("true");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("text-bold", true);
  italic.click();
  expect(bold.getAttribute("aria-pressed")).toBe("true");
  expect(italic.getAttribute("aria-pressed")).toBe("true");
  bold.click();
  expect(bold.getAttribute("aria-pressed")).toBe("false");
  expect(italic.getAttribute("aria-pressed")).toBe("true");
  expect(onChange).toHaveBeenLastCalledWith("text-bold", false);
});

it("keeps fractional slider values independent of their rounded display", () => {
  const { slider, value, onChange, onPreview } = fontSizeView(23.125);
  expect(slider.min).toBe("1");
  expect(slider.max).toBe("100");
  expect(slider.step).toBe("any");
  expect(slider.value).toBe("23.125");
  expect(value.value).toBe("23");
  slider.value = "27.625";
  slider.dispatchEvent(new Event("input"));
  expect(value.value).toBe("28");
  expect(onChange).not.toHaveBeenCalled();
  expect(onPreview).toHaveBeenCalledExactlyOnceWith("text-font-size", 27.625);
  slider.dispatchEvent(new Event("change"));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("text-font-size", 27.625);
  value.value = "31.375";
  value.dispatchEvent(new Event("input"));
  expect(slider.value).toBe("31.375");
  expect(onPreview).toHaveBeenLastCalledWith("text-font-size", 31.375);
  value.dispatchEvent(new Event("change"));
  expect(onChange).toHaveBeenLastCalledWith("text-font-size", 31.375);
  value.value = "";
  value.dispatchEvent(new Event("change"));
  expect(value.value).toBe("31");
  expect(slider.value).toBe("31.375");
  expect(onChange).toHaveBeenCalledTimes(2);
});

it.each([512.375, 0.125])(
  "retains resized font size %s outside the slider without normalizing unrelated changes",
  (fontSize) => {
    const { view, defaults, slider, value, onChange, onPreview } = fontSizeView(fontSize, "reject");
    expect(value.value).toBe(String(fontSize));
    expect(slider.value).toBe(fontSize > 100 ? "100" : "1");
    expect(onChange).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalled();
    view.querySelector<HTMLButtonElement>('[data-control="text-bold"] button')!.click();
    value.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("text-bold", true);
    expect(defaults.text.fontSize).toBe(fontSize);
    value.value = "200";
    value.dispatchEvent(new Event("change"));
    expect(value.value).toBe(String(fontSize));
    expect(onChange).toHaveBeenCalledTimes(1);
    value.value = "50.125";
    value.dispatchEvent(new Event("input"));
    expect(onPreview).toHaveBeenCalledExactlyOnceWith("text-font-size", 50.125);
    value.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith("text-font-size", 50.125);
  },
);

function fontSizeView(fontSize: number, numberInputMode: "clamp" | "reject" = "clamp") {
  const defaults = createBuiltInSettings().toolDefaults;
  defaults.text.fontSize = fontSize;
  const onChange = vi.fn();
  const onPreview = vi.fn();
  const view = createStyleMenuContent({
    workScheduler: new ManualFrameScheduler(),
    controls: createToolStyleControls(defaults, "text"),
    ownerDocument: document,
    onChange,
    onPreview,
    numberInputMode,
    renderIcon: () => undefined,
  });
  const field = view.querySelector('[data-control="text-font-size"]')!;
  return {
    view,
    defaults,
    onChange,
    onPreview,
    slider: field.querySelector<HTMLInputElement>('input[type="range"]')!,
    value: field.querySelector<HTMLInputElement>('input[type="number"]')!,
  };
}

it("finishes a slider number draft with Enter while preserving IME composition and handled keys", () => {
  const { value } = fontSizeView(24);
  document.body.append(value);
  try {
    value.focus();
    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      cancelable: true,
    });
    value.dispatchEvent(composing);
    expect(document.activeElement).toBe(value);
    const handled = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    handled.preventDefault();
    value.dispatchEvent(handled);
    expect(document.activeElement).toBe(value);
    const commit = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    value.dispatchEvent(commit);
    expect(commit.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(value);
    expect(value.isConnected).toBe(true);
  } finally {
    value.remove();
  }
});

it("offers all configurable defaults, justify and caller fonts with German labels", () => {
  const defaults = createBuiltInSettings().toolDefaults;
  const customFonts = [{ label: "Custom", value: "custom-font" }];
  const controls = createToolStyleControls(defaults, "text", new Localization("de").t, customFonts);
  expect(controls.map(({ id }) => id)).toEqual([
    "color",
    "opacity",
    "text-font-family",
    "text-font-size",
    "text-bold",
    "text-italic",
    "text-underline",
    "text-strikethrough",
    "text-alignment",
    "text-background-color",
    "text-background-opacity",
  ]);
  expect(controls.find(({ id }) => id === "text-font-family")).toMatchObject({
    label: "Schriftart",
    options: customFonts,
  });
  const alignment = controls.find(({ id }) => id === "text-alignment");
  if (alignment?.kind !== "choice") throw new Error("Missing alignment choices");
  expect(alignment.options).toContainEqual({ label: "Blocksatz", value: "justify" });
});
