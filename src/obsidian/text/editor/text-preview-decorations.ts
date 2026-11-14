import {
  StateEffect,
  StateField,
  type EditorSelection,
  type EditorState,
  type Range,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, WidgetType } from "@codemirror/view";
import type {
  TextMarkdownBlock,
  TextMarkSpan,
  TextSourceRange,
} from "../../../domain/text/text-types";
import type { TextMathWidgetPorts } from "./text-field-editor-types";
import type { TextStyleV2 } from "../../../domain/schema/public";
import type { TextMathSyntaxToken } from "./text-math-syntax";
import { TextMathWidget } from "./text-math-widget";
import { TextTableWidget } from "./text-table-widget";
import { TextTableSourceWidget } from "./text-table-source-widget";
import {
  initialTextTableMode,
  setTextTableSource,
  textTableInSource,
  updateTextTableMode,
  type TextTableMode,
} from "./text-table-mode";
import { TEXT_PREVIEW_VIEWPORT_EVENT } from "./text-preview-widget";
import { textFontCss, textStyleCss } from "./text-field-theme";
import { textFontFragments } from "./text-font-fragments";
import { textBackgroundAttributes } from "./text-editor-background";
import { textBlockAlignmentAt } from "../../../domain/text/text-paragraph-alignment";
import type { IndexedTextPreview } from "./text-preview-index";
import {
  TEXT_CODE_FONT_FAMILY,
  TEXT_LIST_INDENT_EM,
  textBlockBaseStyle,
  textBlockStyle,
} from "../../../domain/text/text-layout-style";

export const setTextPreview = StateEffect.define<IndexedTextPreview>();
export const setTextViewport = StateEffect.define<readonly TextSourceRange[]>();
export interface PreparedTextDecorations {
  readonly decorations: DecorationSet;
  readonly selection: EditorSelection;
  readonly document: Text;
  readonly tableMode: TextTableMode;
  readonly viewport: readonly TextSourceRange[];
  readonly blockViewport: TextSourceRange | undefined;
}
export const setPreparedTextDecorations = StateEffect.define<PreparedTextDecorations>();

export interface TextPreviewState {
  readonly parsed: IndexedTextPreview | undefined;
  readonly viewport: readonly TextSourceRange[];
  readonly decorations: DecorationSet;
  readonly tableMode: TextTableMode;
}

export function createTextPreviewField(ports: TextMathWidgetPorts): StateField<TextPreviewState> {
  return StateField.define<TextPreviewState>({
    create: (state) => ({
      parsed: undefined,
      viewport: [{ start: 0, end: state.doc.length }],
      decorations: Decoration.none,
      tableMode: initialTextTableMode,
    }),
    update: (previous, transaction) => {
      let parsed = previous.parsed;
      let viewport = previous.viewport;
      let refresh = transaction.selection !== undefined;
      let tables: readonly TextSourceRange[] | undefined;
      let prepared: PreparedTextDecorations | undefined;
      for (const effect of transaction.effects) {
        if (effect.is(setPreparedTextDecorations)) prepared = effect.value;
        if (effect.is(setTextPreview)) {
          parsed = effect.value;
          tables = effect.value.document.blocks.filter((block) => block.table !== undefined);
          refresh = true;
        }
        if (effect.is(setTextViewport)) {
          viewport = effect.value;
          refresh = true;
        }
        if (effect.is(setTextTableSource)) refresh = true;
      }
      const tableMode = updateTextTableMode(previous.tableMode, transaction, tables);
      if (transaction.docChanged) parsed = undefined;
      const decorations =
        prepared &&
        preparedTextDecorationsMatch(prepared, {
          state: transaction.state,
          viewport,
          tableMode,
          ports,
        })
          ? prepared.decorations
          : parsed && refresh
            ? buildTextDecorations(transaction.state, parsed, viewport, ports, tableMode)
            : transaction.docChanged
              ? previous.decorations.map(transaction.changes)
              : previous.decorations;
      return { parsed, viewport, decorations, tableMode };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.updateListener.of((update) => {
        if (update.geometryChanged || update.viewportChanged)
          update.view.dom.dispatchEvent(new Event(TEXT_PREVIEW_VIEWPORT_EVENT));
      }),
    ],
  });
}

function preparedTextDecorationsMatch(
  prepared: PreparedTextDecorations,
  current: {
    readonly state: EditorState;
    readonly viewport: readonly TextSourceRange[];
    readonly tableMode: TextTableMode;
    readonly ports: TextMathWidgetPorts;
  },
): boolean {
  const blockViewport = current.ports.blockViewport?.();
  return (
    prepared.document === current.state.doc &&
    prepared.selection.eq(current.state.selection) &&
    prepared.tableMode.cellSelection === current.tableMode.cellSelection &&
    samePreviewRanges(prepared.tableMode.source, current.tableMode.source) &&
    samePreviewRanges(prepared.viewport, current.viewport) &&
    prepared.blockViewport?.start === blockViewport?.start &&
    prepared.blockViewport?.end === blockViewport?.end
  );
}

