import type { TextMarkdownBlock } from "../../../domain/text/text-types";
import type { TextTableEdit } from "../../../domain/text/text-table-edits";
import type { TextTableMount } from "./text-field-editor-types";

interface TableCellPosition {
  readonly row: number;
  readonly column: number;
}

/** Grid movement stays independent of source preparation and rendered row windows. */
export function tableNavigationIndex(
  position: TableCellPosition,
  direction: "next" | "previous" | "up" | "down",
  columns: number,
): number {
  const offset =
    direction === "next"
      ? 1
      : direction === "previous"
        ? -1
        : direction === "up"
          ? -columns
          : columns;
  return position.row * columns + position.column + offset;
}

export function tableCellAtPosition(
  mount: Pick<TextTableMount, "block" | "node">,
  position: number | { readonly x: number; readonly y: number },
): TableCellPosition | undefined {
  const table = mount.block.table;
  if (!table) return;
  if (typeof position !== "number") {
    const target = mount.node.ownerDocument.elementFromPoint?.(position.x, position.y);
    const button = target?.closest<HTMLElement>("[data-inkbook-table-column]");
    if (!button || !mount.node.contains(button)) return;
    return {
      row: Number(button.getAttribute("data-inkbook-table-row")),
      column: Number(button.getAttribute("data-inkbook-table-column")),
    };
  }
  if (position < mount.block.start || position > mount.block.end) return;
  let lower = 0;
  let upper = table.rows.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (table.rows[middle]!.start <= position) lower = middle + 1;
    else upper = middle;
  }
  const row = Math.max(0, lower - 1);
  const cells = table.rows[row]!.cells;
  lower = 0;
  upper = cells.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (cells[middle]!.end < position) lower = middle + 1;
    else upper = middle;
  }
  return { row, column: Math.min(cells.length - 1, lower) };
}

export function tableEditTarget(
  block: TextMarkdownBlock,
  action: TextTableEdit,
  active?: TableCellPosition,
): (TableCellPosition & { readonly tableStart: number }) | undefined {
  const table = block.table!;
  let row = active?.row ?? 0;
  let column = active?.column ?? 0;
  if (action.kind === "append-row") row = table.rows.length;
  else if (action.kind === "insert-row")
    row = Math.max(1, action.row + (action.placement === "after" ? 1 : 0));
  else if (action.kind === "delete-row") {
    if (table.rows.length <= 1) return;
    row = Math.max(0, Math.min(action.row, table.rows.length - 2));
  } else if (action.kind === "insert-column") column = action.column;
  else if (action.kind === "delete-column") {
    if (table.alignments.length <= 1) return;
    column = Math.max(0, Math.min(action.column, table.alignments.length - 2));
  }
  return { tableStart: block.start, row, column };
}
