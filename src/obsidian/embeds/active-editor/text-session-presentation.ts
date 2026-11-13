import type { TextElementV2, TextRangeStyleV2, TextStyleV2 } from "../../../domain/schema/public";
import type { TextParagraphStyleV2 } from "../../../domain/schema/public";
import { textBlockAlignmentAt } from "../../../domain/text/text-paragraph-alignment";
import { BUILT_IN_COLORS } from "../../../domain/settings/defaults";
import type {
  TextMarkdownBlock,
  TextMarkdownDocument,
  TextMarkdownRun,
} from "../../../domain/text/text-types";
import { TEXT_CODE_FONT_FAMILY } from "../../../domain/text/text-layout-style";
import {
  commonTextValue,
  type TextSelectionStyleSummary,
} from "../../../editor/tools/text-style-summary";
import type { ObsidianTextMathRenderer } from "../../text/math-renderer";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { ResolvedTextMath } from "../../../rendering/text/text-layout-types";
import type { Bounds } from "../../../domain/geometry/public";
import type { TextEditingSurface } from "../../../rendering/scene/text-editing-surface";
import type {
  PreparedTextScrollReveal,
  TextEditorClientRect,
} from "../../text/editor/text-field-editor-types";

export function textMenuStyleValue(key: string, value: boolean | number | string): unknown {
  if (key !== "color" && key !== "backgroundColor") return value;
  if (key === "backgroundColor" && value === "none") return null;
  return BUILT_IN_COLORS.find((color) =>
    color.type === "theme-text" ? value === "theme-text" : color.value === value,
  );
}

export function prepareTextCaretReveal(
  surface: TextEditingSurface,
  rect: TextEditorClientRect,
  reveal?: (bounds: Bounds) => void,
  beforeReveal?: () => void,
): PreparedTextScrollReveal | undefined {
  if (!reveal) return undefined;
  const bounds = surface.pageBoundsForClientRect(rect);
  if (!bounds) return undefined;
  return (updateExtent = true) => {
    if (updateExtent) beforeReveal?.();
    reveal(bounds);
    return true;
  };
}

export function textSelectionSummary(
  element: TextElementV2,
  document: TextMarkdownDocument | undefined,
  start: number,
  end: number,
  pending: Readonly<TextRangeStyleV2> = {},
): TextSelectionStyleSummary {
  const query = { start, end, includeEnd: start === end && start === element.source.length };
  const blocks = document
    ? [
        ...selectedTextRanges(
          document.blocks,
          { ...query, includeEnd: start === end },
          BLOCK_COORDINATES,
        ),
      ]
    : [];
  const styles = blocks.flatMap((block) =>
    Array.from(selectedTextRanges(block.runs, query, RUN_COORDINATES), (run) => ({
      ...run.style,
      ...(run.code ? { fontFamily: TEXT_CODE_FONT_FAMILY } : {}),
    })),
  );
  if (styles.length === 0) styles.push(element.style);
  const style = {} as TextSelectionStyleSummary["style"];
  for (const key of Object.keys(element.style) as (keyof TextStyleV2)[])
    Object.assign(style, {
      [key]: pending[key] ?? commonTextValue(styles.map((entry) => entry[key])),
    });
  return {
    kind: "text",
    style,
    alignment: commonTextValue(
      blocks.length
        ? blocks.flatMap((block) => [
            textBlockAlignmentAt(block, Math.max(block.start, start)),
            ...(start === end
              ? []
              : Array.from(
                  selectedTextRanges(block.sourceAlignments ?? [], query, PARAGRAPH_COORDINATES),
                  (paragraph) => paragraph.alignment,
                )),
          ])
        : ["left"],
    ),
    backgroundColor:
      pending.backgroundColor === undefined
        ? commonTextValue(
            styles.map((entry) =>
              entry.backgroundColor === undefined ? element.backgroundColor : entry.backgroundColor,
            ),
          )
        : pending.backgroundColor,
    backgroundOpacity:
      pending.backgroundOpacity ??
      commonTextValue(styles.map((entry) => entry.backgroundOpacity ?? element.backgroundOpacity)),
  };
}

interface TextRangeCoordinates<Value> {
  readonly start: (value: Value) => number;
  readonly end: (value: Value) => number;
}

const BLOCK_COORDINATES: TextRangeCoordinates<TextMarkdownBlock> = {
  start: (block) => block.start,
  end: (block) => block.end,
};
const PARAGRAPH_COORDINATES: TextRangeCoordinates<TextParagraphStyleV2> = {
  start: (paragraph) => paragraph.start,
  end: (paragraph) => paragraph.start,
};
const RUN_COORDINATES: TextRangeCoordinates<TextMarkdownRun> = {
  start: (run) => run.contentStart,
  end: (run) => run.contentEnd,
};

/** Parser arrays already have monotonic source bounds, so lookups need no rebuilt index. */
function* selectedTextRanges<Value>(
  values: readonly Value[],
  query: { readonly start: number; readonly end: number; readonly includeEnd: boolean },
  coordinates: TextRangeCoordinates<Value>,
): Generator<Value> {
  let lower = 0;
  let upper = values.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const end = coordinates.end(values[middle]!);
    if (query.includeEnd ? end < query.start : end <= query.start) lower = middle + 1;
    else upper = middle;
  }
  const caret = query.start === query.end;
  for (let index = lower; index < values.length; index += 1) {
    const value = values[index]!;
    const start = coordinates.start(value);
    if (caret ? start > query.start : start >= query.end) break;
    yield value;
  }
}

/** Host syntax tokens inherit through the scene's existing coalesced theme relay. */
export function relayTextTheme(container: HTMLElement): void {
  container.style.setProperty("--inkbook-text-color", "var(--inkbook-text, #222222FF)");
}

export async function renderTextMathWidget(options: {
  readonly document: Document;
  readonly math: ObsidianTextMathRenderer;
  readonly latex: string;
  readonly display: boolean;
  readonly size: number;
  readonly width: number;
  readonly bold?: boolean;
  readonly signal: AbortSignal;
  readonly scheduler: WorkScheduler;
  readonly baselineOffset?: (result: ResolvedTextMath) => number;
}): Promise<HTMLElement> {
  const result = await options.math.resolve(
    options.latex,
    options.display,
    options.size,
    options.signal,
    options.width,
    { bold: options.bold ?? false },
  );
  options.signal.throwIfAborted();
  const container = options.document.createElement("span");
  container.classList.add("inkbook-text-math-content");
  container.style.verticalAlign = `${-result.descent - (options.baselineOffset?.(result) ?? 0)}px`;
  const svg = options.document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${result.width} ${result.height}`);
  svg.setAttribute("width", String(result.width));
  svg.setAttribute("height", String(result.height));
  svg.setAttribute("aria-label", options.latex);
  svg.setAttribute("role", "img");
  for (const path of result.paths) {
    const pending = options.scheduler.checkpoint(options.signal, "frame");
    if (pending !== undefined) await pending;
    options.signal.throwIfAborted();
    const node = options.document.createElementNS("http://www.w3.org/2000/svg", "path");
    node.setAttribute("d", path.d);
    node.setAttribute("fill", "currentColor");
    if (path.fillRule) node.setAttribute("fill-rule", path.fillRule);
    svg.append(node);
  }
  container.append(svg);
  return container;
}
