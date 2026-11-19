// @vitest-environment happy-dom
import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";

import { Setting, SettingGroup, type App, type Plugin } from "obsidian";
import { expect, it, vi } from "vitest";
import { InkbookSettingTab } from "../../../src/obsidian/settings/setting-tab";
import { SettingsModalContent } from "../../../src/obsidian/settings/settings-modal-content";
import { renderSettingsControlContent } from "../../../src/obsidian/settings/settings-control-content";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { createTestSettingsStore } from "../../fixtures/obsidian/settings-store";
import { runInteractionFrames } from "../interaction-refresh-profile";
import { ShortcutSettingsView } from "../../../src/obsidian/settings/shortcuts/shortcut-view";
import { toolSectionDefinition } from "../../../src/obsidian/settings/definitions/tool-section";
import { Keymap, Scope } from "../../adapters/obsidian/keymap";

it("prepares shortcut rows once without hidden subscriptions or host reads and releases ownership", () => {
  installObsidianDomHelpers();
  const container = document.body.createDiv();
  const store = createTestSettingsStore();
  const originalSubscribe = store.subscribeDeviceSettings.bind(store);
  const releases: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  const subscribe = vi.spyOn(store, "subscribeDeviceSettings").mockImplementation((listener) => {
    const release = vi.fn(originalSubscribe(listener));
    releases.push(release);
    return release;
  });
  let key = "K";
  const readBindings = vi.fn(
    () => new Map([["inkbook:copy-embed", [{ key, modifiers: ["Mod"] }]]]),
  );
  const view = new ShortcutSettingsView(
    container,
    store,
    {
      pushScope: () => undefined,
      popScope: () => undefined,
    },
    { readBindings, findConflict: () => undefined },
    () => workSchedulerFromFrames(window),
  );
  const triggers = [
    ...container.querySelectorAll<HTMLButtonElement>(".inkbook-shortcut-section-trigger"),
  ];
  const canvas = triggers[0]!;
  const commands = triggers[3]!;
  try {
    expect(
      container.querySelectorAll(".inkbook-shortcut-row, .inkbook-shortcut-reference-row"),
    ).toHaveLength(0);
    expect(readBindings).not.toHaveBeenCalled();
    const subscriptions = subscribe.mock.calls.length;
    canvas.dispatchEvent(new Event("pointerenter"));
    const recorder = container.querySelector("[data-shortcut-action=copy]");
    expect(container.querySelectorAll(".inkbook-shortcut-row")).toHaveLength(10);
    expect(subscribe).toHaveBeenCalledTimes(subscriptions);
    expect(canvas.getAttribute("aria-expanded")).toBe("false");
    canvas.dispatchEvent(new Event("focus"));
    expect(container.querySelector("[data-shortcut-action=copy]")).toBe(recorder);
    canvas.click();
    expect(subscribe).toHaveBeenCalledTimes(subscriptions + 10);
    canvas.click();
    canvas.click();
    expect(subscribe).toHaveBeenCalledTimes(subscriptions + 10);
    expect(container.querySelector("[data-shortcut-action=copy]")).toBe(recorder);
    commands.dispatchEvent(new Event("pointerdown"));
    const rows = [...container.querySelectorAll(".inkbook-shortcut-reference-row")];
    expect(rows).toHaveLength(5);
    expect(readBindings).not.toHaveBeenCalled();
    commands.click();
    expect(readBindings).toHaveBeenCalledOnce();
    expect(rows[1]?.textContent).toContain("CtrlK");
    commands.click();
    key = "J";
    commands.click();
    expect(rows[1]?.textContent).toContain("CtrlJ");
    expect([...container.querySelectorAll(".inkbook-shortcut-reference-row")]).toEqual(rows);
    view.dispose();
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    subscribe.mockClear();
    readBindings.mockClear();
    canvas.dispatchEvent(new Event("pointerenter"));
    commands.click();
    expect(subscribe).not.toHaveBeenCalled();
    expect(readBindings).not.toHaveBeenCalled();
    expect(container.children).toHaveLength(0);
  } finally {
    view.dispose();
    container.remove();
    vi.restoreAllMocks();
  }
});

