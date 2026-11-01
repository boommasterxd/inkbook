// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkbookSettingsStore } from "../../../../../src/obsidian/settings/storage";
import { OnboardingPreference } from "../../../../../src/obsidian/settings/onboarding-preference";
import {
  createActiveEditorModel,
  createHarness,
} from "../../../../fixtures/obsidian/active-controller";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { ElementStore } from "../../../../../src/domain/store/public";
import { createDragElement } from "../../../../../src/editor/tools/public";
import { createBuiltInSettings } from "../../../../../src/domain/settings";

const editors: ReturnType<typeof createHarness>[] = [];
beforeEach(() => installObsidianDomHelpers());
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.dispose());
  document.body.replaceChildren();
});

async function session() {
  const saveLocalStorage = vi.fn();
  const settings = new InkbookSettingsStore(
    { loadData: async () => undefined, saveData: vi.fn() },
    { loadLocalStorage: () => undefined, saveLocalStorage },
  );
  await settings.load();
  const preference = new OnboardingPreference(settings);
  const editor = (onboardingPreference = preference, store = new ElementStore([])) => {
    const onFeedback = vi.fn();
    const current = createHarness({
      deviceSettings: settings.getDeviceSettings(),
      onboardingPreference,
      onFeedback,
      model: createActiveEditorModel(store),
    });
    editors.push(current);
    current.controller.setEnabled(false);
    return { ...current, onFeedback };
  };
  return { settings, saveLocalStorage, editor };
}

describe("empty-paper invitation eligibility", () => {
  it("skips populated documents without consuming the invitation for the next empty embed", async () => {
    const current = await session();
    const populated = current.editor(undefined, new ElementStore([existingElement()]));
    populated.controller.setEnabled(true);
    expect(populated.controller.chromeProps().onboarding).toBeUndefined();
    expect(current.saveLocalStorage).not.toHaveBeenCalled();
    expect(current.settings.getDeviceSettings().onboardingDismissed).toBe(false);

    const empty = current.editor();
    empty.controller.setEnabled(true);
    expect(empty.controller.chromeProps().onboarding).toBeDefined();
    expect(current.saveLocalStorage).toHaveBeenCalledOnce();
  });

  it("removes an invitation when content is added and never restores it after content is removed", async () => {
    const current = await session();
    const store = new ElementStore([]);
    const first = current.editor(undefined, store);
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeDefined();
    store.create(existingElement());
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    store.remove([existingElement().id]);
    first.controller.setEnabled(false);
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    expect(current.saveLocalStorage).toHaveBeenCalledOnce();
  });
});

describe("one-time active embed invitation", () => {
  it("keeps drawing available when remembering the invitation fails and retries on dismissal", async () => {
    const current = await session();
    current.saveLocalStorage.mockImplementationOnce(() => {
      throw new Error("Device storage unavailable");
    });
    const first = current.editor();
    expect(() => first.controller.setEnabled(true)).not.toThrow();
    expect(first.input.inert).toBe(false);
    expect(first.onFeedback).toHaveBeenCalledExactlyOnceWith("onboarding-preference-failed");
    expect(current.settings.getDeviceSettings().onboardingDismissed).toBe(false);
    first.controller.chromeProps().onboarding?.onDismiss();
    expect(current.saveLocalStorage).toHaveBeenCalledTimes(2);
    expect(current.settings.getDeviceSettings().onboardingDismissed).toBe(true);
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
  });

  it("offers only after readiness and preserves durable dismissal across plugin sessions", async () => {
    const current = await session();
    const first = current.editor();
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    expect(current.saveLocalStorage).not.toHaveBeenCalled();
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeDefined();
    expect(current.saveLocalStorage).toHaveBeenCalledOnce();
    first.controller.chromeProps().onboarding?.onDismiss();
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    first.controller.setEnabled(false);
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeUndefined();

    const reopened = current.editor(new OnboardingPreference(current.settings));
    reopened.controller.setEnabled(true);
    expect(reopened.controller.chromeProps().onboarding).toBeUndefined();
    expect(current.saveLocalStorage).toHaveBeenCalledOnce();
  });

  it("consumes an ignored invitation and does not expose it while disabled", async () => {
    const current = await session();
    const first = current.editor();
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeDefined();
    first.controller.setEnabled(false);
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    expect(current.saveLocalStorage).toHaveBeenCalledOnce();
  });

  it("suppresses repeats across editors after a failed save but offers in a new plugin session", async () => {
    const current = await session();
    current.saveLocalStorage.mockImplementation(() => {
      throw new Error("Device storage unavailable");
    });
    const first = current.editor();
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeDefined();
    first.controller.setEnabled(false);

    const second = current.editor();
    second.controller.setEnabled(true);
    expect(second.controller.chromeProps().onboarding).toBeUndefined();
    expect(second.onFeedback).not.toHaveBeenCalled();
    expect(current.saveLocalStorage).toHaveBeenCalledOnce();
    expect(current.settings.getDeviceSettings().onboardingDismissed).toBe(false);

    const restarted = current.editor(new OnboardingPreference(current.settings));
    restarted.controller.setEnabled(true);
    expect(restarted.controller.chromeProps().onboarding).toBeDefined();
    expect(restarted.onFeedback).toHaveBeenCalledExactlyOnceWith("onboarding-preference-failed");
    expect(current.saveLocalStorage).toHaveBeenCalledTimes(2);
    current.saveLocalStorage.mockImplementation(() => undefined);
    restarted.controller.chromeProps().onboarding?.onStart();
    expect(current.settings.getDeviceSettings().onboardingDismissed).toBe(true);
    expect(current.saveLocalStorage).toHaveBeenCalledTimes(3);
  });
});

function existingElement() {
  return createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 100, y: 100 },
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    start: { x: 10, y: 10 },
    tool: "rectangle",
  });
}
