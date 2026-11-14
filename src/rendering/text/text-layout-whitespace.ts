import type { TextLayoutRunV2, TextLayoutV2 } from "../../domain/schema/public";
import type { TextMarkdownDocument, TextMarkdownRun } from "../../domain/text/text-types";

/** Inspect this field's retained source coverage, excluding Markdown syntax and resolved math. */
export function* missingTextWhitespaceSteps(
  document: TextMarkdownDocument,
  layout: TextLayoutV2,
  minimumTableGap = 0,
): Generator<void, boolean> {
  let lineIndex = 0;
  for (const table of layout.tables ?? []) {
    const bottom = table.y + table.height;
    while (lineIndex < layout.lines.length && layout.lines[lineIndex]!.y < bottom) {
      lineIndex += 1;
      yield;
    }
    const following = layout.lines[lineIndex];
    if (following && following.y < bottom + minimumTableGap) return true;
    yield;
  }
  const covered = new Set<number>();
  for (const line of layout.lines) {
    for (const run of line.runs) yield* retainWhitespaceSteps(document.source, run, covered);
    yield;
  }
  for (const block of document.blocks) {
    for (const run of block.runs) if (yield* missingRunWhitespaceSteps(run, covered)) return true;
    yield;
  }
  return false;
}

function* retainWhitespaceSteps(
  source: string,
  run: TextLayoutRunV2,
  covered: Set<number>,
): Generator<void> {
  const text = run.text;
  if (run.end - run.start !== text.length) return;
  for (let offset = 0; offset < text.length; offset += 1) {
    const position = run.start + offset;
    if (text[offset] === " " && source[position] === " ") covered.add(position);
    if (offset % 256 === 0) yield;
  }
  if (text === " " && source[run.start] === "\t") covered.add(run.start);
  yield;
}

function* missingRunWhitespaceSteps(
  run: TextMarkdownRun,
  covered: ReadonlySet<number>,
): Generator<void, boolean> {
  if (run.kind !== "text" || run.contentEnd - run.contentStart !== run.text.length) return false;
  for (let offset = 0; offset < run.text.length; offset += 1) {
    if (
      (run.text[offset] === " " || run.text[offset] === "\t") &&
      !covered.has(run.contentStart + offset)
    )
      return true;
    if (offset % 256 === 0) yield;
  }
  return false;
}
