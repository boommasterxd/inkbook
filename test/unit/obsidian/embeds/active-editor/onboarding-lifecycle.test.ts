// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltInDeviceSettings } from "../../../../../src/domain/settings";
import { createHarness } from "../../../../fixtures/obsidian/active-controller";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

beforeEach(() => installObsidianDomHelpers());
afterEach(() => document.body.replaceChildren());

describe("one-time active embed invitation", () => {
  it("keeps drawing available when remembering the invitation fails and retries on dismissal", () => {
    const onFeedback = vi.fn();
    const onDismissOnboarding = vi.fn().mockImplementationOnce(() => {
      throw new Error("Device storage unavailable");
    });
    const fixture = createHarness({ onDismissOnboarding, onFeedback });
    fixture.controller.setEnabled(false);
    expect(() => fixture.controller.setEnabled(true)).not.toThrow();
    expect(fixture.input.inert).toBe(false);
    expect(onFeedback).toHaveBeenCalledExactlyOnceWith("onboarding-preference-failed");
    fixture.controller.chromeProps().onboarding?.onDismiss();
    expect(onDismissOnboarding).toHaveBeenCalledTimes(2);
    expect(fixture.controller.chromeProps().onboarding).toBeUndefined();
    fixture.dispose();
  });
  it("offers only after readiness and never offers again after leaving the first embed", () => {
    const deviceSettings = createBuiltInDeviceSettings();
    const onDismissOnboarding = vi.fn(() => {
      deviceSettings.onboardingDismissed = true;
    });
    const first = createHarness({ deviceSettings, onDismissOnboarding });
    first.controller.setEnabled(false);
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    expect(onDismissOnboarding).not.toHaveBeenCalled();
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeDefined();
    expect(onDismissOnboarding).toHaveBeenCalledOnce();
    first.controller.chromeProps().onboarding?.onDismiss();
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    first.controller.setEnabled(false);
    first.controller.setEnabled(true);
    expect(first.controller.chromeProps().onboarding).toBeUndefined();
    first.dispose();

    const reopened = createHarness({ deviceSettings, onDismissOnboarding });
    reopened.controller.setEnabled(false);
    reopened.controller.setEnabled(true);
    expect(reopened.controller.chromeProps().onboarding).toBeUndefined();
    expect(onDismissOnboarding).toHaveBeenCalledOnce();
    reopened.dispose();
  });

  it("consumes an ignored invitation and does not expose it while disabled", () => {
    const onDismissOnboarding = vi.fn();
    const fixture = createHarness({ onDismissOnboarding });
    fixture.controller.setEnabled(false);
    fixture.controller.setEnabled(true);
    expect(fixture.controller.chromeProps().onboarding).toBeDefined();
    fixture.controller.setEnabled(false);
    expect(fixture.controller.chromeProps().onboarding).toBeUndefined();
    fixture.controller.setEnabled(true);
    expect(fixture.controller.chromeProps().onboarding).toBeUndefined();
    expect(onDismissOnboarding).toHaveBeenCalledOnce();
    fixture.dispose();
  });
});
