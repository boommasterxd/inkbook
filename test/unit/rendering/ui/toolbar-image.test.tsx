// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InkbookEditorChrome } from "../../../../src/rendering/ui/editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

it("opens image import from the toolbar keyboard track without a pressed tool state", () => {
  installObsidianDomHelpers();
  const environment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.body.createDiv({ cls: "inkbook-root" });
  container.dataset.inkbookMotion = "reduced";
  const root = createRoot(container);
  const onAction = vi.fn();
  try {
    act(() =>
      root.render(
        <InkbookEditorChrome {...createEditorChromeProps(document)} onToolbarAction={onAction} />,
      ),
    );
    const text = container.querySelector<HTMLButtonElement>("[data-inkbook-action='text']")!;
    const image = container.querySelector<HTMLButtonElement>("[data-inkbook-action='image']")!;
    expect(image.getAttribute("aria-haspopup")).toBe("dialog");
    expect(image.hasAttribute("aria-pressed")).toBe(false);
    act(() => {
      text.focus();
      text.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
      );
    });
    expect(document.activeElement).toBe(image);
    act(() => image.click());
    expect(onAction).toHaveBeenCalledWith("image", image);
  } finally {
    act(() => root.unmount());
    container.remove();
    delete environment.IS_REACT_ACT_ENVIRONMENT;
  }
});
