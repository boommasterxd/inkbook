import { EditorState, type Extension } from "@codemirror/state";
import { standardKeymap } from "@codemirror/commands";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import {
  MAX_TEXT_SOURCE_LENGTH,
  type TextElementV2,
  type TextRangeStyleV2,
  type TextStyleV2,
} from "../../../domain/schema/public";
import { validateTextStyleValue } from "../../../domain/settings/text-style-values";
import { formatTextMarkdownStyle } from "../../../domain/text/text-mark-formatting";
import {
  applyTextParagraphAlignment,
  applyTextStyleRange,
} from "../../../domain/text/text-source-edits";
import type {
  TextMarkdownMark,
  TextSourceRange,
  TextSourceState,
} from "../../../domain/text/text-types";
import { textStyleKey } from "../../../editor/tools/style-change-validation";
import type { TextFieldEditorOptions } from "./text-field-editor-types";
import { TextEditorScroll } from "./text-editor-scroll";
import { TextEditorBackgroundLayer } from "./text-editor-background";
import { textFieldTheme, textStyleCss } from "./text-field-theme";
import { TextPreviewGeometry } from "./text-preview-geometry";
import { mountTextControlStyles } from "./text-editor-styles";
import { TextPreviewController } from "./text-preview-controller";
import { TextSourceController } from "./text-source-controller";
import { textLineBoundaries } from "./text-line-boundaries";
import { TEXT_PREVIEW_VIEWPORT_EVENT } from "./text-preview-widget";
import { textFontSourceRange } from "./text-font-fragments";
import { TextTableEditor } from "./text-table-editor";
import { textTableCellSelection } from "./text-table-mode";
import { isolateTextEditorEvents, replaceTextTableSelection } from "./text-editor-events";
import { TextEditorGeometry, type TextHeightMeasured } from "./text-editor-geometry";

export type { TextFieldEditorOptions } from "./text-field-editor-types";

/** Native CodeMirror input, composition and selection inside one owned scene surface. */
export class TextFieldEditor {
  public readonly view: EditorView;
  readonly #options: TextFieldEditorOptions;
  readonly #preview: TextPreviewController;
  #element: TextElementV2;
  readonly #sourceController: TextSourceController;
  #pendingStyle: TextRangeStyleV2 = {};
  #pendingMarks: Partial<Pick<TextStyleV2, "bold" | "italic" | "strikethrough">> = {};
  #formatting = false;
  #external = false;
  #disposed = false;
  readonly #scroll: TextEditorScroll;
  readonly #tables: TextTableEditor;
  #background: TextEditorBackgroundLayer | undefined;
  readonly #geometry: TextEditorGeometry;
  readonly #previewGeometry: TextPreviewGeometry;
  readonly #releaseStyles: () => void;

