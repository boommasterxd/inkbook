import { EditorSelection, EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";

const scrollAnchor = StateEffect.define<number>({ map: (value, changes) => changes.mapPos(value) });

export function removalHarness(lineCount: number) {
  const prefix = "Before\n";
  const embed = "\n!inkbook[[drawing.svg]]\n\n";
  const source = prefix + embed + "Ordinary Markdown prose.\n".repeat(lineCount);
  const range = { from: prefix.length, to: prefix.length + embed.length };
  const initial = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(source.length),
  });
  let state = initial;
  let snapshots = 0;
  let dispatches = 0;
  let anchor = range.to;
  const view = {
    get state() {
      return state;
    },
    scrollSnapshot: () => {
      snapshots += 1;
      return scrollAnchor.of(anchor);
    },
    dispatch: (spec: TransactionSpec) => {
      dispatches += 1;
      const transaction = state.update(spec);
      state = transaction.state;
      for (const effect of transaction.effects) if (effect.is(scrollAnchor)) anchor = effect.value;
    },
  };
  return {
    source,
    range,
    view,
    snapshotReads: () => snapshots,
    effectDispatches: () => dispatches,
    anchor: () => anchor,
    mutate: () => {
      state = state.update({ changes: range }).state;
    },
    reset: () => {
      state = initial;
      snapshots = 0;
      dispatches = 0;
      anchor = range.to;
    },
  };
}
