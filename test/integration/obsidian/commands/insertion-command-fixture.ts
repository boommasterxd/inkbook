import type { EditorPosition } from "obsidian";

import {
  registerInkbookCommands,
  type EditorInsertionCommandPort,
} from "../../../../src/obsidian/commands";

export function registerInsertion(insertion: EditorInsertionCommandPort) {
  return registerInkbookCommands(
    { addCommand: (command) => command },
    { execute: () => undefined, isAvailable: () => false },
    insertion,
  );
}

export class FakeEditor {
  readonly lines: string[];
  cursorLine: number;

  constructor(lines: string[], cursorLine = 0) {
    this.lines = lines;
    this.cursorLine = cursorLine;
  }

  getCursor(): EditorPosition {
    return { ch: 0, line: this.cursorLine };
  }

  setCursor(position: EditorPosition): void {
    this.cursorLine = position.line;
  }

  getLine(line: number): string {
    return this.lines[line] ?? "";
  }

  lineCount(): number {
    return this.lines.length;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.lines
      .slice(from.line, to.line + 1)
      .map((line, index) => {
        const end = index === to.line - from.line ? to.ch : line.length;
        return line.slice(index === 0 ? from.ch : 0, end);
      })
      .join("\n");
  }

  replaceRange(replacement: string, from: EditorPosition, to = from): void {
    const text =
      this.getLine(from.line).slice(0, from.ch) + replacement + this.getLine(to.line).slice(to.ch);
    this.lines.splice(from.line, to.line - from.line + 1, ...text.split("\n"));
  }
}
