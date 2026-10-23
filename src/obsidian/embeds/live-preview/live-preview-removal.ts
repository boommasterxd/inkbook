import type { EditorState, StateEffect, TransactionSpec } from "@codemirror/state";
import type { PresentationRemovalRange } from "../presentation/presentation-port";

interface LivePreviewRemovalView {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
  scrollSnapshot(): StateEffect<unknown>;
}

/** Maps the visible Markdown anchor through deletion without revealing the editor cursor. */
export function removeLivePreviewMarkdown(
  view: LivePreviewRemovalView,
  range: PresentationRemovalRange,
  expectedSource: string,
  mutate: () => void,
): boolean {
  const previousDocument = view.state.doc;
  if (previousDocument.toString() !== expectedSource) return false;
  const changes = view.state.changes({ from: range.from, to: range.to });
  const snapshot = view.scrollSnapshot().map(changes);
  if (snapshot === undefined) return false;
  mutate();
  if (!view.state.doc.eq(changes.apply(previousDocument))) return false;
  try {
    view.dispatch({ effects: snapshot, scrollIntoView: false });
  } catch {
    // A host scroll failure cannot undo the already verified text removal.
  }
  return true;
}
