import { EditorState, Prec, type Extension, type Transaction } from "@codemirror/state";
import { standardKeymap } from "@codemirror/commands";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { MAX_TEXT_SOURCE_LENGTH } from "../../../domain/schema/public";
import type { TextSourceRange } from "../../../domain/text/text-types";
import { TEXT_TABLE_CELL_PADDING_EM } from "../../../domain/text/text-layout-style";
import type { TextFieldEditorOptions } from "./text-field-editor-types";
import { textFieldTheme, textStyleCss } from "./text-field-theme";
import { isolateTextEditorEvents } from "./text-editor-events";
import { runTextEditorWork } from "./text-editor-work";
import {
  createTextPreviewField,
  setTextPreview,
  setTextViewport,
} from "./text-preview-decorations";
import { activateTextPreview, TEXT_PREVIEW_VIEWPORT_EVENT } from "./text-preview-widget";
import { textFontSourceRange } from "./text-font-fragments";
import type { TableCellDirection } from "./text-table-keyboard";
import {
  textTableCellPreviewSteps,
  type TextTableCellPresentation,
} from "./text-table-cell-preview";

interface TextTableCellViewOptions {
  readonly host: HTMLElement;
  readonly editor: TextFieldEditorOptions;
  readonly sourceOffset: () => number;
  readonly originalPosition: (position: number, association: -1 | 1) => number;
  readonly onTransaction: (transaction: Transaction) => void;
  readonly onBeforeInput?: () => void;
  readonly onNavigate: (direction: TableCellDirection) => boolean;
  readonly onStyle: (id: string, value: unknown) => boolean;
  readonly onUndoRedo: (redo: boolean) => boolean;
  readonly onHeight: (height: number) => void;
  readonly onFinish: () => void;
}

/** One disposable native input surface; its parent owns source, styles and history. */
export class TextTableCellView {
  public readonly view: EditorView;
  readonly #options: TextTableCellViewOptions;
  #presentation: TextTableCellPresentation;
  #internal = false;
  #updating = false;
  #disposed = false;
  #abort = new AbortController();
  #height = -1;
  #viewportFrame: number | undefined;
  #syncFrame: number | undefined;
  #queuedSync: Parameters<TextTableCellView["sync"]> | undefined;
  #prepared:
    { source: string; presentation: TextTableCellPresentation; styleCss: string } | undefined;

