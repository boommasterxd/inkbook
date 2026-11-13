// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { trapPhoneSheetFocus } from "../../../../../src/obsidian/menus/panels/phone-sheet-focus";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

it("retains an owned popup footer and external editor while rejecting unrelated and lower-sheet focus", () => {
  installObsidianDomHelpers();
  const cleanups: (() => void)[] = [];
  try {
    const surface = document.body.createDiv();
    surface.tabIndex = -1;
    const trigger = surface.createEl("button");
    trigger.id = "font-picker-trigger";
    const popup = document.body.createDiv();
    popup.dataset.inkbookMenuAnchor = trigger.id;
    const footer = popup.createEl("button");
    const editor = document.body.createEl("textarea");
    const unrelated = document.body.createEl("button");
    let nestedOpen = false;
    cleanups.push(
      trapPhoneSheetFocus(
        surface,
        trigger,
        () => !nestedOpen,
        () => editor,
      ),
    );
    trigger.focus();
    footer.focus();
    expect(document.activeElement).toBe(footer);
    editor.focus();
    expect(document.activeElement).toBe(editor);
    unrelated.focus();
    expect(document.activeElement).toBe(footer);

    const nested = document.body.createDiv();
    nested.tabIndex = -1;
    const nestedAction = nested.createEl("button");
    nestedOpen = true;
    cleanups.push(trapPhoneSheetFocus(nested, nestedAction, () => nestedOpen));
    nestedAction.focus();
    footer.focus();
    expect(document.activeElement).toBe(nestedAction);
    editor.focus();
    expect(document.activeElement).toBe(nestedAction);
    nestedOpen = false;
    nested.remove();
    footer.focus();
    expect(document.activeElement).toBe(footer);
    popup.hidden = true;
    unrelated.focus();
    expect(document.activeElement).toBe(surface);
  } finally {
    for (const cleanup of cleanups) cleanup();
    document.body.replaceChildren();
  }
});
