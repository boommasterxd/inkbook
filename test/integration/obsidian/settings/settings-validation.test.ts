// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  control,
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

beforeAll(installObsidianDomHelpers);
afterEach(() => document.body.replaceChildren());

function pageDefault(store: InkbookSettingsStore, name: string) {
  const group = groups(createTab(store)).find((candidate) => candidate.heading === "Page defaults");
  if (group === undefined) throw new Error("Missing page defaults.");
  const view = renderDefinition(requiredRender(renders(group), name));
  document.body.append(view.container);
  return view;
}

it("preserves page-buffer focus and error descriptions through invalid input, failed saving and retry", async () => {
  const vault = new VaultAdapter();
  const store = new InkbookSettingsStore(vault, new DeviceAdapter());
  const view = pageDefault(store, "Page buffer");
  const field = requiredElement<HTMLInputElement>(view.container, 'input[type="number"]');
  const error = requiredElement<HTMLElement>(view.container, ".inkbook-settings-control-error");
  const original = field.value;
  field.focus();
  field.value = "9";
  field.dispatchEvent(new Event("change"));
  expect(field.value).toBe(original);
  expect(error.hidden).toBe(false);
  expect(error.textContent).toBe("Enter a valid setting value.");
  expect(error.getAttribute("aria-live")).toBe("polite");
  expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);

  vault.failure = new Error("Save failed");
  field.value = "6";
  field.dispatchEvent(new Event("change"));
  expect(error.hidden).toBe(true);
  await vi.waitFor(() => expect(error.textContent).toBe("The setting could not be saved."));
  expect(field.value).toBe(original);
  expect(requiredElement(view.container, 'input[type="number"]')).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(store.getVaultSettings().pageDefaults.activeBufferLines).toBe(Number(original));

  vault.failure = undefined;
  field.value = "5";
  field.dispatchEvent(new Event("change"));
  expect(error.hidden).toBe(true);
  expect(error.textContent).toBe("");
  await vi.waitFor(() => expect(store.getVaultSettings().pageDefaults.activeBufferLines).toBe(5));
  expect(document.activeElement).toBe(field);
  const rejectBufferDraft = (): void => {
    field.value = "9";
    field.dispatchEvent(new Event("change"));
    expect(error.hidden).toBe(false);
    expect(view.container.querySelector(".inkbook-settings-validation-visual")?.textContent).toBe(
      "Enter a valid setting value.",
    );
  };
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
  rejectBufferDraft();
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "full" }));
  field.value = "6";
  field.dispatchEvent(new Event("change"));
  expect(error.hidden).toBe(true);
  expect(view.container.querySelector(".inkbook-settings-validation-visual")).toBeNull();
  await vi.waitFor(() => expect(store.getVaultSettings().pageDefaults.activeBufferLines).toBe(6));
  rejectBufferDraft();
  expect(document.activeElement).toBe(field);
  view.cleanup();
});

it("uses restored table columns for the next stepper action and invalid-value recovery", async () => {
  const vault = new VaultAdapter();
  const store = new InkbookSettingsStore(vault, new DeviceAdapter());
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
  const view = renderExpandedTool(createTab(store), "Shapes and structures", "Table");
  const columns = control(view.container, "table-columns");
  const field = requiredElement<HTMLInputElement>(columns, 'input[type="number"]');
  const increment = requiredElement<HTMLButtonElement>(
    columns,
    'button[aria-label="Increase Columns"]',
  );
  const error = requiredElement<HTMLElement>(columns, ".inkbook-settings-control-error");
  vault.failure = new Error("Save failed");
  increment.click();
  await vi.waitFor(() => expect(error.textContent).toBe("The setting could not be saved."));
  expect(field.value).toBe("2");
  field.value = "25";
  field.dispatchEvent(new Event("change"));
  expect(field.value).toBe("2");
  expect(error.textContent).toBe("Enter a valid setting value.");

  vault.failure = undefined;
  increment.click();
  expect(field.value).toBe("3");
  expect(error.hidden).toBe(true);
  await vi.waitFor(() => expect(store.getVaultSettings().toolDefaults.table.columns).toBe(3));
  view.cleanup();
});

