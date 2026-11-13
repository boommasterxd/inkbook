import { ChangeSet, Transaction, type ChangeSpec, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TextMarkdownBlock } from "../../../domain/text/text-types";
import { textTableCellInputChanges } from "../../../domain/text/text-table-cell-input";
import { textTableCellSelection } from "./text-table-mode";

/** Cell-native offsets become one canonical transaction, including Markdown pipe escapes. */
export function textTableCellTransaction(
  transaction: Transaction,
  parent: { readonly view: EditorView; readonly block: TextMarkdownBlock; readonly start: number },
): TransactionSpec {
  const changes: ChangeSpec[] = [];
  const normalize = transaction.docChanged
    ? textTableCellInputChanges(transaction.newDoc.toString())
    : [];
  const normalized = ChangeSet.of(
    normalize.map((change) => ({ from: change.start, to: change.end, insert: change.insert })),
    transaction.newDoc.length,
  );
  transaction.changes.compose(normalized).iterChanges((from, to, _newFrom, _newTo, inserted) => {
    changes.push({ from: parent.start + from, to: parent.start + to, insert: inserted });
  });
  return {
    changes,
    selection: {
      anchor: parent.start + normalized.mapPos(transaction.state.selection.main.anchor, 1),
      head: parent.start + normalized.mapPos(transaction.state.selection.main.head, 1),
    },
    userEvent: transaction.annotation(Transaction.userEvent) ?? "input.type",
    annotations: textTableCellSelection.of(true),
  };
}
