import { describe, expect, it, vi } from "vitest";

import {
  showAttachedRecoveryPanel,
  showLoadRecoveryPanel,
} from "../../../../src/obsidian/embeds/recovery-notice";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

interface TestNoticeElement {
  readonly attributes: Map<string, string>;
  readonly children: TestNoticeElement[];
  disabled: boolean;
  dispatch(type: string): void;
  readonly removed: boolean;
  readonly style: Record<string, string>;
  readonly textContent: string;
}

function attachedActionButtons(panel: TestNoticeElement): TestNoticeElement[] {
  return panel.children[2]?.children ?? [];
}

function expectAttachedError(panel: TestNoticeElement, title: string): void {
  expect(panel.attributes.get("role")).toBe("alert");
  expect(panel.children[1]?.children[0]?.textContent).toBe(title);
}

describe("attached recovery panel", () => {
  it("replaces a load failure with icon-only retry and discard actions", () => {
    const host = new FakePresentationElement();
    const retry = vi.fn();
    const discard = vi.fn(() => true);
    const closed = vi.fn();
    const panel = showLoadRecoveryPanel(
      host as unknown as HTMLElement,
      { discard, retry },
      closed,
      "drawing-load-failed",
    );
    const panelElement = panel.element as unknown as TestNoticeElement;
    const actionButtons = attachedActionButtons(panelElement);

    expectAttachedError(panelElement, "The drawing couldn't be opened.");
    expect(panelElement.style.insetBlockEnd).toBe("16px");
    expect(panelElement.style.insetInlineStart).toBe("300px");
    expect(actionButtons.map((button) => button.attributes.get("aria-label"))).toEqual([
      "Retry opening drawing",
      "Keep saved preview",
    ]);
    actionButtons[0]?.dispatch("click");
    expect(retry).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();

    const discardPanel = showLoadRecoveryPanel(
      host as unknown as HTMLElement,
      { discard, retry },
      closed,
      "drawing-load-failed",
    );
    (discardPanel.element as unknown as TestNoticeElement).children[2]?.children[1]?.dispatch(
      "click",
    );
    expect(discard).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("offers retry, local copy, and cancel with accessible pending behavior", async () => {
    const host = new FakePresentationElement();
    const closed = vi.fn();
    let finish: ((confirmed: boolean) => void) | undefined;
    const panel = showAttachedRecoveryPanel(
      host as unknown as HTMLElement,
      {
        cancel: vi.fn(() => true),
        retry: vi.fn(() => false),
        saveLocalCopy: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              finish = resolve;
            }),
        ),
      },
      closed,
    );
    const panelElement = panel.element as unknown as TestNoticeElement;
    const actionButtons = attachedActionButtons(panelElement);

    expectAttachedError(panelElement, "Changes couldn't be saved.");
    expect(actionButtons.map((button) => button.attributes.get("aria-label"))).toEqual([
      "Retry save",
      "Save copy",
      "Continue editing",
    ]);
    expect(actionButtons.map((button) => button.children[0]?.attributes.get("data-icon"))).toEqual([
      "rotate-ccw",
      "copy-plus",
      "pencil",
    ]);
    actionButtons[0]?.dispatch("click");
    expect(actionButtons.every((button) => !button.disabled)).toBe(true);
    actionButtons[1]?.dispatch("click");
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    finish?.(false);
    await vi.waitFor(() => expect(actionButtons.every((button) => !button.disabled)).toBe(true));
    actionButtons[2]?.dispatch("click");
    expect(host.children).toHaveLength(0);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