  public constructor(options: TextFieldEditorOptions) {
    this.#options = options;
    this.#scroll = new TextEditorScroll(options);
    this.#element = options.element;
    this.#sourceController = new TextSourceController(
      this.#stateFromElement(options.element),
      options.scheduler,
      {
        onChange: (state, mapping) => {
          options.onChange(state, mapping);
          this.#preview.invalidate(true);
          this.#tables.refresh();
        },
        onError: options.onError,
        onPending: options.onInputPending,
        onPrepared: () => {
          this.#preview.invalidate(true);
          options.onSelectionChange?.(this.selectionStart, this.selectionEnd);
        },
      },
    );
    this.#preview = new TextPreviewController(
      options.scheduler,
      () => ({
        state: this.#source,
        style: this.#element.style,
        pending: this.#sourceController.pending,
      }),
      options.onError,
      options.parsedDocument,
    );
    this.#tables = new TextTableEditor({
      options,
      source: () => this.#source,
      style: () => this.#element.style,
      originalPosition: (position, association) =>
        this.originalSourcePosition(position, association),
      applyStyle: (id, value) => this.applyStyle(id, value),
      undoRedo: (redo) => this.#undoRedo(redo),
      finish: () => this.#finish(),
    });
    this.#previewGeometry = this.#createPreviewGeometry();
    this.view = new EditorView({
      parent: options.container,
      state: EditorState.create({
        doc: options.element.source,
        extensions: [
          textFieldTheme,
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            beforeinput: (event, view) =>
              replaceTextTableSelection(event, view, (range) => this.#tables.intersects(range)),
          }),
          EditorView.editorAttributes.of({ class: "inkbook-text-field-editor" }),
          this.#previewGeometry.field,
          textLineBoundaries,
          EditorView.contentAttributes.of({
            "aria-label": options.label ?? "Text",
            "aria-multiline": "true",
            spellcheck: "true",
          }),
          EditorView.updateListener.of((update) => this.#updated(update)),
          EditorState.transactionFilter.of((transaction) => {
            if (!transaction.docChanged || transaction.newDoc.length <= MAX_TEXT_SOURCE_LENGTH)
              return transaction;
            options.onError?.(new RangeError("Text source capacity exceeded."));
            return [];
          }),
          this.#tables.arrowBindings(),
          this.#inputBindings(),
          this.#scroll.extension,
          isolateTextEditorEvents(),
        ],
      }),
    });
    this.#releaseStyles = mountTextControlStyles(this.view, options.surfaceCoordinates);
    this.#geometry = new TextEditorGeometry({
      view: this.view,
      scheduler: options.scheduler,
      source: this.#sourceController,
      preview: this.#preview,
      element: () => this.#element,
      setElement: (element) => {
        this.#element = element;
      },
      updateStyle: () => this.#updateBaseStyle(),
      replaceSource: (source) => this.#replaceSource(source),
      invalidateBackground: () => this.#background?.invalidate(),
      publishBackground: (style) => this.#background?.publishGeometry(style),
      refreshTables: () => this.#tables.refresh(),
      prepareDecorations: (preview, element, signal) =>
        this.#previewGeometry.prepare(preview, element, signal),
    });
    this.#updateBaseStyle();
    this.#sourceController.normalizeLineEndings(options.element.source);
    this.#preview.attach(this.view);
    this.#scroll.attach(this.view);
    this.#background = this.#createBackground();
  }

  #createPreviewGeometry(): TextPreviewGeometry {
    return new TextPreviewGeometry({
      editor: this.#options,
      view: () => this.view,
      element: () => this.#element,
      tableEditing: this.#tables.port,
      originalRange: (range) => this.#originalRange(range),
      fontBoundaries: (start, end) => this.#fontBoundaries(start, end),
      invalidateBackground: () => this.#background?.invalidate(),
    });
  }

  #createBackground(): TextEditorBackgroundLayer {
    return new TextEditorBackgroundLayer(
      this.view,
      () => ({
        color: this.#element.backgroundColor,
        opacity: this.#element.backgroundOpacity,
        width: this.#element.width,
        height: this.#element.height,
        fontSize: this.#element.style.fontSize,
        ready:
          this.#preview.parsed?.source === this.#source.source &&
          !this.#sourceController.pending &&
          !this.view.contentDOM.querySelector(
            ".inkbook-text-math-widget[aria-busy],.inkbook-text-table-widget[aria-busy]",
          ),
      }),
      this.#options.onError,
    );
  }

  #inputBindings(): Extension {
    const finish = (): boolean => {
      this.#finish();
      return true;
    };
    return keymap.of([
      { key: "Mod-b", run: () => this.#changeStyle(() => this.#applyMarkdownStyle("bold")) },
      { key: "Mod-i", run: () => this.#changeStyle(() => this.#applyMarkdownStyle("italic")) },
      { key: "Mod-z", run: () => this.#undoRedo(false) },
      { key: "Mod-Shift-z", run: () => this.#undoRedo(true) },
      { key: "Mod-y", run: () => this.#undoRedo(true) },
      { key: "Escape", run: finish },
      { key: "Mod-Enter", run: finish },
      ...standardKeymap,
    ]);
  }

  public get source(): string {
    return this.view.state.doc.toString();
  }
  public get ranges(): TextSourceState["ranges"] {
    return this.#source.ranges;
  }
  public get paragraphs(): TextSourceState["paragraphs"] {
    return this.#source.paragraphs;
  }
  public get selectionStart(): number {
    return this.view.state.selection.main.from;
  }
  public get selectionEnd(): number {
    return this.view.state.selection.main.to;
  }
  public get inputView(): EditorView {
    return this.#tables.inputView ?? this.view;
  }
  public get contentHeight(): number {
    return this.view.contentHeight;
  }
  public measureContentHeight(onMeasured?: TextHeightMeasured): number | undefined {
    return this.#geometry.measureHeight(onMeasured);
  }
  public get pendingTextStyle(): Readonly<TextRangeStyleV2> {
    return { ...this.#pendingStyle, ...this.#pendingMarks };
  }
  public get hasMeaningfulUserInput(): boolean {
    return this.#sourceController.hasMeaningfulUserInput;
  }
  public get ready(): Promise<void> {
    return Promise.all([this.#preview.ready, this.#background!.ready]).then(() => undefined);
  }

  public focusAt(position?: number | { readonly x: number; readonly y: number }): void {
    if (this.#disposed) return;
    if (this.#tables.focusAt(position)) return;
    const at =
      typeof position === "number"
        ? position
        : position
          ? this.view.posAtCoords(position)
          : undefined;
    if (at !== undefined && at !== null)
      this.view.dispatch({
        selection: { anchor: Math.max(0, Math.min(this.view.state.doc.length, at)) },
        scrollIntoView: true,
      });
    this.focusSelectionPreserved();
  }

  public focusSelectionPreserved(): void {
    if (!this.#disposed && !this.#tables.focus()) this.view.focus();
  }

  public requestViewportMeasure(): void {
    if (!this.#disposed) {
      this.view.requestMeasure();
      this.view.dom.dispatchEvent(new Event(TEXT_PREVIEW_VIEWPORT_EVENT));
    }
  }

  public applyStyle(controlId: string, value: unknown): boolean {
    return this.#changeStyle(() => this.#applyStyle(controlId, value));
  }

  #changeStyle(change: () => boolean): boolean {
    if (this.#disposed) return false;
    try {
      return change();
    } catch (error) {
      this.#options.onError?.(error);
      return false;
    }
  }

  #applyStyle(controlId: string, value: unknown): boolean {
    const key = controlId.startsWith("text-") ? textStyleKey(controlId) : controlId;
    if (value === undefined && (key === "bold" || key === "italic"))
      return this.#applyMarkdownStyle(key);
    if (!validateTextStyleValue(key, value)) return false;
    if (key === "bold" || key === "italic" || key === "strikethrough")
      return this.#applyMarkdownStyle(key, value as boolean);
    this.#sourceController.flush();
    const selection = { start: this.selectionStart, end: this.selectionEnd };
    if (key === "alignment") {
      this.#source = applyTextParagraphAlignment(
        this.#source,
        selection,
        value as "left" | "center" | "right" | "justify",
      );
    } else if (
      key in this.#element.style ||
      key === "backgroundColor" ||
      key === "backgroundOpacity"
    ) {
      const patch = { [key]: value } as TextRangeStyleV2;
      if (selection.start === selection.end) {
        this.#pendingStyle = { ...this.#pendingStyle, ...patch };
        return true;
      }
      this.#source = applyTextStyleRange(this.#source, selection, patch);
    } else return false;
    this.#sourceController.publishStyle();
    this.#tables.refresh();
    this.#preview.invalidate(true);
    return true;
  }

  #applyMarkdownStyle(mark: Exclude<TextMarkdownMark, "code">, desired?: boolean): boolean {
    this.#sourceController.flush();
    const selection = { start: this.selectionStart, end: this.selectionEnd };
    const previous = this.#source;
    const result = formatTextMarkdownStyle(
      previous,
      selection,
      { mark, desired, base: this.#element.style },
      this.#preview.parsed,
    );
    if (result.stateBeforeChanges !== previous)
      this.#sourceController.replace(result.stateBeforeChanges, true);
    if (selection.start === selection.end) {
      this.#pendingStyle = { ...this.#pendingStyle };
      if (result.typingOverride === undefined) delete this.#pendingStyle[mark];
      else this.#pendingStyle[mark] = result.typingOverride;
      this.#pendingMarks = { ...this.#pendingMarks, [mark]: result.markActive };
    }
    this.#formatting = true;
    try {
      this.view.dispatch({
        changes: [...result.changes]
          .reverse()
          .map((change) => ({ from: change.start, to: change.end, insert: change.insert })),
        selection: { anchor: result.selection.start, head: result.selection.end },
        annotations: textTableCellSelection.of(this.#tables.inputView !== undefined),
      });
    } finally {
      this.#formatting = false;
    }
    if (!result.changes.length && result.stateBeforeChanges !== previous)
      this.#sourceController.publishStyle();
    return true;
  }
  public updateElement(element: TextElementV2): void {
    if (this.#disposed) return;
    this.#geometry.update(element);
  }
  public setGeometrySuspended(suspended: boolean): void {
    if (this.#disposed) return;
    this.#scroll.suspendGeometry(suspended);
    this.#tables.suspendGeometry(suspended);
  }
  public readonly hostLayoutChanged = (height: number) => this.#scroll.hostLayoutChanged(height);

  public prepareGeometry(...args: Parameters<TextEditorGeometry["prepare"]>): Promise<void> {
    return this.#geometry.prepare(...args);
  }

  #replaceSource(source: string): void {
    const { anchor, head } = this.view.state.selection.main;
    const changes = this.view.state.changes({
      from: 0,
      to: this.view.state.doc.length,
      insert: source,
    });
    this.#external = true;
    try {
      this.view.dispatch({
        changes,
        selection: {
          anchor: Math.min(anchor, changes.newLength),
          head: Math.min(head, changes.newLength),
        },
      });
    } finally {
      this.#external = false;
    }
  }

  #updated(update: ViewUpdate): void {
    if (update.docChanged && !this.#external) {
      for (const transaction of update.transactions) {
        this.#sourceController.record(
          transaction.changes,
          this.#pendingStyle,
          true,
          !this.#formatting,
        );
      }
      this.#preview.suspend();
    }
    this.#tables.update(update);
    if (
      update.selectionSet &&
      !update.docChanged &&
      !this.#formatting &&
      !update.startState.selection.eq(update.state.selection)
    ) {
      this.#pendingStyle = {};
      this.#pendingMarks = {};
    }
    if (update.selectionSet)
      this.#options.onSelectionChange?.(this.selectionStart, this.selectionEnd);
    this.#scroll.update(update);
    if (
      update.docChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      update.viewportChanged
    )
      this.#background?.invalidate();
    if (update.viewportChanged && !this.#sourceController.pending) this.#preview.invalidate(false);
  }

  #updateBaseStyle(): void {
    this.view.contentDOM.setAttribute(
      "style",
      `${textStyleCss(
        { ...this.#element.style, opacity: 1 },
        this.#options.resolveFontResourceId?.(this.#element.style),
      )};padding:${this.#element.layout.padding ?? 0}px`,
    );
  }

  get #source(): TextSourceState {
    return this.#sourceController.state;
  }
  set #source(state: TextSourceState) {
    this.#sourceController.replace(state, true);
  }

  public originalSourcePosition(position: number, association: -1 | 1): number {
    return this.#sourceController.originalPosition(position, association);
  }

  #originalRange(range: TextSourceRange): TextSourceRange {
    return textFontSourceRange(range, (position, association) =>
      this.originalSourcePosition(position, association),
    );
  }

  #fontBoundaries(start: number, end: number): readonly number[] {
    const original = this.#originalRange({ start, end });
    const boundaries = this.#options.fontResourceBoundaries?.(original.start, original.end) ?? [];
    const normalization = this.#sourceController.normalization;
    if (!normalization) return boundaries;
    const result: number[] = [];
    let previous = start;
    for (const boundary of boundaries) {
      const mapped = normalization.mapPos(boundary, 1);
      if (mapped > previous && mapped < end) {
        result.push(mapped);
        previous = mapped;
      }
    }
    return result;
  }

  public async flushChanges(): Promise<void> {
    await this.#sourceController.flushChanges();
  }

  #finish(): void {
    void this.flushChanges()
      .then(() => {
        if (!this.#disposed) this.#options.onFinish();
      })
      .catch((error: unknown) => this.#options.onError?.(error));
  }

  #stateFromElement(element: TextElementV2): TextSourceState {
    return { source: element.source, ranges: element.ranges, paragraphs: element.paragraphs };
  }

  #undoRedo(redo: boolean): boolean {
    this.#sourceController.flush();
    this.#options.onUndoRedo?.(redo);
    return true;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#geometry.dispose();
    this.#releaseStyles();
    this.#scroll.dispose();
    this.#background?.dispose();
    this.#preview.dispose();
    this.#tables.dispose();
    this.#sourceController.dispose();
    this.view.destroy();
  }
}
