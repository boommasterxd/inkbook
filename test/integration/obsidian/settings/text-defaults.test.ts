// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { createBuiltInSettings } from "../../../../src/domain/settings";
import { createToolStyleControls } from "../../../../src/obsidian/menus/tool-style-controls";
import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";
import {
  control,
  setupSettingsDom,
  createTab,
  DeviceAdapter,
  groups,
  renderDefinition,
  renderExpandedTool,
  requiredElement,
  requiredRender,
  renders,
  VaultAdapter,
} from "./setting-tab-fixture";

setupSettingsDom();

function controlState(element: ParentNode) {
  return {
    toggles: [
      ...element.querySelectorAll<HTMLButtonElement>("button[aria-pressed]:not([data-value])"),
    ].map((button) => ({
      label: button.getAttribute("aria-label"),
      pressed: button.getAttribute("aria-pressed"),
    })),
    fontOptions: [...element.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => ({
      value: option.dataset.value,
      selected: option.getAttribute("aria-selected"),
      label: option.getAttribute("aria-label"),
    })),
    buttons: [...element.querySelectorAll<HTMLButtonElement>("button[data-value]")].map(
      (button) => ({
        value: button.dataset.value,
        pressed: button.getAttribute("aria-pressed"),
        label: button.getAttribute("aria-label"),
      }),
    ),
    inputs: [...element.querySelectorAll<HTMLInputElement>("input")].map((input) => ({
      type: input.type,
      value: input.value,
      checked: input.checked,
      step: input.step,
    })),
  };
}

function chooseFont(field: HTMLElement, value: string): void {
  const trigger = requiredElement<HTMLButtonElement>(field, '[role="combobox"]');
  trigger.click();
  const list = field.ownerDocument.getElementById(trigger.getAttribute("aria-controls")!)!;
  requiredElement<HTMLElement>(list, `[role="option"][data-value="${value}"]`).click();
}

it("reuses every Text Style control and persists every matching vault default through the rendered settings", async () => {
  const vault = new VaultAdapter();
  const store = new InkbookSettingsStore(vault, new DeviceAdapter());
  const tab = createTab(store);
  const view = renderExpandedTool(tab, "Drawing tools", "Text");
  document.body.append(view.container);
  try {
    const controls = createToolStyleControls(store.getVaultSettings().toolDefaults, "text");
    const menu = createStyleMenuContent({
      workScheduler: new ManualFrameScheduler(),
      controls,
      ownerDocument: document,
      onChange: () => undefined,
      renderIcon: () => undefined,
    });
    expect(
      [...view.container.querySelectorAll<HTMLElement>("[data-control]")].map(
        ({ dataset }) => dataset.control,
      ),
    ).toEqual([...controls.map(({ id }) => id), "copy-text-fields-as-text"]);
    for (const model of controls) {
      const menuControl = menu.querySelector(`[data-control="${model.id}"]`)!;
      expect(controlState(control(view.container, model.id))).toEqual(controlState(menuControl));
    }
    expect(menu.querySelector('[data-control="copy-text-fields-as-text"]')).toBeNull();
    requiredElement<HTMLInputElement>(
      control(view.container, "copy-text-fields-as-text"),
      'input[type="checkbox"]',
    ).click();
    await vi.waitFor(() => expect(store.getVaultSettings().copyTextFieldsAsText).toBe(true));
    const changes = [
      ["text-font-family", "fontFamily", "source-serif"],
      ["text-font-size", "fontSize", 31.375],
      ["color", "color", "#EF4444FF"],
      ["opacity", "opacity", 0.25],
      ["text-bold", "bold", true],
      ["text-italic", "italic", true],
      ["text-underline", "underline", true],
      ["text-strikethrough", "strikethrough", true],
      ["text-alignment", "alignment", "justify"],
      ["text-background-color", "backgroundColor", "#3B82F6FF"],
      ["text-background-opacity", "backgroundOpacity", 0.75],
    ] as const;
    for (const [id, key, value] of changes) {
      const field = control(view.container, id);
      if (typeof value === "boolean") {
        requiredElement<HTMLButtonElement>(field, 'button[aria-pressed="false"]').click();
      } else if (typeof value === "number") {
        const input = requiredElement<HTMLInputElement>(field, 'input[type="number"]');
        input.value = String(id.includes("opacity") ? value * 100 : value);
        input.dispatchEvent(new Event("change"));
      } else if (id === "text-font-family") {
        chooseFont(field, value);
      } else requiredElement<HTMLButtonElement>(field, `button[data-value="${value}"]`).click();
      await vi.waitFor(() =>
        expect(tab.getControlValue(`toolDefaults.text.${key}`)).toEqual(value),
      );
    }
    expect(vault.saves).toBe(changes.length + 1);
    expect(vault.value.toolDefaults.text).toEqual({
      fontFamily: "source-serif",
      fontSize: 31.375,
      color: { type: "rgba", value: "#EF4444FF" },
      opacity: 0.25,
      bold: true,
      italic: true,
      underline: true,
      strikethrough: true,
      alignment: "justify",
      backgroundColor: { type: "rgba", value: "#3B82F6FF" },
      backgroundOpacity: 0.75,
    });
    const drawing = groups(tab).find(({ heading }) => heading === "Drawing tools")!;
    const reset = renderDefinition(requiredRender(renders(drawing), "Reset group to defaults"));
    reset.container.click();
    reset.cleanup();
    await vi.waitFor(() =>
      expect(store.getVaultSettings().toolDefaults.text).toEqual(
        createBuiltInSettings().toolDefaults.text,
      ),
    );
  } finally {
    view.cleanup();
  }
});

