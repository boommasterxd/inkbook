import type { TextListMarker, TextMarkdownBlock, TextMarkdownTable } from "./text-types";
import { textTableBodySteps, textTableHeaderSteps, type TextSourceLine } from "./markdown-tables";

export type TextBlockSource = Omit<TextMarkdownBlock, "runs" | "alignment" | "spans">;

interface IndexedBlock {
  readonly block: TextBlockSource;
  readonly endIndex: number;
}

export function* textBlockSourcesSteps(source: string): Generator<void, TextBlockSource[]> {
  const lines = yield* sourceLines(source);
  const result: TextBlockSource[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const math = displayMath(source, line);
    if (math) {
      result.push(math);
      while (index + 1 < lines.length && lines[index + 1]!.start < math.end) index += 1;
    } else {
      const block = lineBlock(line);
      const table =
        block.kind === "paragraph" ? yield* textTableHeaderSteps(lines, index) : undefined;
      const parsed = table
        ? yield* tableBlockSteps(lines, index, table)
        : yield* paragraphBlockSteps(lines, index, block);
      result.push(parsed.block);
      index = parsed.endIndex;
    }
    yield;
  }
  return result;
}

function* tableBlockSteps(
  lines: readonly TextSourceLine[],
  index: number,
  table: TextMarkdownTable,
): Generator<void, IndexedBlock> {
  const start = lines[index]!.start;
  const rows = [...table.rows];
  index += 1;
  while (index + 1 < lines.length) {
    const row = yield* textTableBodySteps(lines[index + 1]!, table.alignments.length);
    if (!row) break;
    rows.push(row);
    index += 1;
  }
  const end = lines[index]!.end;
  return {
    block: {
      kind: "table",
      start,
      end,
      contentStart: start,
      contentEnd: end,
      table: { ...table, rows },
    },
    endIndex: index,
  };
}

function* paragraphBlockSteps(
  lines: readonly TextSourceLine[],
  index: number,
  block: TextBlockSource,
): Generator<void, IndexedBlock> {
  let end = block.end;
  if (block.kind === "paragraph" && lines[index]!.content.trim()) {
    while (index + 1 < lines.length && continuesParagraph(lines[index + 1]!)) {
      if (yield* textTableHeaderSteps(lines, index + 1)) break;
      index += 1;
      end = lines[index]!.end;
      yield;
    }
  }
  return { block: { ...block, end, contentEnd: end }, endIndex: index };
}

function* sourceLines(source: string): Generator<void, TextSourceLine[]> {
  const lines: TextSourceLine[] = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index === source.length || source[index] === "\n") {
      const end = index > start && source[index - 1] === "\r" ? index - 1 : index;
      lines.push({ start, end, content: source.slice(start, end) });
      start = index + 1;
    }
    if (index % 256 === 0) yield;
  }
  return lines;
}

function lineBlock(line: TextSourceLine): TextBlockSource {
  const heading = /^( {0,3})(#{1,6})(?:[\t ]+|$)/u.exec(line.content);
  if (heading)
    return {
      kind: "heading",
      start: line.start,
      end: line.end,
      contentStart: line.start + heading[0].length,
      contentEnd: line.end,
      headingLevel: heading[2]!.length,
    };
  const list = /^(\s*)([-+*]|\d{1,9}[.)])[\t ]+/u.exec(line.content);
  if (list) {
    const marker = list[2]!;
    const indentation = list[1]!.replace(/\t/gu, "    ").length;
    const ordered = /\d/u.test(marker[0]!);
    const descriptor: TextListMarker = {
      ordered,
      number: ordered ? Number.parseInt(marker, 10) : 1,
      depth: Math.floor(indentation / 2),
      marker,
    };
    return {
      kind: "list-item",
      start: line.start,
      end: line.end,
      contentStart: line.start + list[0].length,
      contentEnd: line.end,
      list: descriptor,
    };
  }
  return {
    kind: "paragraph",
    start: line.start,
    end: line.end,
    contentStart: line.start,
    contentEnd: line.end,
  };
}

function continuesParagraph(line: TextSourceLine): boolean {
  return (
    Boolean(line.content.trim()) &&
    lineBlock(line).kind === "paragraph" &&
    !line.content.trimStart().startsWith("$$")
  );
}

function displayMath(source: string, line: TextSourceLine): TextBlockSource | undefined {
  const indent = line.content.length - line.content.trimStart().length;
  const opening = line.start + indent;
  if (!source.startsWith("$$", opening)) return undefined;
  let closing = source.indexOf("$$", opening + 2);
  while (closing >= 0 && escapedAt(source, closing)) closing = source.indexOf("$$", closing + 2);
  if (closing < 0) return undefined;
  const end = closing + 2;
  const trailingEnd = source.indexOf("\n", end);
  const trailing = source.slice(end, trailingEnd < 0 ? source.length : trailingEnd);
  if (trailing.trim()) return undefined;
  return { kind: "math", start: line.start, end, contentStart: opening + 2, contentEnd: closing };
}

function escapedAt(source: string, position: number): boolean {
  let backslashes = 0;
  while (position > 0 && source[--position] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}