function samePreviewRanges(
  left: readonly TextSourceRange[],
  right: readonly TextSourceRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) => range.start === right[index]!.start && range.end === right[index]!.end,
    )
  );
}

function active(state: EditorState, range: TextSourceRange): boolean {
  return state.selection.ranges.some((selection) =>
    selection.empty
      ? selection.from >= range.start && selection.from <= range.end
      : selection.from < range.end && selection.to > range.start,
  );
}

export function buildTextDecorations(
  state: EditorState,
  parsed: IndexedTextPreview,
  viewport: readonly TextSourceRange[],
  ports: TextMathWidgetPorts,
  tableMode: TextTableMode = initialTextTableMode,
): DecorationSet {
  const result: Range<Decoration>[] = [];
  const base = ports.style();
  const blockViewport = ports.blockViewport?.();
  for (const block of parsed.blocks.visible(blockViewport ? [blockViewport] : viewport)) {
    if (decorateTable(state, block, result, ports, tableMode)) continue;
    const content = parsed.content.get(block)!;
    const style =
      content.glyph?.style ??
      textBlockStyle(textBlockBaseStyle(base, block.kind === "heading"), block.headingLevel);
    const strut = content.glyph ?? parsed.firstGlyph;
    const strutId = strut
      ? ports.resolveFontResourceId?.(strut.style, { start: strut.start, end: strut.start })
      : ports.resolveFontResourceId?.(style);
    const markerRange = { start: block.start, end: block.contentStart };
    const alignment = decorateBlock(state, block, result, {
      viewport,
      paint: block.list ? textStyleCss(base, ports.resolveFontResourceId?.(base, markerRange)) : "",
      font: textFontCss(style, strutId),
    });
    for (const run of content.runs.visible(viewport)) {
      if (run.start === run.end) continue;
      if (run.kind === "math") {
        decorateMath(state, block, run, result, {
          ports,
          blockFont: textFontCss(style, strutId),
          syntax: parsed.mathSyntax.get(run)?.visible(viewport) ?? [],
        });
      } else {
        const style = textBlockStyle(run.style, block.headingLevel, run.code);
        decorateRun(state, run, result, { style, viewport, ports, alignment });
      }
    }
    decorateSpans(state, content.spans.visible(viewport), result);
  }
  return Decoration.set(result, true);
}

function decorateTable(
  state: EditorState,
  block: TextMarkdownBlock,
  result: Range<Decoration>[],
  ports: TextMathWidgetPorts,
  mode: TextTableMode,
): boolean {
  if (!block.table || !ports.renderTable) return false;
  const source = textTableInSource(mode, block);
  const selected =
    !mode.cellSelection &&
    state.selection.ranges.some(
      (range) => !range.empty && range.from < block.end && range.to > block.start,
    );
  if (source || selected) {
    if (!source) return false;
    result.push(
      Decoration.widget({
        block: true,
        side: -1,
        widget: new TextTableSourceWidget(block, ports.tablePreviewLabel ?? "Table preview"),
      }).range(block.start),
    );
    return false;
  }
  result.push(
    Decoration.replace({
      block: true,
      widget: new TextTableWidget(block, state.doc, ports.width(), ports),
    }).range(block.start, block.end),
  );
  return true;
}

function decorateRun(
  state: EditorState,
  run: TextMarkdownBlock["runs"][number],
  result: Range<Decoration>[],
  presentation: {
    readonly style: TextStyleV2;
    readonly viewport: readonly TextSourceRange[];
    readonly ports: TextMathWidgetPorts;
    readonly alignment: string;
  },
): void {
  if (run.contentStart === run.contentEnd) return;
  if (!run.code && run.contentStart > run.start)
    result.push(
      (active(state, run)
        ? Decoration.mark({ class: "cm-formatting" })
        : Decoration.replace({})
      ).range(run.start, run.contentStart),
    );
  for (const visible of presentation.viewport) {
    const start = Math.max(run.contentStart, visible.start);
    const end = Math.min(run.contentEnd, visible.end);
    if (start >= end) continue;
    for (const fragment of textFontFragments(start, end, presentation.ports)) {
      const id = presentation.ports.resolveFontResourceId?.(presentation.style, fragment);
      result.push(
        Decoration.mark({
          class: run.code ? "cm-inline-code" : "inkbook-text-run",
          attributes: {
            "data-inkbook-text-alignment": presentation.alignment,
            style: textStyleCss(presentation.style, id),
            ...textBackgroundAttributes(run.style),
          },
        }).range(fragment.start, fragment.end),
      );
    }
  }
}

function decorateSpans(
  state: EditorState,
  spans: Iterable<TextMarkSpan>,
  result: Range<Decoration>[],
): void {
  for (const span of spans) {
    const visible = active(state, span);
    const delimiters: readonly (readonly [number, number])[] = [
      [span.start, span.contentStart],
      [span.contentEnd, span.end],
    ];
    for (const [start, end] of delimiters) {
      if (start >= end) continue;
      result.push(
        (visible ? Decoration.mark({ class: "cm-formatting" }) : Decoration.replace({})).range(
          start,
          end,
        ),
      );
    }
  }
}

