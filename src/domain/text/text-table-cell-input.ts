import { MAX_TEXT_SOURCE_LENGTH } from "../schema/public";
import type { TextSourceChange } from "./text-types";

/** Exact changes over one protocol-bounded current cell, preserving untouched style ranges. */
export function textTableCellInputChanges(source: string): readonly TextSourceChange[] {
  assertCapacity(source.length);
  if (!/[|\r\n]/u.test(source)) return [];
  const tokens = [...source.matchAll(/\\[^\r\n]|`+|\||\r\n?|\n/gu)];
  const nextTick = new Map<number, number>();
  const following = new Map<number, number>();
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]![0];
    if (token[0] !== "`") continue;
    const closing = following.get(token.length);
    if (closing !== undefined) nextTick.set(index, closing);
    following.set(token.length, index);
  }
  const changes: TextSourceChange[] = [];
  let codeEnd = -1;
  let length = source.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token[0][0] === "\r" || token[0][0] === "\n") {
      changes.push({ start: token.index, end: token.index + token[0].length, insert: " " });
      length += 1 - token[0].length;
    } else if (index > codeEnd) {
      const closing = nextTick.get(index);
      if (closing !== undefined) codeEnd = closing;
      else if (token[0] === "|") {
        changes.push({ start: token.index, end: token.index, insert: "\\" });
        length += 1;
      }
    }
  }
  assertCapacity(length);
  return changes;
}

function assertCapacity(length: number): void {
  if (length > MAX_TEXT_SOURCE_LENGTH) throw new RangeError("Text source capacity exceeded.");
}
