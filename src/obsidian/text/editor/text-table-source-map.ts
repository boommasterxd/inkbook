import type { ChangeDesc, Text } from "@codemirror/state";
import { textTableBodySteps } from "../../../domain/text/markdown-tables";
import type { TextMarkdownTableCell } from "../../../domain/text/text-types";
import type { TextTableMount } from "./text-field-editor-types";

/** One composed mapping keeps cell navigation independent of asynchronous table preparation. */
export class TextTableSourceMap {
  #document: Text;
  #changes: ChangeDesc | undefined;
  #row: { document: Text; index: number; cells: readonly TextMarkdownTableCell[] } | undefined;

  public constructor(document: Text) {
    this.#document = document;
  }

  public reset(document: Text): void {
    this.#document = document;
    this.#changes = undefined;
    this.#row = undefined;
  }

  public record(changes: ChangeDesc, document: Text): void {
    this.#changes = this.#changes?.composeDesc(changes) ?? changes;
    this.#document = document;
  }

  public matches(document: Text): boolean {
    return this.#document === document;
  }

  public originalPosition(position: number): number {
    return this.#changes?.invertedDesc.mapPos(position, 1) ?? position;
  }

  public cell(
    context: TextTableMount,
    row: number,
    column: number,
  ): TextMarkdownTableCell | undefined {
    const sourceRow = context.block.table?.rows[row];
    const cell = sourceRow?.cells[column];
    if (!sourceRow || !cell || !this.#changes) return cell;
    const last = sourceRow.cells[sourceRow.cells.length - 1]!;
    if (last.start === last.end && last.end === sourceRow.end) {
      if (this.#row?.document === this.#document && this.#row.index === row)
        return this.#reconcile(cell, this.#row.cells[column]);
      // Native input must target the repaired cell atomically. Only this protocol-bounded row
      // is parsed, once per Text identity; all ordinary rows use composed position mapping.
      const start = this.#position(sourceRow.start, -1);
      const end = this.#position(sourceRow.end, 1);
      const steps = textTableBodySteps(
        { start, end, content: this.#document.sliceString(start, end) },
        sourceRow.cells.length,
      );
      let next = steps.next();
      while (!next.done) next = steps.next();
      if (next.value) this.#row = { document: this.#document, index: row, cells: next.value.cells };
      return this.#reconcile(cell, next.value?.cells[column]);
    }
    return {
      start: this.#position(cell.start, -1),
      end: this.#position(cell.end, 1),
      contentStart: this.#position(cell.contentStart, -1),
      contentEnd: this.#position(cell.contentEnd, 1),
    };
  }

  public missing(context: TextTableMount, row: number, cell: TextMarkdownTableCell): boolean {
    return (
      cell.start === cell.end && cell.end === this.#position(context.block.table!.rows[row]!.end, 1)
    );
  }

  #reconcile(cell: TextMarkdownTableCell, resolved: TextMarkdownTableCell | undefined) {
    if (!resolved || cell.start === cell.end) return resolved;
    return {
      ...resolved,
      contentStart: Math.max(resolved.start, this.#position(cell.contentStart, -1)),
      contentEnd: Math.min(resolved.end, this.#position(cell.contentEnd, 1)),
    };
  }

  public materialize(context: TextTableMount, row: number) {
    const descriptor = context.block.table!;
    const sourceRow = descriptor.rows[row]!;
    const start = sourceRow.cells.findIndex(
      (cell) => cell.start === cell.end && cell.start === sourceRow.end,
    );
    return {
      from: this.#position(sourceRow.end, 1),
      insert:
        (sourceRow.cells[start - 1]?.end === sourceRow.end ? " |" : "") +
        "  |".repeat(descriptor.alignments.length - start),
    };
  }

  #position(position: number, association: -1 | 1): number {
    return this.#changes?.mapPos(position, association) ?? position;
  }
}