  public constructor(options: TextTableCellViewOptions) {
    this.#options = options;
    this.#presentation = { style: options.editor.element.style, width: 0, alignment: "left" };
    this.view = new EditorView({
      parent: options.host,
      state: EditorState.create({
        extensions: [
          textFieldTheme,
          EditorView.lineWrapping,
          EditorView.editorAttributes.of({
            class: "inkbook-text-field-editor inkbook-text-table-cell-editor",
          }),
          this.#previewField(),
          this.#inputBoundary(),
          this.#bindings(),
          isolateTextEditorEvents(),
          EditorView.contentAttributes.of({
            "aria-label": options.editor.tableCellLabel ?? options.editor.label ?? "Table cell",
            "aria-multiline": "true",
            spellcheck: "true",
          }),
          EditorView.updateListener.of((update) => this.#updated(update)),
          EditorState.transactionFilter.of((transaction) => {
            if (transaction.newDoc.length <= MAX_TEXT_SOURCE_LENGTH) return transaction;
            options.editor.onError?.(new RangeError("Text source capacity exceeded."));
            return [];
          }),
        ],
      }),
      dispatchTransactions: (transactions, view) => {
        this.#updating = true;
        try {
          view.update(transactions);
        } finally {
          this.#updating = false;
        }
        if (!this.#internal)
          for (const transaction of transactions) options.onTransaction(transaction);
      },
    });
    this.view.dom.addEventListener(TEXT_PREVIEW_VIEWPORT_EVENT, this.#viewport);
    this.view.dom.ownerDocument.addEventListener("selectionchange", this.#selectionChange, true);
  }

  #inputBoundary(): Extension {
    const refresh = (): boolean => {
      if (!this.#disposed && !this.#internal && !this.#updating) this.#options.onBeforeInput?.();
      return false;
    };
    return Prec.highest(EditorView.domEventHandlers({ beforeinput: refresh, keydown: refresh }));
  }

  #previewField(): Extension {
    const editor = this.#options.editor;
    return createTextPreviewField({
      scheduler: editor.scheduler,
      render: editor.renderMath,
      originalRange: (range) => this.#originalRange(range),
      onError: editor.onError,
      activate: activateTextPreview,
      width: () => Math.max(0, this.#presentation.width - this.#padding() * 2),
      style: () => this.#presentation.style,
      resolveFontResourceId: (style, range) =>
        editor.resolveFontResourceId?.(style, range && this.#originalRange(range)),
      fontResourceBoundaries: (start, end) => this.#fontBoundaries(start, end),
    });
  }

  #bindings(): Extension {
    const options = this.#options;
    return keymap.of([
      { key: "Tab", run: () => options.onNavigate("next") },
      { key: "Shift-Tab", run: () => options.onNavigate("previous") },
      { key: "Enter", run: () => options.onNavigate("enter") },
      { key: "ArrowUp", run: () => this.#navigateVertical(false) },
      { key: "ArrowDown", run: () => this.#navigateVertical(true) },
      { key: "ArrowLeft", run: () => this.#navigateEdge(false) },
      { key: "ArrowRight", run: () => this.#navigateEdge(true) },
      { key: "Escape", run: () => options.onNavigate("escape") },
      { key: "Mod-b", run: () => options.onStyle("bold", undefined) },
      { key: "Mod-i", run: () => options.onStyle("italic", undefined) },
      { key: "Mod-z", run: () => options.onUndoRedo(false) },
      { key: "Mod-Shift-z", run: () => options.onUndoRedo(true) },
      { key: "Mod-y", run: () => options.onUndoRedo(true) },
      {
        key: "Mod-Enter",
        run: () => {
          options.onFinish();
          return true;
        },
      },
      ...standardKeymap,
    ]);
  }

  #navigateEdge(forward: boolean): boolean {
    const { main } = this.view.state.selection;
    return (
      main.empty &&
      main.head === (forward ? this.view.state.doc.length : 0) &&
      this.#options.onNavigate(forward ? "forward" : "backward")
    );
  }

  #navigateVertical(forward: boolean): boolean {
    const { main } = this.view.state.selection;
    if (!main.empty) return false;
    const boundary = this.view.moveToLineBoundary(main, forward, true).head;
    if (boundary !== (forward ? this.view.state.doc.length : 0)) return false;
    return this.#options.onNavigate(forward ? "down" : "up");
  }

  public sync(
    source: string,
    selection: { anchor: number; head: number },
    presentation: TextTableCellPresentation,
  ): void {
    if (this.#disposed) return;
    if (this.#internal || this.#updating) {
      this.#queuedSync = [source, selection, presentation];
      if (this.#syncFrame === undefined)
        this.#syncFrame = this.#options.editor.scheduler.requestFrame(() => {
          this.#syncFrame = undefined;
          const pending = this.#queuedSync;
          this.#queuedSync = undefined;
          if (pending) this.sync(...pending);
        });
      return;
    }
    this.#queuedSync = undefined;
    if (this.#syncFrame !== undefined) {
      this.#options.editor.scheduler.cancelFrame(this.#syncFrame);
      this.#syncFrame = undefined;
    }
    this.#presentation = presentation;
    const bounded = source.slice(0, MAX_TEXT_SOURCE_LENGTH);
    const clamp = (position: number) => Math.max(0, Math.min(bounded.length, position));
    const { main } = this.view.state.selection;
    const anchor = clamp(selection.anchor);
    const head = clamp(selection.head);
    const changed = this.view.state.doc.toString() !== bounded;
    this.#internal = true;
    try {
      if (changed || main.anchor !== anchor || main.head !== head)
        this.view.dispatch({
          ...(changed
            ? { changes: { from: 0, to: this.view.state.doc.length, insert: bounded } }
            : {}),
          selection: { anchor, head },
        });
    } finally {
      this.#internal = false;
    }
    const css = `${textStyleCss({ ...presentation.style, opacity: 1 }, this.#options.editor.resolveFontResourceId?.(presentation.style, this.#originalRange({ start: 0, end: 0 })))};padding:${TEXT_TABLE_CELL_PADDING_EM}em;text-align:${presentation.alignment}`;
    if (this.view.contentDOM.getAttribute("style") !== css)
      this.view.contentDOM.setAttribute("style", css);
    this.#preparePreview(bounded);
    this.#measureHeight();
  }

  #preparePreview(source: string): void {
    const previous = this.#prepared;
    const presentation = this.#presentation;
    const styleCss = textStyleCss(presentation.style);
    if (
      previous?.source === source &&
      previous.presentation.block === presentation.block &&
      previous.presentation.cell === presentation.cell &&
      previous.presentation.parentSource === presentation.parentSource &&
      previous.styleCss === styleCss &&
      previous.presentation.alignment === presentation.alignment &&
      previous.presentation.width === presentation.width
    )
      return;
    this.#prepared = { source, presentation, styleCss };
    this.#abort.abort();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    try {
      const pending = runTextEditorWork(
        textTableCellPreviewSteps(source, this.#presentation),
        this.#options.editor.scheduler,
        signal,
        (preview) => {
          this.#internal = true;
          try {
            this.view.dispatch({
              effects: [
                setTextPreview.of(preview),
                setTextViewport.of(
                  this.view.visibleRanges.map(({ from, to }) => ({ start: from, end: to })),
                ),
              ],
            });
          } finally {
            this.#internal = false;
          }
          this.#syncDomSelection();
        },
      );
      void pending?.catch((error: unknown) => {
        if (!signal.aborted) this.#options.editor.onError?.(error);
      });
    } catch (error) {
      this.#options.editor.onError?.(error);
    }
  }

  #updated(update: ViewUpdate): void {
    if (update.docChanged && !this.#internal) {
      this.#abort.abort();
      this.#prepared = undefined;
    }
    if (update.geometryChanged || update.docChanged) this.#measureHeight();
  }

  #syncDomSelection(): void {
    if (!this.view.hasFocus) return;
    const selection = this.view.dom.ownerDocument.getSelection();
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !this.view.contentDOM.contains(selection.anchorNode) ||
      !this.view.contentDOM.contains(selection.focusNode)
    )
      return;
    const { main } = this.view.state.selection;
    if (
      this.view.posAtDOM(selection.anchorNode, selection.anchorOffset) === main.anchor &&
      this.view.posAtDOM(selection.focusNode, selection.focusOffset) === main.head
    )
      return;
    // Chrome may reset a native range when preview marks reparent its existing text node.
    // CodeMirror can retain that node/offset in its cache; restore through public DOM APIs.
    const anchor = this.view.domAtPos(main.anchor);
    const head = this.view.domAtPos(main.head);
    selection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
  }

  readonly #selectionChange = (event: Event): void => {
    // Intermediate DOM selections belong to the current CodeMirror update.
    if (
      this.#updating &&
      this.view.dom.ownerDocument.activeElement === this.view.contentDOM &&
      this.view.contentDOM.contains(this.view.dom.ownerDocument.getSelection()?.anchorNode ?? null)
    )
      event.stopImmediatePropagation();
  };

  readonly #viewport = (): void => {
    if (this.#disposed || this.#internal || this.#viewportFrame !== undefined) return;
    this.#viewportFrame = this.#options.editor.scheduler.requestFrame(() => {
      this.#viewportFrame = undefined;
      if (!this.#disposed) this.#publishViewport();
    });
  };

