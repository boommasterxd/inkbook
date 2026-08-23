import { describe, expect, it, vi } from "vitest";

import { ActiveEditorChromeState } from "../../../../../src/obsidian/embeds/active-editor/controller-chrome-state";

describe("active editor chrome state", () => {
  it("keeps shape activation and flyout toggling in one coherent state", () => {
    const onStateChanged = vi.fn();
    const state = new ActiveEditorChromeState(onStateChanged);

    expect(state.activateTool("shape", "draw")).toBe("line");
    expect(state.activateTool("shape", "line")).toBeUndefined();
    expect(state.openFlyout).toBe("shape");
    expect(state.closeFlyout()).toBe(true);
    expect(state.closeFlyout()).toBe(false);

    expect(state.selectShape("triangle")).toBe("triangle");
    expect(state.selectedShape).toBe("triangle");
    expect(onStateChanged).toHaveBeenCalledTimes(2);
  });

  it("notifies only for effective layout and flyout changes", () => {
    const onStateChanged = vi.fn();
    const state = new ActiveEditorChromeState(onStateChanged);

    expect(state.layout).toBe("wide");
    state.setLayout("wide");
    state.setFlyout(null);
    expect(onStateChanged).not.toHaveBeenCalled();

    state.setLayout("scrollable");
    state.toggleFlyout("style");
    expect(state.layout).toBe("scrollable");
    expect(state.openFlyout).toBe("style");
    expect(onStateChanged).toHaveBeenCalledTimes(2);
  });
});
