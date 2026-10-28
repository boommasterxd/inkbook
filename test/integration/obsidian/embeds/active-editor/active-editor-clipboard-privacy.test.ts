// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { createHarness } from "../../../../fixtures/obsidian/active-controller";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("does not access Clipboard content on activation, enablement, hover or menu opening", async () => {
  const getType = vi.fn(async () => new Blob(["INKBOOK/1:{}"]));
  const read = vi.fn(async () => [{ types: ["text/plain"], getType }]);
  const readText = vi.fn(async () => "INKBOOK/1:{}");
  const clipboard = vi.spyOn(window.navigator, "clipboard", "get").mockReturnValue({
    read,
    readText,
  } as unknown as Clipboard);
  const harness = createHarness();
  try {
    harness.controller.setEnabled(false);
    harness.controller.setEnabled(true);
    harness.controller.handlePointerBoundary(true);
    harness.controller.handlePointerBoundary(false);
    harness.controller.handlePointerBoundary(true);
    harness.controller.handleContextMenu(
      new MouseEvent("contextmenu", { clientX: 50, clientY: 100 }),
    );
    await Promise.resolve();

    expect(harness.controller.toolbarState().canPaste).toBe(true);
    expect(harness.controller.toolbarState().pasteVisible).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(getType).not.toHaveBeenCalled();

    harness.controller.executeAction("paste");
    await vi.waitFor(() => expect(getType).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
    expect(readText).not.toHaveBeenCalled();
  } finally {
    harness.dispose();
    clipboard.mockRestore();
  }
});
