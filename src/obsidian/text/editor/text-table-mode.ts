import { Annotation, StateEffect, type Transaction } from "@codemirror/state";
import type { TextSourceRange } from "../../../domain/text/text-types";

export const textTableCellSelection = Annotation.define<boolean>();

export const setTextTableSource = StateEffect.define<
  TextSourceRange & { readonly source: boolean }
>({
  map: (value, changes) => ({
    ...value,
    start: changes.mapPos(value.start, -1),
    end: changes.mapPos(value.end, 1),
  }),
});

export interface TextTableMode {
  readonly source: readonly TextSourceRange[];
  readonly known: readonly TextSourceRange[];
  readonly typed: TextSourceRange | undefined;
  readonly cellSelection: boolean;
}

export const initialTextTableMode: TextTableMode = {
  source: [],
  known: [],
  typed: undefined,
  cellSelection: false,
};

export function textTableInSource(mode: TextTableMode, block: TextSourceRange): boolean {
  return mode.source.some((range) => overlaps(range, block));
}

/** Source mode is explicit, except while a newly typed table is still being composed. */
export function updateTextTableMode(
  previous: TextTableMode,
  transaction: Transaction,
  tables?: readonly TextSourceRange[],
): TextTableMode {
  const map = (range: TextSourceRange): TextSourceRange => ({
    start: transaction.changes.mapPos(range.start, -1),
    end: transaction.changes.mapPos(range.end, 1),
  });
  let source = previous.source.map(map);
  const known = previous.known.map(map);
  let typed = previous.typed ? map(previous.typed) : undefined;
  if (transaction.docChanged) {
    if (transaction.isUserEvent("input") && !transaction.isUserEvent("input.paste")) {
      transaction.changes.iterChangedRanges((_from, _to, start, end) => {
        typed = typed
          ? { start: Math.min(typed.start, start), end: Math.max(typed.end, end) }
          : { start, end };
      });
    } else typed = undefined;
  }
  for (const effect of transaction.effects) {
    if (!effect.is(setTextTableSource)) continue;
    source = source.filter((range) => !overlaps(range, effect.value));
    if (effect.value.source) source.push(effect.value);
  }
  if (tables && typed) {
    for (const table of tables) {
      if (
        overlaps(table, typed) &&
        !known.some((range) => overlaps(range, table)) &&
        selectionInside(transaction, table)
      )
        source.push(table);
    }
    typed = undefined;
  }
  source = source.filter((range) => selectionInside(transaction, range));
  const cellSelection = transaction.selection
    ? transaction.annotation(textTableCellSelection) === true
    : previous.cellSelection;
  return { source, known: tables ?? known, typed, cellSelection };
}

function selectionInside(transaction: Transaction, range: TextSourceRange): boolean {
  return transaction.state.selection.ranges.some(
    (selection) => selection.from <= range.end && selection.to >= range.start,
  );
}

function overlaps(left: TextSourceRange, right: TextSourceRange): boolean {
  return left.start <= right.end && left.end >= right.start;
}
