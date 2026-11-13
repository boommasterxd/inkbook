import {
  MAX_TEXT_LAYOUT_ITEMS,
  MAX_TEXT_SOURCE_LENGTH,
} from "../schema/text-validation-primitives";
import { textTableBodySteps } from "./markdown-tables";
import type {
  TextMarkdownBlock,
  TextMarkdownTable,
  TextMarkdownTableRow,
  TextSourceChange,
} from "./text-types";

type ColumnAlignment = TextMarkdownTable["alignments"][number];

export type TextTableEdit =
  | { readonly kind: "insert-row"; readonly row: number; readonly placement: "before" | "after" }
  | { readonly kind: "append-row" }
  | { readonly kind: "delete-row"; readonly row: number }
  | { readonly kind: "insert-column"; readonly column: number }
  | { readonly kind: "delete-column"; readonly column: number }
  | { readonly kind: "align-column"; readonly column: number; readonly alignment: ColumnAlignment };

/** Original UTF-16 offsets, ready for the shared source-edit and style-mapping pipeline. */
export function* textTableEditSteps(
  source: string,
  block: TextMarkdownBlock,
  edit: TextTableEdit,
): Generator<void, readonly TextSourceChange[]> {
  const table = block.table;
  if (block.kind !== "table" || !table) throw new RangeError("Expected a Markdown table.");
  const changes = yield* tableChangesSteps(source, block, table, edit);
  let length = source.length;
  for (const change of changes) {
    length += change.insert.length - (change.end - change.start);
    yield;
  }
  if (length > MAX_TEXT_SOURCE_LENGTH) throw new RangeError("Text source capacity exceeded.");
  return changes;
}

function* tableChangesSteps(
  source: string,
  block: TextMarkdownBlock,
  table: TextMarkdownTable,
  edit: TextTableEdit,
): Generator<void, TextSourceChange[]> {
  if (edit.kind === "append-row" || edit.kind === "insert-row") {
    const row = edit.kind === "append-row" ? table.rows.length - 1 : edit.row;
    assertIndex(row, table.rows.length);
    assertCapacity(table.rows.length + 1, table.alignments.length);
    const after = edit.kind === "append-row" || edit.placement === "after" || row === 0;
    const end = row === 0 ? table.delimiter.end : table.rows[row]!.end;
    const position = after ? end : table.rows[row]!.start;
    const newline = tableNewline(source, table);
    const blank = "|" + "  |".repeat(table.alignments.length);
    return [{ start: position, end: position, insert: after ? newline + blank : blank + newline }];
  }
  if (edit.kind === "delete-row") {
    assertIndex(edit.row, table.rows.length);
    return yield* deleteRowChangesSteps(source, block, table, edit.row);
  }
  assertIndex(edit.column, table.alignments.length + (edit.kind === "insert-column" ? 1 : 0));
  if (edit.kind === "delete-column" && table.alignments.length === 1)
    return [{ start: block.start, end: block.end, insert: "" }];
  if (edit.kind === "insert-column") assertCapacity(table.rows.length, table.alignments.length + 1);
  const delimiter = yield* textTableBodySteps(
    { ...table.delimiter, content: source.slice(table.delimiter.start, table.delimiter.end) },
    table.alignments.length,
  );
  if (!delimiter) throw new RangeError("Invalid Markdown table delimiter.");
  if (edit.kind === "align-column") {
    const cell = delimiter.cells[edit.column]!;
    return [
      { start: cell.contentStart, end: cell.contentEnd, insert: alignmentSource(edit.alignment) },
    ];
  }
  const changes: TextSourceChange[] = [];
  for (const row of [table.rows[0]!, delimiter, ...table.rows.slice(1)]) {
    const insert = row === delimiter ? " --- " : " ";
    const change = yield* columnChangeSteps(source, row, edit, insert);
    if (change) changes.push(change);
    yield;
  }
  return changes;
}

function* columnChangeSteps(
  source: string,
  row: TextMarkdownTableRow,
  edit: Extract<TextTableEdit, { kind: "insert-column" | "delete-column" }>,
  insert: string,
): Generator<void, TextSourceChange | undefined> {
  const count = yield* actualCellCountSteps(row);
  const column = edit.column;
  if (column >= count && count < row.cells.length) return undefined;
  if (edit.kind === "insert-column") {
    if (column < count) {
      const position = row.cells[column]!.start;
      const prefix = column === 0 && position === row.start ? "|" : "";
      return { start: position, end: position, insert: prefix + insert + "|" };
    }
    const position = row.cells[count - 1]!.end;
    const suffix = source.slice(position, row.end).includes("|") ? "" : "|";
    return { start: position, end: position, insert: "|" + insert + suffix };
  }
  if (count === 1) return { start: row.start, end: row.end, insert: "|  |" };
  const cell = row.cells[column]!;
  return column + 1 < count
    ? {
        start: cell.start,
        end: row.cells[column + 1]!.start,
        insert: cell.start === row.start ? "|" : "",
      }
    : {
        start: row.cells[column - 1]!.end,
        end: cell.end,
        insert: row.cells[column - 1]!.start === row.start ? "|" : "",
      };
}

function* deleteRowChangesSteps(
  source: string,
  block: TextMarkdownBlock,
  table: TextMarkdownTable,
  index: number,
): Generator<void, TextSourceChange[]> {
  const row = table.rows[index]!;
  if (index > 0) {
    const previousEnd = index === 1 ? table.delimiter.end : table.rows[index - 1]!.end;
    return [{ start: previousEnd, end: row.end, insert: "" }];
  }
  const promoted = table.rows[1];
  if (!promoted) return [{ start: block.start, end: block.end, insert: "" }];
  const count = yield* actualCellCountSteps(promoted);
  const last = promoted.cells[count - 1]!;
  const missing = table.alignments.length - count;
  const changes: TextSourceChange[] = [{ start: row.start, end: promoted.start, insert: "" }];
  // Discard only the ignored excess tail; pad implicit cells before promoting to a strict header.
  const tail = "|" + "  |".repeat(missing);
  const delimiter = source.slice(table.delimiter.start, table.delimiter.end);
  changes.push({
    start: last.end,
    end: promoted.end,
    insert: tail + tableNewline(source, table) + delimiter,
  });
  return changes;
}

function* actualCellCountSteps(row: TextMarkdownTableRow): Generator<void, number> {
  let lower = 0;
  let upper = row.cells.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const cell = row.cells[middle]!;
    if (cell.start === row.end && cell.end === row.end) upper = middle;
    else lower = middle + 1;
    yield;
  }
  return lower;
}

function tableNewline(source: string, table: TextMarkdownTable): string {
  return source.slice(table.rows[0]!.end, table.delimiter.start);
}

function assertIndex(index: number, length: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= length)
    throw new RangeError("Invalid Markdown table index.");
}

function assertCapacity(rows: number, columns: number): void {
  if (rows + columns + 1 > MAX_TEXT_LAYOUT_ITEMS)
    throw new RangeError("Text table layout capacity exceeded.");
}

function alignmentSource(alignment: ColumnAlignment): string {
  if (alignment === "center") return ":---:";
  return alignment === "right" ? "---:" : ":---";
}
