// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { createTextFieldEditorFixture } from "../../../../fixtures/obsidian/text-field-editor";
import { textElement } from "../../../../unit/domain/schema/fixtures";

const mount = createTextFieldEditorFixture();

describe("native text source editor backdrop", () => {
  it("uses a temporary page backdrop for Auto text over images, including inline styles", async () => {
    const fixed = {
      ...textElement(),
      style: {
        ...textElement().style,
        color: { type: "rgba" as const, value: "#123456FF" as const },
      },
    };
    const { editor } = mount("Hello", { element: fixed, imageBackdrop: true });
    expect(editor.view.dom.hasAttribute("data-inkbook-legible-backdrop")).toBe(false);
    editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(editor.applyStyle("text-color", { type: "theme-text" })).toBe(true);
    await editor.flushChanges();
    expect(editor.view.dom.hasAttribute("data-inkbook-legible-backdrop")).toBe(true);
    expect(editor.ranges[0]?.style.color).toEqual({ type: "theme-text" });
    editor.applyStyle("text-color", { type: "rgba", value: "#123456FF" });
    await editor.flushChanges();
    expect(editor.view.dom.hasAttribute("data-inkbook-legible-backdrop")).toBe(false);

    const auto = mount("Hello", { imageBackdrop: true });
    expect(auto.editor.view.dom.hasAttribute("data-inkbook-legible-backdrop")).toBe(true);
    const withoutImages = mount();
    expect(withoutImages.editor.view.dom.hasAttribute("data-inkbook-legible-backdrop")).toBe(false);
  });
});
