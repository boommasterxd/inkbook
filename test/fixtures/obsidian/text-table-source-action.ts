import { expect } from "vitest";
import type { TextFieldEditor } from "../../../src/obsidian/text/editor/text-field-editor";
import { clickAction } from "./text-table-editor";

export function openTableMarkdownSource(editor: TextFieldEditor): void {
  clickAction(editor, "Table options");
  const action = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (item) => item.textContent?.trim() === "Edit Markdown source",
  );
  expect(action).toBeDefined();
  action!.click();
}
