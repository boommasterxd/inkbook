// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { mountTextControlStyles } from "../../../../../src/obsidian/text/editor/text-editor-styles";
import { textFieldTheme } from "../../../../../src/obsidian/text/editor/text-field-theme";

it("shares only the configured editor modules with drawing-document controls and releases its stylesheet", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const target = document.implementation.createHTMLDocument("Drawing");
  const view = new EditorView({ parent: container, extensions: [textFieldTheme] });
  const release = mountTextControlStyles(view, { drawingDocument: target });
  try {
    const rules = view.state
      .facet(EditorView.styleModule)
      .map((module) => module.getRules())
      .join("\n");
    expect(target.head.querySelector("[data-inkbook-text-control-styles]")?.textContent).toBe(
      rules,
    );
    expect(rules).toContain("inkbook-text-table-controls");
    const releaseLocal = mountTextControlStyles(view);
    expect(document.head.querySelector("[data-inkbook-text-control-styles]")).toBeNull();
    releaseLocal();
  } finally {
    release();
    view.destroy();
    container.remove();
  }
  expect(target.head.querySelector("[data-inkbook-text-control-styles]")).toBeNull();
});
