import { describe, expect, it, vi } from "vitest";

import { updateActiveSceneChrome } from "../../../../../src/obsidian/embeds/active-scene/active-scene-chrome";

describe("active scene chrome updates", () => {
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
