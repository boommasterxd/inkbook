import type { EditorView } from "@codemirror/view";
import type { ChangeDesc, Text } from "@codemirror/state";
import type { TextElementV2, TextLayoutV2, TextStyleV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextTableUiPort } from "./text-table-controls";
import type { TextEditingCoordinates } from "../../../rendering/scene/text-editing-geometry";
import type {
  TextMarkdownDocument,
  TextMarkdownBlock,
  TextSourceRange,
  TextSourceState,
} from "../../../domain/text/text-types";

export type TextFontResourceResolver = (
  style: TextStyleV2,
  range?: TextSourceRange,
) => string | undefined;

export interface TextEditorClientRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export type PreparedTextScrollReveal = (updateExtent?: boolean) => boolean;

export interface TextFieldEditorOptions {
  readonly container: HTMLElement;
  readonly surfaceCoordinates?: TextEditingCoordinates;
  readonly element: TextElementV2;
  readonly scheduler: WorkScheduler;
  readonly renderMath?: (
    latex: string,
    display: boolean,
    signal: AbortSignal,
    context?: TextMathRenderContext,
  ) => Promise<HTMLElement>;
  readonly renderTable?: (
    block: TextMarkdownBlock,
    signal: AbortSignal,
    context: TextTableRenderContext,
  ) => Promise<TextTableRenderResult>;
  readonly tableCellLabel?: string;
  readonly tablePreviewLabel?: string;
  readonly tableUi?: TextTableUiPort;
  readonly onChange: (state: TextSourceState, changes?: ChangeDesc) => void;
  readonly onSelectionChange?: (start: number, end: number) => void;
  readonly onFinish: () => void;
  readonly onUndoRedo?: (redo: boolean) => void;
  readonly onError?: (error: unknown) => void;
  readonly onInputPending?: (pending: boolean) => void;
  readonly onScrollIntoView?: (rect: TextEditorClientRect) => boolean;
  /** Captures host geometry in the native read phase; its callback runs in the write phase. */
  readonly prepareScrollIntoView?: (
    rect: TextEditorClientRect,
  ) => PreparedTextScrollReveal | undefined;
  readonly onContentHeightChange?: (height: number) => void;
  readonly parsedDocument?: () => TextMarkdownDocument | undefined;
  readonly resolveFontResourceId?: TextFontResourceResolver;
  readonly fontResourceBoundaries?: (start: number, end: number) => readonly number[];
  readonly label?: string;
}

export interface TextTableEditorOptions {
  readonly options: TextFieldEditorOptions;
  readonly source: () => TextSourceState;
  readonly style: () => TextStyleV2;
  readonly originalPosition?: (position: number, association: -1 | 1) => number;
  readonly applyStyle: (id: string, value: unknown) => boolean;
  readonly undoRedo: (redo: boolean) => boolean;
  readonly finish: () => void;
}

export interface TextMathRenderContext {
  readonly fontSize: number;
  readonly availableWidth: number;
  readonly bold?: boolean;
  readonly sourceRange?: TextSourceRange;
  readonly layout?: TextLayoutV2;
}

export interface TextTableRenderContext {
  readonly availableWidth: number;
}

export interface TextTableRenderResult {
  readonly node: HTMLElement;
  readonly rowHeights: readonly number[];
  readonly rowHeight?: (index: number) => number;
  readonly geometryVersion?: number;
  readonly renderRows?: (range: TextTableRowRange, signal: AbortSignal) => Promise<void>;
  readonly setEditingCell?: (range: TextSourceRange | undefined, height?: number) => void;
}

export interface TextTableMount {
  readonly node: HTMLElement;
  readonly view: EditorView;
  readonly block: TextMarkdownBlock;
  readonly source: Text;
  readonly width: number;
  readonly rowHeights: readonly number[];
  readonly signal: AbortSignal;
  readonly rowTop: (index: number) => number;
  readonly refreshPaint: () => void;
  readonly setEditingCell: (range: TextSourceRange | undefined, height?: number) => void;
}

export interface TextTableEditingPort {
  mounted(context: TextTableMount): void;
  unmounted(node: HTMLElement): void;
  activate(node: HTMLElement, row: number, column: number, point?: { x: number; y: number }): void;
  focusedRow(node: HTMLElement): number | undefined;
}

export interface TextTableRowRange {
  readonly from: number;
  readonly to: number;
}

export interface TextMathWidgetPorts {
  readonly mathLayout?: (() => TextLayoutV2) | undefined;
  readonly originalRange?: ((range: TextSourceRange) => TextSourceRange) | undefined;
  readonly blockViewport?: () => TextSourceRange;
  readonly scheduler?: WorkScheduler;
  readonly render: TextFieldEditorOptions["renderMath"];
  readonly renderTable?: TextFieldEditorOptions["renderTable"];
  readonly tableCellLabel?: string | undefined;
  readonly tablePreviewLabel?: string | undefined;
  readonly tableEditing?: TextTableEditingPort | undefined;
  readonly onError: TextFieldEditorOptions["onError"];
  readonly activate: (view: EditorView, position: number) => void;
  readonly width: () => number;
  readonly style: () => TextStyleV2;
  readonly invalidateBackground?: (() => void) | undefined;
  readonly resolveFontResourceId?: TextFontResourceResolver | undefined;
  readonly fontResourceBoundaries?: ((start: number, end: number) => readonly number[]) | undefined;
}
