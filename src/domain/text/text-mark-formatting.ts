import type { TextStyleRangeV2, TextStyleV2 } from "../schema/public";
import { parseTextMarkdownSteps } from "./markdown-parser";
import { textBlockSourcesSteps } from "./markdown-blocks";
import {
  firstSelectedBlock,
  forceTextMarkdownMarkSteps,
  toggleTextMarkdownMarkSteps,
  type TextMarkdownFormatResult,
} from "./markdown-formatting";
import { assertTextSourceRange, compactTextStyleRangesSteps } from "./text-source-edits";
import type { TextMarkdownDocument, TextSourceRange, TextSourceState } from "./text-types";

type StyleMark = "bold" | "italic" | "strikethrough";

export interface TextMarkFormatRequest {
  readonly mark: StyleMark;
  readonly desired: boolean | undefined;
  readonly base: TextStyleV2;
}

export interface TextMarkFormatResult extends TextMarkdownFormatResult {
  /** Original source offsets; the editor applies changes and rebases this state exactly once. */
  readonly stateBeforeChanges: TextSourceState;
  readonly typingOverride?: boolean;
}

export function formatTextMarkdownStyle(
  state: TextSourceState,
  selection: TextSourceRange,
  request: TextMarkFormatRequest,
  document?: TextMarkdownDocument,
): TextMarkFormatResult {
  const steps = formatTextMarkdownStyleSteps(state, selection, request, document);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function* formatTextMarkdownStyleSteps(
  state: TextSourceState,
  selection: TextSourceRange,
  request: TextMarkFormatRequest,
  document?: TextMarkdownDocument,
): Generator<void, TextMarkFormatResult> {
  assertTextSourceRange(state.source, selection);
  const { mark, base } = request;
  const context = yield* markContextSteps(state, selection, request, document);
  const { rich, headings } = context;
  document = context.document;
  const implicit = base[mark] || headings.length > 0;
  let desired = request.desired;
  if (desired === undefined && (implicit || rich.present) && document) {
    desired = !(yield* effectiveSelectionMarkSteps(
      document,
      selection,
      mark,
      rich.caret ?? implicit,
    ));
  }
  const result =
    desired === true && base[mark]
      ? { source: state.source, selection, changes: [], markActive: true }
      : desired === undefined
        ? yield* toggleTextMarkdownMarkSteps(state.source, selection, mark, context.formatSource)
        : yield* forceTextMarkdownMarkSteps(
            state.source,
            selection,
            mark,
            desired,
            context.formatSource,
          );
  if (selection.start === selection.end)
    return {
      ...result,
      stateBeforeChanges: state,
      ...(rich.present || (implicit && !result.markActive)
        ? { typingOverride: result.markActive }
        : {}),
    };
  let stateBeforeChanges = rich.present
    ? { ...state, ranges: yield* withoutScopedMarkSteps(state, selection, mark) }
    : state;
  if (implicit && !result.markActive) {
    const overrides = [...stateBeforeChanges.ranges];
    for (const range of base[mark] ? [selection] : headings) {
      overrides.push({ ...range, style: { [mark]: false } });
      yield;
    }
    stateBeforeChanges = {
      ...stateBeforeChanges,
      ranges: yield* compactTextStyleRangesSteps(overrides, state.source.length),
    };
  }
  return { ...result, stateBeforeChanges };
}

function* markContextSteps(
  state: TextSourceState,
  selection: TextSourceRange,
  request: TextMarkFormatRequest,
  document: TextMarkdownDocument | undefined,
) {
  const rich = yield* scopedRichMarkSteps(state.ranges, selection, request.mark);
  if (
    request.desired === undefined &&
    (request.mark === "bold" || request.base[request.mark] || rich.present)
  )
    document =
      document?.source === state.source
        ? document
        : yield* parseTextMarkdownSteps(state.source, {
            style: request.base,
            ranges: state.ranges,
            paragraphs: state.paragraphs,
          });
  const blocks =
    document?.source === state.source
      ? document.blocks
      : request.mark === "bold" && request.desired !== true
        ? yield* textBlockSourcesSteps(state.source)
        : undefined;
  const headings: TextSourceRange[] = [];
  if (request.mark === "bold" && blocks) {
    for (const block of selectedMarkBlocks(blocks, selection)) {
      if (
        block.kind === "heading" &&
        block.contentEnd >= selection.start &&
        block.contentStart <= selection.end
      )
        headings.push({
          start: Math.max(selection.start, block.contentStart),
          end: Math.min(selection.end, block.contentEnd),
        });
      yield;
    }
  }
  return {
    rich,
    headings,
    document,
    formatSource: blocks ? { source: state.source, blocks } : undefined,
  };
}

function* scopedRichMarkSteps(
  ranges: readonly TextStyleRangeV2[],
  selection: TextSourceRange,
  mark: StyleMark,
): Generator<void, { present: boolean; caret: boolean | undefined }> {
  let present = false;
  let caret: boolean | undefined;
  for (const range of ranges) {
    const value = range.style[mark];
    if (value !== undefined && selectionOverlaps(range, selection)) {
      present = true;
      caret = value;
    }
    yield;
  }
  return { present, caret };
}

function* effectiveSelectionMarkSteps(
  document: TextMarkdownDocument,
  selection: TextSourceRange,
  mark: StyleMark,
  fallback: boolean,
): Generator<void, boolean> {
  let found = false;
  for (const block of selectedMarkBlocks(document.blocks, selection)) {
    for (const run of block.runs) {
      yield;
      const overlaps = selectionOverlaps(
        { start: run.contentStart, end: run.contentEnd },
        selection,
      );
      if (!overlaps || run.kind !== "text" || !run.text.trim()) continue;
      found = true;
      if (!run.style[mark]) return false;
    }
  }
  return found ? true : fallback;
}

function* selectedMarkBlocks<Block extends TextSourceRange>(
  blocks: readonly Block[],
  selection: TextSourceRange,
): Generator<Block> {
  for (let index = firstSelectedBlock(blocks, selection.start); index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.start > selection.end) return;
    yield block;
  }
}

function selectionOverlaps(range: TextSourceRange, selection: TextSourceRange): boolean {
  return selection.start === selection.end
    ? range.start <= selection.start && range.end >= selection.start
    : range.start < selection.end && range.end > selection.start;
}

function* withoutScopedMarkSteps(
  state: TextSourceState,
  selection: TextSourceRange,
  mark: StyleMark,
): Generator<void, TextStyleRangeV2[]> {
  const ranges: TextStyleRangeV2[] = [];
  for (const range of state.ranges) {
    if (
      range.style[mark] === undefined ||
      range.start >= selection.end ||
      range.end <= selection.start
    )
      ranges.push(range);
    else {
      if (range.start < selection.start) ranges.push({ ...range, end: selection.start });
      const style = { ...range.style };
      delete style[mark];
      if (Object.keys(style).length)
        ranges.push({
          start: Math.max(range.start, selection.start),
          end: Math.min(range.end, selection.end),
          style,
        });
      if (range.end > selection.end) ranges.push({ ...range, start: selection.end });
    }
    yield;
  }
  return yield* compactTextStyleRangesSteps(ranges, state.source.length);
}