it("reuses intent-prepared text controls and activates font resources and document listeners only on opening", () => {
  installObsidianDomHelpers();
  const container = document.body.createDiv();
  const store = createTestSettingsStore();
  const releasePreview = vi.fn();
  const previews = { acquire: vi.fn(() => releasePreview), dispose: vi.fn() };
  const createFontPreviews = vi.fn(() => previews);
  const fontOptions = [
    { label: "Inter", value: "inter" },
    ...Array.from({ length: 128 }, (_, index) => ({
      label: `Custom font ${index}`,
      value: `custom-${index}`,
    })),
  ];
  const observeMotion = vi.fn(() => vi.fn());
  const keymap = new Keymap();
  const hostScope = new Scope();
  const hostEscape = vi.fn();
  hostScope.register([], "Escape", () => {
    hostEscape();
    return false;
  });
  keymap.pushScope(hostScope);
  const releaseCapture = keymap.installCapture(window);
  const definition = toolSectionDefinition(
    {
      name: "Text",
      description: "Text defaults",
      tool: "text",
      controlKeys: {},
      controlDescriptions: {},
    },
    {
      createFontPreviews,
      keymap,
      getDefaults: () => store.getVaultSettings().toolDefaults,
      getTextFontOptions: () => fontOptions,
      getMotion: () => "reduced",
      observeMotion,
      set: () => Promise.resolve(),
      workScheduler: () => workSchedulerFromFrames(window),
    },
  );
  const dispose = definition.render(new Setting(container), new SettingGroup(container));
  const trigger = container.querySelector<HTMLButtonElement>(".inkbook-settings-tool-trigger")!;
  const documentListeners = vi.spyOn(document, "addEventListener");
  const removeDocumentListener = vi.spyOn(document, "removeEventListener");
  const subscriptions = observeMotion.mock.calls.length;
  try {
    trigger.dispatchEvent(new Event("pointerenter"));
    const controls = container.querySelector(".inkbook-settings-tool-controls")!;
    const nodes = [...controls.querySelectorAll("*")];
    expect(nodes.length).toBeGreaterThan(0);
    expect(createFontPreviews).not.toHaveBeenCalled();
    expect(observeMotion).toHaveBeenCalledTimes(subscriptions);
    expect(
      documentListeners.mock.calls.filter(([type]) => type === "keydown" || type === "pointerdown"),
    ).toHaveLength(0);
    trigger.dispatchEvent(new Event("focus"));
    trigger.dispatchEvent(new Event("pointerdown"));
    expect([...controls.querySelectorAll("*")]).toEqual(nodes);
    trigger.click();
    expect(container.querySelector(".inkbook-settings-tool-controls")).toBe(controls);
    expect([...controls.querySelectorAll("*")]).toEqual(nodes);
    expect(createFontPreviews).toHaveBeenCalledOnce();
    expect(previews.acquire).toHaveBeenCalledOnce();
    const dropdown = controls.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    verifyFontOptionWork(controls, dropdown, fontOptions.length);
    expect(previews.acquire).toHaveBeenCalledOnce();
    dropdown.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(dropdown.getAttribute("aria-expanded")).toBe("false");
    expect(hostEscape).not.toHaveBeenCalled();
    dropdown.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(hostEscape).toHaveBeenCalledOnce();
    const activeSubscriptions = observeMotion.mock.calls.length;
    trigger.click();
    trigger.click();
    expect(observeMotion).toHaveBeenCalledTimes(activeSubscriptions);
    expect(previews.acquire).toHaveBeenCalledOnce();
    dispose?.();
    expect(releasePreview).toHaveBeenCalledOnce();
    expect(previews.dispose).toHaveBeenCalledOnce();
    for (const [type, listener, capture] of documentListeners.mock.calls.filter(
      ([type]) => type === "keydown" || type === "pointerdown",
    ))
      expect(removeDocumentListener).toHaveBeenCalledWith(type, listener, capture);
  } finally {
    releaseCapture();
    dispose?.();
    container.remove();
    vi.restoreAllMocks();
  }
});

function verifyFontOptionWork(
  container: Element,
  dropdown: HTMLButtonElement,
  count: number,
): void {
  const list = container.querySelector<HTMLElement>(".inkbook-font-dropdown-list")!;
  expect(list.childElementCount).toBe(0);
  dropdown.dispatchEvent(new Event("pointerenter"));
  const options = [...list.children];
  expect(options).toHaveLength(count);
  expect(dropdown.getAttribute("aria-expanded")).toBe("false");
  dropdown.dispatchEvent(new Event("focus"));
  dropdown.dispatchEvent(new Event("pointerdown"));
  expect([...list.children]).toEqual(options);
  dropdown.click();
  const observer = new MutationObserver(() => undefined);
  observer.observe(list, { subtree: true, attributeFilter: ["data-active"] });
  try {
    dropdown.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    const last = options[options.length - 1]!;
    expect(observer.takeRecords().map(({ target }) => target)).toEqual([options[0], last]);
    expect(dropdown.getAttribute("aria-activedescendant")).toBe(last.id);
  } finally {
    observer.disconnect();
  }
}