function decorateBlock(
  state: EditorState,
  block: TextMarkdownBlock,
  result: Range<Decoration>[],
  presentation: {
    readonly viewport: readonly TextSourceRange[];
    readonly paint: string;
    readonly font: string;
  },
): string {
  const className =
    block.kind === "heading"
      ? `cm-header cm-header-${block.headingLevel}`
      : block.kind === "list-item"
        ? "HyperMD-list-line"
        : "";
  const lines = new Set<number>();
  const alignment: string[] = [];
  for (const visible of presentation.viewport) {
    let line = state.doc.lineAt(Math.max(block.start, Math.min(visible.start, block.end)));
    while (line.from <= Math.min(block.end, visible.end)) {
      if (!lines.has(line.from)) {
        lines.add(line.from);
        alignment.push(`${line.from}:${textBlockAlignmentAt(block, line.from)}`);
        result.push(
          Decoration.line({
            class: className,
            attributes: {
              style: `${presentation.font};text-align:${textBlockAlignmentAt(block, line.from)}${block.list ? `;padding-left:${TEXT_LIST_INDENT_EM * (block.list.depth + 1)}em` : ""}`,
            },
          }).range(line.from),
        );
      }
      if (line.to >= block.end || line.number >= state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }
  const key = alignment.join(",");
  if (block.contentStart <= block.start || block.kind === "math") return key;
  const activeLine =
    state.doc.lineAt(state.selection.main.head).number === state.doc.lineAt(block.start).number;
  if (activeLine && !block.list) {
    result.push(
      Decoration.mark({ class: "cm-formatting cm-formatting-list" }).range(
        block.start,
        block.contentStart,
      ),
    );
  } else if (block.list) {
    result.push(
      Decoration.replace({
        widget: new ListMarkerWidget(
          block.list.ordered ? `${block.list.number}.` : "•",
          presentation.paint,
        ),
      }).range(block.start, block.contentStart),
    );
  } else {
    result.push(Decoration.replace({}).range(block.start, block.contentStart));
  }
  return key;
}

function decorateMath(
  state: EditorState,
  block: TextMarkdownBlock,
  run: TextMarkdownBlock["runs"][number],
  result: Range<Decoration>[],
  presentation: {
    readonly ports: TextMathWidgetPorts;
    readonly blockFont: string;
    readonly syntax: Iterable<TextMathSyntaxToken>;
  },
): void {
  const { ports } = presentation;
  const display = run.display ?? block.kind === "math";
  const style = textBlockStyle(run.style, block.headingLevel);
  if (!active(state, run)) {
    result.push(
      Decoration.replace({
        block: display,
        widget: new TextMathWidget(
          run.latex ?? run.text,
          display,
          run.start,
          {
            css: `${textStyleCss(style, ports.resolveFontResourceId?.(style))}${display ? `;${presentation.blockFont}` : ""}`,
            literalStyle: textBlockStyle(run.style, block.headingLevel, true),
            background: textBackgroundAttributes(run.style),
            alignment: block.alignment,
            source: state.doc,
            end: run.end,
            contentStart: run.contentStart,
            fontSize: style.fontSize,
            ...(ports.mathLayout ? { layout: ports.mathLayout() } : {}),
            bold: style.bold,
            availableWidth: Math.max(
              0,
              ports.width() -
                (block.list
                  ? TEXT_LIST_INDENT_EM * (block.list.depth + 1) * run.style.fontSize
                  : 0),
            ),
          },
          ports,
        ),
      }).range(run.start, run.end),
    );
    return;
  }
  result.push(
    Decoration.mark({
      class: "cm-math",
      attributes: {
        style: `${textStyleCss({ ...style, fontFamily: TEXT_CODE_FONT_FAMILY })};color:var(--code-normal, currentColor)`,
        ...textBackgroundAttributes(run.style),
      },
    }).range(run.start, run.end),
  );
  const delimiterLength = display ? 2 : 1;
  result.push(
    Decoration.mark({
      class: "cm-formatting cm-formatting-math cm-formatting-math-begin cm-keyword cm-math",
    }).range(run.contentStart - delimiterLength, run.contentStart),
  );
  result.push(
    Decoration.mark({
      class: "cm-formatting cm-formatting-math cm-formatting-math-end cm-keyword cm-math",
    }).range(run.contentEnd, run.end),
  );
  for (const token of presentation.syntax)
    result.push(Decoration.mark({ class: token.className }).range(token.start, token.end));
}

class ListMarkerWidget extends WidgetType {
  public constructor(
    readonly marker: string,
    readonly paint: string,
  ) {
    super();
  }
  public override eq(other: ListMarkerWidget): boolean {
    return other.marker === this.marker && other.paint === this.paint;
  }
  public override toDOM(view: EditorView): HTMLElement {
    const node = view.dom.ownerDocument.createElement("span");
    node.className = "inkbook-text-list-marker";
    node.setAttribute("style", this.paint);
    const marker = node.ownerDocument.createElement("span");
    marker.textContent = this.marker;
    node.append(marker);
    return node;
  }
}
