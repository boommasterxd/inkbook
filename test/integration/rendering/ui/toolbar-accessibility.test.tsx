// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InkbookEditorChrome } from "../../../../src/rendering/ui/editor-chrome";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";

const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeEach(() => {
  installObsidianDomHelpers();
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.body.replaceChildren();
  delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

describe("toolbar semantic accessibility gate", () => {
  it("scans tool and selection actions and rejects missing names or invalid state", async () => {
    const surface = document.body.createDiv({ cls: "inkbook-root" });
    surface.dataset.inkbookMotion = "reduced";
    const root = createRoot(surface);
    const props = createEditorChromeProps(document);
    try {
      act(() => {
        root.render(
          <InkbookEditorChrome
            {...props}
            toolbarState={{
              ...props.toolbarState,
              canUndo: true,
              canRedo: true,
              canPaste: true,
              pasteVisible: true,
              hasSelection: true,
              fingerDrawingAvailable: true,
            }}
          />,
        );
      });
      await assertAccessibleSemantics(surface, ["button-name", "aria-valid-attr-value"]);
      const draw = surface.querySelector<HTMLButtonElement>('[data-inkbook-action="draw"]');
      expect(draw).not.toBeNull();
      const label = draw!.getAttribute("aria-label")!;
      draw!.removeAttribute("aria-label");
      await expect(assertAccessibleSemantics(surface, ["button-name"])).rejects.toThrow(
        "button-name",
      );
      draw!.setAttribute("aria-label", label);
      draw!.setAttribute("aria-pressed", "invalid");
      await expect(assertAccessibleSemantics(surface, ["aria-valid-attr-value"])).rejects.toThrow(
        "aria-valid-attr-value",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
