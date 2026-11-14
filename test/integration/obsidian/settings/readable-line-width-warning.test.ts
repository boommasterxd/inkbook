// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { SettingGroup, SettingTab } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as actionDialog from "../../../../src/obsidian/dialogs/action-dialog";
import type { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { SettingDefinitionRenderer } from "../../../../src/obsidian/settings/setting-definition-renderer";
import {
  createTestSettingsStore,
  openTestSettingsModal,
} from "../../../fixtures/obsidian/settings-store";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { mockSettingsScrollOwner } from "../../../fixtures/obsidian/settings-scroll";

const controllers: InkbookSettingsModalController[] = [];
const renderers: SettingDefinitionRenderer[] = [];
const releases: Array<() => void> = [];

beforeEach(() => {
  vi.restoreAllMocks();
  installObsidianDomHelpers();
  document.body.replaceChildren();
  mockSettingsScrollOwner(".inkbook-settings-modal-body");
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
  for (const release of releases.splice(0)) release();
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.restoreAllMocks();
});

function mount(width: unknown = true, store = createTestSettingsStore()) {
  let current = width;
  const read = vi.spyOn(SettingTab.prototype, "getControlValue").mockImplementation(() => current);
  const write = vi
    .spyOn(SettingTab.prototype, "setControlValue")
    .mockImplementation((_key, value) => {
      current = value;
    });
  const state = openTestSettingsModal(store, "reduced");
  controllers.push(state.controller);
  return { ...state, read, write };
}

function action(name: string, scope: ParentNode = document): HTMLButtonElement {
  const result = scope.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!result) throw new Error(`Missing ${name} action.`);
  return result;
}

function warning(): HTMLElement | null {
  return document.querySelector(".inkbook-width-warning");
}

function renderNative(
  state: ReturnType<typeof mount>,
  definitions = state.tab.getSettingDefinitions(),
) {
  const native = new SettingDefinitionRenderer(state.tab, () => undefined);
  renderers.push(native);
  document.body.append(state.tab.containerEl);
  native.render(state.tab.containerEl, definitions);
  return native;
}

it("uses the same detected-width warning in native definitions and owned settings", () => {
  const state = mount();
  const definitions = state.tab.getControlDefinitions();
  expect(definitions[0]).toMatchObject({ cls: "inkbook-width-warning-group" });
  expect(definitions[1]).toMatchObject({ settingsIdentity: "settings-group:0" });
  renderNative(state);
  expect(document.querySelectorAll(".inkbook-width-warning")).toHaveLength(2);
  expect(action("Use full width", state.tab.containerEl)).toBeDefined();
  expect(state.read).toHaveBeenCalledWith("readableLineLength");
  expect(state.write).not.toHaveBeenCalled();
});

it("re-evaluates cached native definitions after another Obsidian tab changes the note width", () => {
  const state = mount(false);
  const cached = state.tab.getSettingDefinitions();
  const native = renderNative(state, cached);
  expect(warning()).toBeNull();
  state.read.mockReturnValue(true);
  native.render(state.tab.containerEl, cached);
  expect(warning()).not.toBeNull();
  state.read.mockReturnValue(false);
  native.render(state.tab.containerEl, cached);
  expect(warning()).toBeNull();
});

it.each([false, "true"])(
  "omits the warning unless the core setting is exactly true (%s)",
  (width) => {
    mount(width);
    expect(warning()).toBeNull();
  },
);

it("omits the warning when core preferences are unavailable", () => {
  const state = mount();
  state.read.mockImplementation(() => {
    throw new Error("Unsupported core setting");
  });
  state.tab.update();
  expect(warning()).toBeNull();
  expect(state.write).not.toHaveBeenCalled();
});

it("sets the core width through the public base API and retains usable focus after closing", async () => {
  const state = mount();
  const button = action("Use full width");
  const write = state.write.getMockImplementation()!;
  state.write.mockImplementation((...values) => {
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Startup tool");
    return write(...values);
  });
  button.focus();
  button.click();
  await vi.waitFor(() => expect(warning()).toBeNull());
  expect(state.write).toHaveBeenCalledExactlyOnceWith("readableLineLength", false);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Startup tool");
  expect(state.tab.getControlDefinitions()[1]).toMatchObject({
    settingsIdentity: "settings-group:0",
  });
  expect(state.store.getDeviceSettings().readableLineWidthWarningDismissed).toBe(false);
});

it("dismisses only for the current plugin lifetime and keeps the core width unchanged", async () => {
  const state = mount();
  action("Hide until Inkbook restarts").click();
  await vi.waitFor(() => expect(warning()).toBeNull());
  state.controller.open("settings");
  expect(warning()).toBeNull();
  expect(state.store.getDeviceSettings().readableLineWidthWarningDismissed).toBe(false);
  expect(state.write).not.toHaveBeenCalled();
  state.controller.dispose();
  const restarted = openTestSettingsModal(state.store, "reduced");
  controllers.push(restarted.controller);
  expect(warning()).not.toBeNull();
});

