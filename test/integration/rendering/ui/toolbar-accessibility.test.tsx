// @vitest-environment happy-dom

import { act } from "react";
import { MotionGlobalConfig, processFrame } from "motion";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookEditorChrome } from "../../../../src/rendering/ui/editor-chrome";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";

const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeEach(() => {
  MotionGlobalConfig.useManualTiming = true;
  processFrame(0);
  installObsidianDomHelpers();
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

it("owns the invitation in the paper through dismissal and root cleanup", async () => {
  const surface = document.body.createDiv({ cls: "inkbook-root" });
  surface.dataset.inkbookMotion = "reduced";
  const host = surface.createDiv();
  const paper = surface.createDiv({ cls: "inkbook-background-container" });
  const canvas = paper.createEl("button", { text: "Canvas" });
  canvas.focus();
  const root = createRoot(host);
  const props = createEditorChromeProps(document);
  const dismiss = vi.fn(() => root.render(<InkbookEditorChrome {...props} />));
  const renderInvitation = () =>
    root.render(
      <InkbookEditorChrome
        {...props}
        onboarding={{ container: paper, onStart: vi.fn(), onDismiss: dismiss }}
      />,
    );
  try {
    act(renderInvitation);
    await act(async () => {
      processFrame(16);
      await Promise.resolve();
    });
    const invitation = paper.querySelector("aside");
    expect(invitation).not.toBeNull();
    expect(host.contains(invitation)).toBe(false);
    expect(document.activeElement).toBe(canvas);
    await assertAccessibleSemantics(paper, ["button-name", "aria-valid-attr-value"]);
    const button = [...paper.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Skip tour",
    );
    act(() => button!.click());
    expect(dismiss).toHaveBeenCalledOnce();
    for (const timestamp of [32, 48, 64])
      await act(async () => {
        processFrame(timestamp);
        await Promise.resolve();
      });
    expect(paper.querySelector("aside")).toBeNull();
    act(renderInvitation);
    expect(paper.querySelector("aside")).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
  expect(paper.querySelector("aside")).toBeNull();
});
afterEach(() => {
  MotionGlobalConfig.useManualTiming = false;
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
