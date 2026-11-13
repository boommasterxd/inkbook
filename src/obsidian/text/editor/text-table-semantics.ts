import type { Text } from "@codemirror/state";
import type { TextMarkdownBlock } from "../../../domain/text/text-types";
import type { TextTableRowRange } from "./text-field-editor-types";

export interface TextTableSemantics {
  readonly document: Document;
  readonly block: TextMarkdownBlock;
  readonly source: Text;
  readonly label: string;
  readonly offsets?: readonly number[];
  readonly focused?: number | undefined;
}

/** Only the current rows, column headers and one retained focused row own controls. */
export function* textTableSemanticsSteps(
  context: TextTableSemantics,
  range: TextTableRowRange,
): Generator<void, HTMLTableElement> {
  const { document, block, offsets } = context;
  const rows = block.table?.rows ?? [];
  const table = document.createElement("table");
  table.setAttribute("aria-rowcount", String(rows.length));
  table.setAttribute("aria-colcount", String(block.table?.alignments.length ?? 0));
  const indices = new Set<number>();
  if (range.to > range.from) indices.add(0);
  for (let index = range.from; index < range.to; index += 1) {
    indices.add(index);
    yield;
  }
  if (context.focused !== undefined) indices.add(context.focused);
  const head = table.createTHead();
  const body = table.createTBody();
  let previous = 0;
  for (const index of [...indices].sort((left, right) => left - right)) {
    const row = rows[index];
    if (!row) continue;
    if (offsets) appendSpacer(body, offsets[index]! - offsets[previous]!, context);
    const element = (index === 0 ? head : body).insertRow();
    element.setAttribute("aria-rowindex", String(index + 1));
    if (offsets) element.style.height = `${offsets[index + 1]! - offsets[index]!}px`;
    for (const [column, cell] of row.cells.entries()) {
      const target = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) target.setAttribute("scope", "col");
      target.style.textAlign = block.table?.alignments[column] ?? "left";
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-inkbook-source", String(cell.contentStart));
      button.setAttribute("data-inkbook-table-row", String(index));
      button.setAttribute("data-inkbook-table-column", String(column));
      button.textContent =
        context.source.sliceString(cell.contentStart, cell.contentEnd) || context.label;
      target.append(button);
      element.append(target);
      yield;
    }
    previous = index + 1;
  }
  if (offsets) appendSpacer(body, offsets[rows.length]! - offsets[previous]!, context);
  return table;
}

function appendSpacer(body: HTMLTableSectionElement, height: number, context: TextTableSemantics) {
  if (height <= 0) return;
  const row = body.insertRow();
  row.setAttribute("aria-hidden", "true");
  row.setAttribute("role", "presentation");
  const cell = row.insertCell();
  cell.colSpan = context.block.table?.alignments.length ?? 1;
  cell.style.height = `${height}px`;
  cell.className = "inkbook-text-table-spacer";
}
