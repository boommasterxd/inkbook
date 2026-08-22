import type { Editor, EditorPosition, EditorRange } from "obsidian";

export interface EditorReplacement {
  readonly expected: string;
  readonly range: EditorRange;
  readonly replacement: string;
}

function isEditorPosition(position: EditorPosition): boolean {
  return (
    Number.isSafeInteger(position.line) &&
    position.line >= 0 &&
    Number.isSafeInteger(position.ch) &&
    position.ch >= 0
  );
}

function isOrderedRange(range: EditorRange): boolean {
  if (!isEditorPosition(range.from) || !isEditorPosition(range.to)) return false;
  return (
    range.from.line < range.to.line ||
    (range.from.line === range.to.line && range.from.ch <= range.to.ch)
  );
}

export class ObsidianEditorMutationAdapter {
  readonly #editor: Editor;

  constructor(editor: Editor) {
    this.#editor = editor;
  }

  replaceIfUnchanged(change: EditorReplacement): boolean {
    if (!isOrderedRange(change.range)) {
      throw new RangeError("Editor range is invalid");
    }
    if (this.#editor.getRange(change.range.from, change.range.to) !== change.expected) {
      return false;
    }
    this.#editor.replaceRange(change.replacement, change.range.from, change.range.to);
    return true;
  }

  insert(text: string, position: EditorPosition): void {
    if (!isEditorPosition(position)) {
      throw new RangeError("Editor position is invalid");
    }
    this.#editor.replaceRange(text, position);
  }

  insertEmbedOnEmptyLine(embedMarkdown: string, line: number): boolean {
    if (
      embedMarkdown.length === 0 ||
      embedMarkdown.includes("\n") ||
      !Number.isSafeInteger(line) ||
      line < 0
    ) {
      throw new RangeError("Embed insertion is invalid");
    }
    if (this.#editor.getLine(line) !== "") {
      return false;
    }
    const position = { ch: 0, line };
    this.#editor.replaceRange(embedMarkdown, position, position);
    return true;
  }
}
