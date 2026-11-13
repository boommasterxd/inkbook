import type { TextMarkdownTable, TextMarkdownTableCell, TextMarkdownTableRow } from "./text-types";

export interface TextSourceLine {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

export function* textTableHeaderSteps(
  lines: readonly TextSourceLine[],
  index: number,
): Generator<void, TextMarkdownTable | undefined> {
  const header = lines[index]!;
  const delimiter = lines[index + 1];
  if (!delimiter || !/^[\t |:-]+$/u.test(delimiter.content)) return undefined;
  const separator = yield* tableRowSteps(delimiter);
  if (!separator) return undefined;
  const alignments: ("left" | "center" | "right")[] = [];
  for (const cell of separator.cells) {
    const text = delimiter.content.slice(
      cell.contentStart - delimiter.start,
      cell.contentEnd - delimiter.start,
    );
    if (!/^:?-{3,}:?$/u.test(text)) return undefined;
    alignments.push(text.endsWith(":") ? (text.startsWith(":") ? "center" : "right") : "left");
    yield;
  }
  const row = yield* tableRowSteps(header);
  if (!row || row.cells.length !== alignments.length) return undefined;
  return {
    alignments,
    rows: [row],
    delimiter: { start: delimiter.start, end: delimiter.end },
  };
}

export function* textTableBodySteps(
  line: TextSourceLine,
  columns: number,
): Generator<void, TextMarkdownTableRow | undefined> {
  const row = yield* tableRowSteps(line);
  if (!row) return undefined;
  const cells = row.cells.slice(0, columns);
  while (cells.length < columns) {
    cells.push({ start: line.end, end: line.end, contentStart: line.end, contentEnd: line.end });
    yield;
  }
  return { ...row, cells };
}

function* tableRowSteps(line: TextSourceLine): Generator<void, TextMarkdownTableRow | undefined> {
  const pipes = yield* tablePipesSteps(line.content);
  if (pipes.length === 0) return undefined;
  const cells: TextMarkdownTableCell[] = [];
  let start = 0;
  for (const pipe of pipes) {
    cells.push(tableCell(line, start, pipe));
    start = pipe + 1;
    yield;
  }
  cells.push(tableCell(line, start, line.content.length));
  if (!line.content.slice(0, pipes[0]).trim()) cells.shift();
  if (!line.content.slice(pipes[pipes.length - 1]! + 1).trim()) cells.pop();
  if (cells.length === 0) return undefined;
  return { start: line.start, end: line.end, cells };
}

function tableCell(line: TextSourceLine, start: number, end: number): TextMarkdownTableCell {
  const text = line.content.slice(start, end);
  const leading = text.length - text.trimStart().length;
  const trailing = text.trimEnd().length;
  return {
    start: line.start + start,
    end: line.start + end,
    contentStart: line.start + start + leading,
    contentEnd: line.start + start + Math.max(leading, trailing),
  };
}

/** Match exact backtick runs like the inline parser; unmatched ticks remain literal. */
function* tablePipesSteps(source: string): Generator<void, number[]> {
  const ticks: { start: number; end: number }[] = [];
  for (let position = 0; position < source.length; position += 1) {
    if (source[position] === "\\") position += 1;
    else if (source[position] === "`") {
      const start = position;
      while (source[position + 1] === "`") {
        position += 1;
        if (position % 256 === 0) yield;
      }
      ticks.push({ start, end: position + 1 });
    }
    if (position % 256 === 0) yield;
  }
  const next = new Map<number, number>();
  const previous = new Map<number, number>();
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    const tick = ticks[index]!;
    const length = tick.end - tick.start;
    const closing = previous.get(length);
    if (closing !== undefined) next.set(tick.start, closing);
    previous.set(length, index);
    yield;
  }
  const pipes: number[] = [];
  for (let position = 0; position < source.length; position += 1) {
    const closing = next.get(position);
    if (source[position] === "\\") position += 1;
    else if (closing !== undefined) position = ticks[closing]!.end - 1;
    else if (source[position] === "|") pipes.push(position);
    if (position % 256 === 0) yield;
  }
  return pipes;
}
