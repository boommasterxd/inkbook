import { WidgetType, type EditorView } from "@codemirror/view";
import { setIcon } from "obsidian";
import type { TextSourceRange } from "../../../domain/text/text-types";
import { setTextTableSource } from "./text-table-mode";

/** The explicit source surface always offers a keyboard-accessible return to the table. */
export class TextTableSourceWidget extends WidgetType {
  public constructor(
    readonly range: TextSourceRange,
    readonly label: string,
  ) {
    super();
  }

  public override eq(other: TextTableSourceWidget): boolean {
    return (
      this.range.start === other.range.start &&
      this.range.end === other.range.end &&
      this.label === other.label
    );
  }

  public override toDOM(view: EditorView): HTMLElement {
    const control = view.dom.ownerDocument.createElement("div");
    control.className = "inkbook-text-table-source-control";
    const button = view.dom.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "inkbook-text-table-source-toggle";
    const icon = button.ownerDocument.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "table-2");
    button.append(icon, this.label);
    button.addEventListener("click", () => {
      view.dispatch({ effects: setTextTableSource.of({ ...this.range, source: false }) });
      view.focus();
    });
    control.append(button);
    return control;
  }
}