  #publishViewport(): void {
    this.#internal = true;
    try {
      this.view.dispatch({
        effects: setTextViewport.of(
          this.view.visibleRanges.map(({ from, to }) => ({ start: from, end: to })),
        ),
      });
    } finally {
      this.#internal = false;
    }
  }

  #measureHeight(): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => view.contentHeight,
      write: (height) => {
        if (this.#disposed || height === this.#height) return;
        this.#height = height;
        this.#options.onHeight(height);
      },
    });
  }

  #padding(): number {
    return this.#presentation.style.fontSize * TEXT_TABLE_CELL_PADDING_EM;
  }

  #originalRange(range: TextSourceRange): TextSourceRange {
    return textFontSourceRange(range, this.#options.originalPosition, this.#options.sourceOffset());
  }

  #fontBoundaries(start: number, end: number): readonly number[] {
    const original = this.#originalRange({ start, end });
    const boundaries = this.#options.editor.fontResourceBoundaries?.(original.start, original.end);
    const result: number[] = [];
    for (const boundary of boundaries ?? []) {
      let lower = start;
      let upper = end;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        const mapped = this.#options.originalPosition(this.#options.sourceOffset() + middle, 1);
        if (mapped < boundary) lower = middle + 1;
        else upper = middle;
      }
      if (lower > start && lower < end && result[result.length - 1] !== lower) result.push(lower);
    }
    return result;
  }

  public focus(point?: { x: number; y: number }): void {
    if (this.#disposed) return;
    const bounds = point && this.#options.host.getBoundingClientRect();
    const inside =
      point &&
      bounds &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      point.x >= bounds.left &&
      point.x <= bounds.right &&
      point.y >= bounds.top &&
      point.y <= bounds.bottom;
    const position = inside ? this.view.posAtCoords(point) : undefined;
    if (position !== undefined && position !== null)
      this.view.dispatch({ selection: { anchor: position } });
    this.view.focus();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    if (this.#viewportFrame !== undefined)
      this.#options.editor.scheduler.cancelFrame(this.#viewportFrame);
    if (this.#syncFrame !== undefined) this.#options.editor.scheduler.cancelFrame(this.#syncFrame);
    this.#queuedSync = undefined;
    this.view.dom.removeEventListener(TEXT_PREVIEW_VIEWPORT_EVENT, this.#viewport);
    this.view.dom.ownerDocument.removeEventListener("selectionchange", this.#selectionChange, true);
    this.view.destroy();
  }
}