it("keeps the background spacing control focused through persistence rollback and recovery", async () => {
  const vault = new VaultAdapter();
  const store = new InkbookSettingsStore(vault, new DeviceAdapter());
  store.updateDeviceSettings((settings) => ({ ...settings, motion: "reduced" }));
  const view = pageDefault(store, "Background");
  const field = requiredElement<HTMLInputElement>(
    view.container,
    'input[aria-label="Background spacing"]',
  );
  const error = requiredElement<HTMLElement>(view.container, ".inkbook-settings-control-error");
  const original = field.value;
  field.focus();
  vault.failure = new Error("Save failed");
  field.value = "0";
  field.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(error.textContent).toBe("The background default could not be saved."),
  );
  expect(field.value).toBe(original);
  expect(requiredElement(view.container, 'input[aria-label="Background spacing"]')).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);

  vault.failure = undefined;
  field.value = "2";
  field.dispatchEvent(new Event("change"));
  expect(error.hidden).toBe(true);
  expect(document.activeElement).toBe(field);
  await vi.waitFor(() =>
    expect(store.getVaultSettings().pageDefaults.backgroundSpacing.squares).toBe(50),
  );
  view.cleanup();
});

it.each(["full", "reduced"] as const)(
  "restores a failed toggle visually with %s motion without saving twice and permits retry",
  async (motion) => {
    const vault = new VaultAdapter();
    const save = vi.spyOn(vault, "saveData");
    let rejectSave: ((error: Error) => void) | undefined;
    save.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const store = new InkbookSettingsStore(vault, new DeviceAdapter());
    store.updateDeviceSettings((settings) => ({ ...settings, motion }));
    const view = renderExpandedTool(createTab(store), "Drawing tools", "Pen");
    document.body.append(view.container);
    const pressure = control(view.container, "pressure-enabled");
    const input = requiredElement<HTMLInputElement>(pressure, 'input[type="checkbox"]');
    const track = requiredElement<HTMLElement>(pressure, ".inkbook-menu-switch-track");
    const thumb = requiredElement<HTMLElement>(pressure, ".inkbook-menu-switch-thumb");
    const error = requiredElement<HTMLElement>(pressure, ".inkbook-settings-control-error");
    expect(input.checked).toBe(true);
    input.focus();
    input.click();
    await vi.waitFor(() => expect(track.dataset.inkbookSwitchState).toBe("unchecked"));
    expect(input.checked).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    rejectSave?.(new Error("Save failed"));
    await vi.waitFor(() => expect(error.textContent).toBe("The setting could not be saved."));
    const feedback = requiredElement<HTMLElement>(pressure, ".inkbook-settings-validation-visual");
    for (const animation of feedback.getAnimations({ subtree: true })) animation.finish();
    expect(window.getComputedStyle(feedback).opacity).not.toBe("0");
    expect(input.checked).toBe(true);
    expect(store.getVaultSettings().toolDefaults.pen.pressureEnabled).toBe(true);
    await vi.waitFor(() => {
      expect(track.dataset.inkbookSwitchState).toBe("checked");
      expect(track.style.backgroundColor).toBe("");
      expect(thumb.style.translate).toBe("");
    });
    expect(document.activeElement).toBe(input);
    expect(requiredElement(pressure, 'input[type="checkbox"]')).toBe(input);
    expect(save).toHaveBeenCalledOnce();
    input.click();
    await vi.waitFor(() => {
      expect(store.getVaultSettings().toolDefaults.pen.pressureEnabled).toBe(false);
      expect(track.dataset.inkbookSwitchState).toBe("unchecked");
    });
    expect(error.hidden).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(save).toHaveBeenCalledTimes(2);
    view.cleanup();
  },
);
