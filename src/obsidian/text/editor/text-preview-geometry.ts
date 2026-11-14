import type { EditorView } from "@codemirror/view";
import type { TextElementV2 } from "../../../domain/schema/public";
import type { TextSourceRange } from "../../../domain/text/text-types";
import type {
  TextFieldEditorOptions,
  TextMathWidgetPorts,
  TextTableEditingPort,
} from "./text-field-editor-types";
import {
  buildTextDecorations,
  createTextPreviewField,
  type PreparedTextDecorations,
} from "./text-preview-decorations";
import type { IndexedTextPreview } from "./text-preview-index";
import { TextMathWidget } from "./text-math-widget";
import { activateTextPreview } from "./text-preview-widget";
import { TextTableWidget } from "./text-table-widget";

/** The actual target widgets are prepared offscreen before one geometry publication. */
export class TextPreviewGeometry {
  public readonly field;

  public constructor(
    private readonly options: {
      readonly editor: TextFieldEditorOptions;
      readonly view: () => EditorView;
      readonly element: () => TextElementV2;
      readonly tableEditing: TextTableEditingPort;
      readonly originalRange: (range: TextSourceRange) => TextSourceRange;
      readonly fontBoundaries: (start: number, end: number) => readonly number[];
      readonly invalidateBackground: () => void;
    },
  ) {
    this.field = createTextPreviewField(this.#ports());
  }

  public async prepare(
    preview: IndexedTextPreview,
    element: TextElementV2,
    signal: AbortSignal,
  ): Promise<PreparedTextDecorations> {
    const view = this.options.view();
    const state = view.state;
    const viewport = view.visibleRanges.map(({ from, to }) => ({ start: from, end: to }));
    const tableMode = state.field(this.field).tableMode;
    const blockViewport = { start: view.viewport.from, end: view.viewport.to };
    const decorations = buildTextDecorations(
      state,
      preview,
      viewport,
      this.#ports(element),
      tableMode,
    );
    for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
      const spec = cursor.value.spec as { readonly widget?: unknown };
      const widget = spec.widget;
      if (widget instanceof TextMathWidget || widget instanceof TextTableWidget)
        await widget.prepare(view, signal);
      signal.throwIfAborted();
    }
    return {
      decorations,
      selection: state.selection,
      document: state.doc,
      tableMode,
      viewport,
      blockViewport,
    };
  }

  #ports(prepared?: TextElementV2): TextMathWidgetPorts {
    const options = this.options;
    const editor = options.editor;
    const element = () => prepared ?? options.element();
    return {
      blockViewport: () => ({
        start: options.view().viewport.from,
        end: options.view().viewport.to,
      }),
      scheduler: editor.scheduler,
      render: editor.renderMath,
      originalRange: options.originalRange,
      mathLayout: () => element().layout,
      renderTable: editor.renderTable,
      tableCellLabel: editor.tableCellLabel,
      tablePreviewLabel: editor.tableUi?.labels.preview ?? editor.tablePreviewLabel,
      tableEditing: options.tableEditing,
      onError: editor.onError,
      activate: activateTextPreview,
      width: () => Math.max(0, element().width - 2 * (element().layout.padding ?? 0)),
      style: () => element().style,
      invalidateBackground: options.invalidateBackground,
      resolveFontResourceId:
        editor.resolveFontResourceId === undefined
          ? undefined
          : (style, range) =>
              editor.resolveFontResourceId?.(style, range && options.originalRange(range)),
      fontResourceBoundaries:
        editor.fontResourceBoundaries === undefined ? undefined : options.fontBoundaries,
    };
  }
}
