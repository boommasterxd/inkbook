// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createActiveSceneChromeElements,
  updateActiveSceneChrome,
} from "../../../../../src/obsidian/embeds/active-scene/active-scene-chrome";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

beforeEach(() => installObsidianDomHelpers());
afterEach(() => {
  Platform.isPhone = false;
  document.body.replaceChildren();
});

describe("active scene chrome updates", () => {
  it.each([true, false])("selects phone sticky clearance only for isPhone=%s", (isPhone) => {
    Platform.isPhone = isPhone;
    const root = document.body.createDiv();

    const elements = createActiveSceneChromeElements(root);

    expect(elements.chromeHost.dataset.phone).toBe(String(isPhone));
  });

  it("passes the semantic layout key after updating React chrome state", () => {
    const props = {
      layout: "wide",
      leftHanded: false,
      toolbarState: {
        canPaste: false,
        fingerDrawingAvailable: true,
        hasSelection: false,
        pasteVisible: true,
        onboardingContextPreview: false,
      },
    };
    const chrome = { update: vi.fn() };
    const controller = { chromeProps: vi.fn(() => props) };
    const layout = { chromeChanged: vi.fn() };

    updateActiveSceneChrome(chrome as never, controller as never, layout);

    expect(chrome.update).toHaveBeenCalledWith(props);
    const initialKey = layout.chromeChanged.mock.calls[0]?.[0] as string;
    expect(initialKey).toBe("wide:right:finger:no-selection:paste:no-tour-context");
    props.toolbarState.canPaste = true;
    updateActiveSceneChrome(chrome as never, controller as never, layout);
    expect(layout.chromeChanged).toHaveBeenLastCalledWith(initialKey);
    props.toolbarState.onboardingContextPreview = true;
    updateActiveSceneChrome(chrome as never, controller as never, layout);
    expect(layout.chromeChanged).toHaveBeenLastCalledWith(
      "wide:right:finger:no-selection:paste:tour-context",
    );
  });
});