it("offers Text as a localized startup tool and preserves fractional font values after saving fails", async () => {
  const vault = new VaultAdapter();
  const store = new InkbookSettingsStore(vault, new DeviceAdapter());
  const tab = createTab(store);
  const general = groups(tab).find(({ heading }) => heading === undefined)!;
  const startup = general.items?.find(
    (item) => "control" in item && item.control?.key === "startupTool",
  );
  expect(startup).toMatchObject({ control: { options: { text: "Text" } } });
  await tab.setControlValue("startupTool", "text");
  await tab.setControlValue("toolDefaults.text.fontSize", "512.375");
  expect(vault.value.startupTool).toBe("text");
  const view = renderExpandedTool(tab, "Drawing tools", "Text");
  try {
    const field = control(view.container, "text-font-size");
    const input = requiredElement<HTMLInputElement>(field, 'input[type="number"]');
    const slider = requiredElement<HTMLInputElement>(field, 'input[type="range"]');
    expect(input.value).toBe("512.375");
    expect(slider.value).toBe("100");
    expect(slider.min).toBe("1");
    expect(slider.max).toBe("100");
    vault.failure = new Error("Save failed");
    input.value = "30.125";
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(field.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
        "The setting could not be saved.",
      ),
    );
    expect(input.value).toBe("512.375");
    expect(slider.value).toBe("100");
    expect(vault.value.toolDefaults.text.fontSize).toBe(512.375);
    const boldField = control(view.container, "text-bold");
    const bold = requiredElement<HTMLButtonElement>(boldField, "button[aria-pressed]");
    bold.click();
    await vi.waitFor(() =>
      expect(boldField.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
        "The setting could not be saved.",
      ),
    );
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    expect(vault.value.toolDefaults.text.bold).toBe(false);
    const family = control(view.container, "text-font-family");
    const dropdown = requiredElement<HTMLButtonElement>(family, '[role="combobox"]');
    chooseFont(family, "source-serif");
    await vi.waitFor(() =>
      expect(family.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
        "The setting could not be saved.",
      ),
    );
    expect(dropdown.title).toBe("Inter");
    expect(
      family.querySelector('[data-value="inter"][role="option"]')?.getAttribute("aria-selected"),
    ).toBe("true");
  } finally {
    view.cleanup();
  }
});