it("persists permanent dismissal, preserves it on group resets and clears it on the global reset", async () => {
  const state = mount();
  action("Always hide this warning").click();
  await vi.waitFor(() => expect(warning()).toBeNull());
  expect(state.store.getDeviceSettings().readableLineWidthWarningDismissed).toBe(true);
  for (const group of ["general", "appearance"]) {
    document
      .querySelector<HTMLElement>(`.inkbook-settings-${group}-group [role="button"]`)!
      .click();
    await vi.waitFor(() =>
      expect(state.store.getDeviceSettings().readableLineWidthWarningDismissed).toBe(true),
    );
  }
  state.controller.open("settings");
  expect(warning()).toBeNull();
  vi.spyOn(actionDialog, "confirmInkbookAction").mockResolvedValue(true);
  document.querySelector<HTMLElement>('[data-setting-name="Reset all Inkbook settings"]')!.click();
  await vi.waitFor(() => expect(warning()).not.toBeNull());
  expect(state.store.getDeviceSettings().readableLineWidthWarningDismissed).toBe(false);
  expect(state.write).not.toHaveBeenCalled();
});

it("clears a session dismissal on the global reset", async () => {
  const state = mount();
  action("Hide until Inkbook restarts").click();
  await vi.waitFor(() => expect(warning()).toBeNull());
  vi.spyOn(actionDialog, "confirmInkbookAction").mockResolvedValue(true);
  document.querySelector<HTMLElement>('[data-setting-name="Reset all Inkbook settings"]')!.click();
  await vi.waitFor(() => expect(warning()).not.toBeNull());
  expect(state.write).not.toHaveBeenCalled();
});

it("keeps a failed core change visible with an accessible error and supports retry", async () => {
  const state = mount();
  state.write.mockRejectedValueOnce(new Error("Core preference unavailable"));
  const first = action("Use full width");
  first.focus();
  first.click();
  await vi.waitFor(() =>
    expect(warning()?.textContent).toContain("The note width could not be changed"),
  );
  const retry = action("Use full width");
  expect(retry.disabled).toBe(false);
  expect(document.activeElement).toBe(retry);
  const error = document.getElementById(retry.getAttribute("aria-describedby") ?? "");
  expect(error?.getAttribute("aria-live")).toBe("polite");
  retry.click();
  await vi.waitFor(() => expect(warning()).toBeNull());
  expect(state.write).toHaveBeenCalledTimes(2);
});

it("does not return focus to a failed action after the user moves to another setting", async () => {
  const state = mount();
  let reject!: (error: Error) => void;
  state.write.mockImplementation(() => new Promise<void>((_resolve, fail) => (reject = fail)));
  const button = action("Use full width");
  button.focus();
  button.click();
  const other = document.querySelector<HTMLElement>('[aria-label="Left-handed toolbar"]')!;
  other.focus();
  reject(new Error("Core write failed"));
  await vi.waitFor(() =>
    expect(warning()?.textContent).toContain("The note width could not be changed"),
  );
  expect(document.activeElement).toBe(other);
});

it("does not hide the warning when permanent dismissal could not be stored", async () => {
  const state = mount();
  vi.spyOn(state.store, "updateDeviceSettings").mockImplementationOnce(() => {
    throw new Error("Local storage unavailable");
  });
  action("Always hide this warning").click();
  await vi.waitFor(() =>
    expect(warning()?.textContent).toContain("The setting could not be saved"),
  );
  expect(state.store.getDeviceSettings().readableLineWidthWarningDismissed).toBe(false);
  expect(action("Always hide this warning").disabled).toBe(false);
  expect(state.write).not.toHaveBeenCalled();
});

it("ignores detached controls and late completion after their settings surface was closed", async () => {
  const state = mount();
  let finish!: () => void;
  state.write.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  const button = action("Use full width");
  button.click();
  state.controller.dispose();
  state.read.mockReturnValue(false);
  const next = document.body.createEl("button", { text: "Next action" });
  next.focus();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  button.click();
  expect(state.write).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(next);
  expect(warning()).toBeNull();
});

it("removes the entire owned animated footprint when the settings surface is disposed", () => {
  const state = mount();
  const native = renderNative(state);
  const row = state.tab.containerEl.querySelector<HTMLElement>(".inkbook-width-warning")!;
  const list = row.parentElement;
  expect(state.tab.containerEl.querySelector(".inkbook-width-warning-footprint")).not.toBeNull();
  native.dispose();
  expect(state.tab.containerEl.querySelector(".inkbook-width-warning-footprint")).toBeNull();
  expect(row.parentElement).toBe(list);
});

it("keeps a host row appended after its render callback inside the public animated list", async () => {
  const state = mount();
  const group = new SettingGroup(document.body);
  group.addClass("inkbook-width-warning-group");
  const definition = state.tab.getSettingDefinitions()[0];
  const item = definition && "items" in definition ? definition.items?.[0] : undefined;
  if (!item || !("render" in item) || !item.render) throw new Error("Missing width warning");
  group.addSetting((setting) => {
    const release = item.render(setting, group);
    if (release) releases.push(release);
    group.listEl.append(setting.settingEl);
  });
  expect(group.listEl.closest(".inkbook-settings-motion-content")).not.toBeNull();
  action("Hide until Inkbook restarts", group.listEl).click();
  await vi.waitFor(() => expect(group.listEl.hidden).toBe(true));
  expect(group.listEl.inert).toBe(true);
});
