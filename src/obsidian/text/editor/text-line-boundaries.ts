import { RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

/** A real zero-height block makes each hard line a structural native height-map entry. */
class TextLineBoundaryWidget extends WidgetType {
  public override get estimatedHeight(): number {
    return 0;
  }
  public override eq(other: WidgetType): boolean {
    return other instanceof TextLineBoundaryWidget;
  }
  public override toDOM(view: EditorView): HTMLElement {
    const node = view.dom.ownerDocument.createElement("div");
    node.className = "inkbook-text-line-boundary";
    node.setAttribute("aria-hidden", "true");
    return node;
  }
}

const HARDLINE_BOUNDARY = Decoration.widget({
  block: true,
  side: -1,
  widget: new TextLineBoundaryWidget(),
});
export const setTextLineBoundaries = StateEffect.define<DecorationSet>();

export const textLineBoundaries = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (previous, transaction) => {
    for (const effect of transaction.effects)
      if (effect.is(setTextLineBoundaries)) return effect.value;
    if (!transaction.docChanged) return previous;
    let mapped = previous.map(transaction.changes);
    transaction.changes.iterChangedRanges((_from, _to, start, end) => {
      mapped = mapped.update({
        filterFrom: Math.max(0, start - 1),
        filterTo: Math.min(transaction.newDoc.length, end + 1),
        filter: (position) => transaction.newDoc.lineAt(position).from === position,
      });
    });
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function* textLineBoundariesSteps(document: Text): Generator<void, DecorationSet> {
  const builder = new RangeSetBuilder<Decoration>();
  let position = 0;
  for (const cursor = document.iterLines(); !cursor.next().done;) {
    builder.add(position, position, HARDLINE_BOUNDARY);
    position += cursor.value.length + 1;
    yield;
  }
  return builder.finish();
}