it("keeps unopened settings bounded and unrelated device changes without rebuilding controls", () => {
  installObsidianDomHelpers();
  const container = document.body.createDiv();
  const app = { workspace: { containerEl: container } } as unknown as App;
  const store = createTestSettingsStore();
  const content = new SettingsModalContent(container, {
    app,
    settingTab: new InkbookSettingTab(app, {} as Plugin, store, undefined, undefined, {
      workScheduler: () => workSchedulerFromFrames(window),
    }),
    store,
    view: "settings",
  });
  try {
    expect(
      container.querySelectorAll(".inkbook-settings-tool-controls [data-control]"),
    ).toHaveLength(0);
    // Bounds the real settings tree, including all still-collapsed tool and shortcut sections.
    expect(container.querySelectorAll("*").length).toBeLessThan(800);
    const shortcuts = container.querySelector<HTMLElement>(".inkbook-shortcuts-view");
    if (shortcuts === null) throw new Error("Missing shortcut view");
    const replace = vi.spyOn(shortcuts, "replaceChildren");
    const initialNodes = [...container.querySelectorAll("*")];
    const create = vi.spyOn(document, "createElementNS");
    runInteractionFrames((frame) => {
      store.updateDeviceSettings((settings) => ({
        ...settings,
        motion: frame % 2 === 0 ? "reduced" : "full",
      }));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("*")]).toEqual(initialNodes);
  } finally {
    content.dispose();
    container.remove();
    vi.restoreAllMocks();
  }
});

it("projects one changed validation message and skips geometry work for repeated invalid and valid input", async () => {
  installObsidianDomHelpers();
  const group = document.body.createDiv({ cls: "inkbook-settings-tool-group" });
  const row = group.createDiv({ cls: "setting-item" });
  const following = group.createDiv({ cls: "setting-item" });
  following.createEl("button", { text: "Reset tool" });
  let saveResult = Promise.resolve();
  const release = renderSettingsControlContent(row, {
    controls: () => [
      { id: "opacity", kind: "number", label: "Opacity", min: 0, max: 1, step: 0.01, value: 1 },
    ],
    descriptions: {},
    idPrefix: "settings-work-opacity",
    onChange: () => saveResult,
    ownerDocument: document,
    readMotion: () => "full",
  });
  const field = row.querySelector<HTMLInputElement>('input[type="number"]')!;
  const error = row.querySelector<HTMLElement>(".inkbook-settings-control-error")!;
  const geometry = vi.spyOn(window.Element.prototype, "getBoundingClientRect");
  const submit = (value: string): void => {
    field.value = value;
    field.dispatchEvent(new Event("change"));
  };
  try {
    field.focus();
    submit("101");
    await Promise.resolve();
    expect(error.textContent).toBe("Enter a valid setting value.");
    expect(geometry.mock.contexts).toContain(row);
    expect(geometry.mock.contexts).toContain(following);
    geometry.mockClear();
    submit("102");
    await Promise.resolve();
    expect(geometry).not.toHaveBeenCalled();
    expect(error.hidden).toBe(false);

    submit("80");
    await Promise.resolve();
    // Every existing projection boundary needs at most its old and new geometry once.
    const reads = new Map<unknown, number>();
    for (const element of geometry.mock.contexts) reads.set(element, (reads.get(element) ?? 0) + 1);
    expect(reads.size).toBeGreaterThan(0);
    expect(Math.max(...reads.values())).toBeLessThanOrEqual(2);
    expect(error.hidden).toBe(true);
    geometry.mockClear();
    let rejectSave: ((reason: Error) => void) | undefined;
    saveResult = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    submit("70");
    await Promise.resolve();
    expect(geometry).not.toHaveBeenCalled();
    rejectSave?.(new Error("Save failed"));
    await Promise.resolve();
    expect(error.textContent).toBe("The setting could not be saved.");
    reads.clear();
    for (const element of geometry.mock.contexts) reads.set(element, (reads.get(element) ?? 0) + 1);
    expect(reads.size).toBeGreaterThan(0);
    expect(Math.max(...reads.values())).toBeLessThanOrEqual(2);
    expect(document.activeElement).toBe(field);
    expect(row.querySelector('input[type="number"]')).toBe(field);
  } finally {
    release();
    group.remove();
    geometry.mockRestore();
  }
});
