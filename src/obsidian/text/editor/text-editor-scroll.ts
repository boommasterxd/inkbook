import type { Extension, SelectionRange, Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type {
  PreparedTextScrollReveal,
  TextEditorClientRect,
  TextFieldEditorOptions,
} from "./text-field-editor-types";

interface CaretRevealIntent {
  readonly document: Text;
  readonly selection: SelectionRange;
  readonly range: SelectionRange;
  measuredHeight: number | undefined;
  pendingHeight: number | undefined;
  reveal: PreparedTextScrollReveal | undefined;
}
type CaretMeasureMode = "request" | "height";

/** Public CodeMirror scroll requests reveal the caret through the owning host scroller. */
export class TextEditorScroll {
  readonly #key = {};
  #view: EditorView | undefined;
  #disposed = false;
  #generation = 0;
  #lastHeight: number | undefined;
  #intent: CaretRevealIntent | undefined;
  #interrupted = false;
  #suspended = false;
  #hostBlockSize: number | undefined;
  readonly #documents = new Set<Document>();
  public readonly extension: Extension;

  public constructor(
    private readonly ports: Pick<
      TextFieldEditorOptions,
      | "onScrollIntoView"
      | "onScrollInterrupt"
      | "prepareScrollIntoView"
      | "onContentHeightChange"
      | "surfaceCoordinates"
    >,
  ) {
    this.extension = EditorView.scrollHandler.of((_view, range) => {
      if ((!this.ports.onScrollIntoView && !this.ports.prepareScrollIntoView) || this.#disposed)
        return false;
      if (this.#interrupted || this.#suspended) return true;
      this.request(range);
      return true;
    });
  }

  public attach(view: EditorView): void {
    this.#view = view;
    const drawing = this.ports.surfaceCoordinates?.drawingDocument;
    for (const document of [
      view.dom.ownerDocument,
      drawing,
      drawing?.defaultView?.frameElement?.ownerDocument,
    ]) {
      if (!document || this.#documents.has(document)) continue;
      this.#documents.add(document);
      for (const name of ["pointerdown", "wheel", "keydown"] as const)
        document.addEventListener(name, this.interrupt, true);
    }
    this.publishHeight();
  }

  public update(update: ViewUpdate): void {
    if (this.#intent && !this.matches(this.#intent)) this.interrupt();
    const requested =
      (this.ports.onScrollIntoView || this.ports.prepareScrollIntoView) &&
      update.transactions.some((transaction) => transaction.scrollIntoView);
    if (requested && !this.#suspended) {
      this.#interrupted = false;
      this.request(update.state.selection.main);
    }
    if (update.geometryChanged) {
      this.publishHeight();
      const intent = this.#intent;
      if (
        !requested &&
        intent &&
        this.matches(intent) &&
        update.view.hasFocus &&
        this.#lastHeight !== intent.measuredHeight &&
        this.#lastHeight !== intent.pendingHeight
      )
        this.request(intent.range, "height");
    }
  }

  private request(range: SelectionRange, mode: CaretMeasureMode = "request"): void {
    const view = this.#view;
    if (!view || this.#disposed) return;
    if (mode === "request") this.remember(range);
    const height = this.#lastHeight;
    if (mode === "height" && this.#intent) this.#intent.pendingHeight = height;
    const generation = ++this.#generation;
    const document = view.state.doc;
    const side = range.assoc || (range.head > range.anchor ? -1 : 1);
    let prepared: PreparedTextScrollReveal | undefined;
    view.requestMeasure({
      key: this.#key,
      read: (current) => {
        const valid = this.current(generation, range.head, document);
        const rect = valid ? caretCoordinates(current, range.head, side) : null;
        prepared = rect ? this.ports.prepareScrollIntoView?.(rect) : undefined;
        return rect;
      },
      write: (rect) => {
        if (!this.current(generation, range.head, document)) return;
        if (mode === "height" && this.#intent) {
          this.#intent.measuredHeight = height;
          this.#intent.pendingHeight = undefined;
        }
        if (!rect) return;
        if (this.#intent) this.#intent.reveal = prepared;
        this.publishHeight();
        if (this.ports.prepareScrollIntoView) prepared?.();
        else this.ports.onScrollIntoView?.(rect);
      },
    });
  }

  private remember(range: SelectionRange): void {
    const view = this.#view;
    if (view)
      this.#intent = {
        document: view.state.doc,
        selection: view.state.selection.main,
        range,
        measuredHeight: this.#lastHeight,
        pendingHeight: undefined,
        reveal: undefined,
      };
  }

  private matches(intent: CaretRevealIntent): boolean {
    return (
      this.#view?.state.doc === intent.document &&
      this.#view.state.selection.main.eq(intent.selection)
    );
  }

  public reveal(): void {
    const intent = this.#intent;
    if (intent && !this.#suspended && this.matches(intent) && this.#view?.hasFocus)
      this.request(intent.range);
  }

  private readonly interrupt = (event?: Event): void => {
    this.#generation += 1;
    this.#intent = undefined;
    this.#interrupted = true;
    if (event?.type === "wheel" || event?.type === "pointerdown") this.ports.onScrollInterrupt?.();
  };

  public suspendGeometry(suspended: boolean): void {
    this.#suspended = suspended;
    if (suspended) {
      this.interrupt();
      this.ports.onScrollInterrupt?.();
    }
  }

  public hostLayoutChanged(height: number): (() => void) | undefined {
    if (!Number.isFinite(height) || height <= 0 || this.#hostBlockSize === height) return undefined;
    const previous = this.#hostBlockSize;
    this.#hostBlockSize = height;
    const intent = this.#intent;
    if (previous === undefined || !intent) return undefined;
    return () => {
      const current = this.#intent;
      if (
        current &&
        current.document === intent.document &&
        current.selection.eq(intent.selection) &&
        this.matches(current) &&
        this.#view?.hasFocus
      )
        current.reveal?.(false);
    };
  }

  private current(generation: number, head: number, document: Text): boolean {
    return (
      !this.#disposed &&
      this.#generation === generation &&
      this.#view?.state.doc === document &&
      this.#view.state.selection.main.head === head
    );
  }

  private publishHeight(): void {
    if (this.#disposed || !this.#view) return;
    const height = this.#view.contentHeight;
    if (height === this.#lastHeight || !Number.isFinite(height) || height < 0) return;
    this.#lastHeight = height;
    this.ports.onContentHeightChange?.(height);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.interrupt();
    this.ports.onScrollInterrupt?.();
    for (const document of this.#documents)
      for (const name of ["pointerdown", "wheel", "keydown"] as const)
        document.removeEventListener(name, this.interrupt, true);
    this.#documents.clear();
    this.#view = undefined;
  }
}

function caretCoordinates(
  view: EditorView,
  position: number,
  side: -1 | 1,
): TextEditorClientRect | null {
  return view.coordsAtPos(position, side) ?? view.coordsAtPos(position, side === 1 ? -1 : 1);
}
