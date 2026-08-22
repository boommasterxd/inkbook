import type { Editor } from "obsidian";

import { ObsidianEditorMutationAdapter } from "../vault";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";

interface PreparedInkbookDocument {
  readonly content: string;
  readonly path: string;
}

interface InsertionDocumentFactoryPort {
  prepare(sourcePath: string): Promise<PreparedInkbookDocument>;
  verifyCreated(content: string): Promise<boolean>;
}

interface InsertionFilePort {
  createAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<{ readonly content: string }>;
}

interface InsertionLinkPort {
  generateEmbed(filePath: string, sourcePath: string): string;
}

interface InsertionTrashPort {
  trash(filePath: string): Promise<void>;
}

export interface CompletedEmptyLineInsertion {
  readonly embedMarkdown: string;
  readonly filePath: string;
  readonly line: number;
  undo(): Promise<boolean>;
}

export interface EmptyLineInsertionNotifications {
  failed(message: string, error: unknown): void;
  inserted(insertion: CompletedEmptyLineInsertion): void;
}

interface EmptyLineInsertionDependencies {
  readonly documents: InsertionDocumentFactoryPort;
  readonly files: InsertionFilePort;
  readonly links: InsertionLinkPort;
  readonly notifications: EmptyLineInsertionNotifications;
  readonly trash: InsertionTrashPort;
}

const BACKTICK_FENCE_OPEN = /^ {0,3}(`{3,})[^`]*$/u;
const INSERT_FAILED_NOTICE = "Inkbook could not insert the handwriting embed.";

class InsertionActionError extends Error {
  readonly notice: string;

  constructor(message: string, notice: string) {
    super(message);
    this.name = "InsertionActionError";
    this.notice = notice;
  }
}

function notifyFailure(
  notifications: EmptyLineInsertionNotifications,
  message: string,
  error: unknown,
): void {
  try {
    notifications.failed(message, error);
  } catch {
    // A host notification failure must not create an unhandled action rejection.
  }
}

function isInsideFrontmatter(editor: Editor, targetLine: number): boolean {
  if (targetLine === 0 || editor.getLine(0).trim() !== "---") return false;
  for (let line = 1; line < targetLine; line += 1) {
    const text = editor.getLine(line).trim();
    if (text === "---" || text === "...") return false;
  }
  return true;
}

function isInsideBacktickCodeBlock(editor: Editor, targetLine: number): boolean {
  let openingLength: number | undefined;
  for (let line = 0; line < targetLine; line += 1) {
    const text = editor.getLine(line);
    if (openingLength === undefined) {
      openingLength = BACKTICK_FENCE_OPEN.exec(text)?.[1]?.length;
      continue;
    }
    const candidate = text.trimStart();
    const indentation = text.length - candidate.length;
    const ticks = candidate.match(/^`+/u)?.[0].length ?? 0;
    if (indentation <= 3 && ticks >= openingLength && candidate.slice(ticks).trim() === "") {
      openingLength = undefined;
    }
  }
  return openingLength !== undefined;
}

export function isEmptyInsertionLine(editor: Editor, line: number): boolean {
  if (!Number.isSafeInteger(line) || line < 0 || line >= editor.lineCount()) return false;
  if (editor.getLine(line) !== "") return false;
  return !isInsideFrontmatter(editor, line) && !isInsideBacktickCodeBlock(editor, line);
}

class EmptyLineInsertionHandle implements CompletedEmptyLineInsertion {
  readonly embedMarkdown: string;
  readonly filePath: string;
  readonly line: number;
  readonly #editor: Editor;
  readonly #notifications: EmptyLineInsertionNotifications;
  readonly #trash: InsertionTrashPort;
  #settled = false;

  constructor(
    editor: Editor,
    notifications: EmptyLineInsertionNotifications,
    trash: InsertionTrashPort,
    filePath: string,
    embedMarkdown: string,
    line: number,
  ) {
    this.#editor = editor;
    this.#notifications = notifications;
    this.#trash = trash;
    this.filePath = filePath;
    this.embedMarkdown = embedMarkdown;
    this.line = line;
  }

  async undo(): Promise<boolean> {
    if (this.#settled) return false;
    let removed: boolean;
    try {
      removed = new ObsidianEditorMutationAdapter(this.#editor).replaceIfUnchanged({
        expected: this.embedMarkdown,
        range: {
          from: { ch: 0, line: this.line },
          to: { ch: this.embedMarkdown.length, line: this.line },
        },
        replacement: "",
      });
    } catch (error: unknown) {
      notifyFailure(
        this.#notifications,
        "Inkbook could not undo the insertion because the note could not be edited. The handwriting file was preserved.",
        error,
      );
      return false;
    }
    if (!removed) {
      notifyFailure(
        this.#notifications,
        "Inkbook could not undo the insertion because the note changed. The handwriting file was preserved.",
        new Error("The inserted Markdown embed is no longer unchanged."),
      );
      return false;
    }
    this.#settled = true;
    try {
      await this.#trash.trash(this.filePath);
      return true;
    } catch (error: unknown) {
      notifyFailure(
        this.#notifications,
        "Inkbook removed the embed but could not move the handwriting file to trash. The file was preserved.",
        error,
      );
      return false;
    }
  }
}

export class EmptyLineInsertionController {
  readonly #dependencies: EmptyLineInsertionDependencies;
  #busy = false;

  constructor(dependencies: EmptyLineInsertionDependencies) {
    this.#dependencies = dependencies;
  }

  canInsert(editor: Editor, sourcePath: string): boolean {
    return (
      !this.#busy && sourcePath.length > 0 && isEmptyInsertionLine(editor, editor.getCursor().line)
    );
  }

  canInsertAtLine(editor: Editor, sourcePath: string, line: number): boolean {
    return !this.#busy && sourcePath.length > 0 && isEmptyInsertionLine(editor, line);
  }

  request(editor: Editor, sourcePath: string): boolean {
    return this.requestAtLine(editor, sourcePath, editor.getCursor().line);
  }

  requestAtLine(editor: Editor, sourcePath: string, line: number): boolean {
    if (!this.canInsertAtLine(editor, sourcePath, line)) return false;
    this.#busy = true;
    void this.#insert(editor, sourcePath, line)
      .then((insertion) => {
        this.#dependencies.notifications.inserted(insertion);
      })
      .catch((error: unknown) => {
        notifyFailure(
          this.#dependencies.notifications,
          error instanceof InsertionActionError ? error.notice : INSERT_FAILED_NOTICE,
          error,
        );
      })
      .finally(() => {
        this.#busy = false;
      });
    return true;
  }

  async #insert(
    editor: Editor,
    sourcePath: string,
    line: number,
  ): Promise<CompletedEmptyLineInsertion> {
    const prepared = await this.#dependencies.documents.prepare(sourcePath);
    const readBack = await this.#dependencies.files.createAndReadBack(
      prepared.path,
      prepared.content,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    );
    try {
      const verified = await this.#dependencies.documents.verifyCreated(readBack.content);
      if (readBack.content !== prepared.content || verified !== true) {
        throw new Error("The created Inkbook document did not pass worker verification.");
      }
      const embedMarkdown = this.#dependencies.links.generateEmbed(prepared.path, sourcePath);
      const inserted = new ObsidianEditorMutationAdapter(editor).insertEmbedOnEmptyLine(
        embedMarkdown,
        line,
      );
      if (!inserted) {
        throw new InsertionActionError(
          "The target Markdown line changed before insertion.",
          "Inkbook could not edit the note, so the new handwriting file was moved to trash.",
        );
      }
      return new EmptyLineInsertionHandle(
        editor,
        this.#dependencies.notifications,
        this.#dependencies.trash,
        prepared.path,
        embedMarkdown,
        line,
      );
    } catch (error: unknown) {
      try {
        await this.#dependencies.trash.trash(prepared.path);
      } catch {
        throw new InsertionActionError(
          "The created handwriting file could not be moved to trash.",
          "Inkbook could not finish inserting the handwriting embed or move the created file to trash. The file may require manual cleanup.",
        );
      }
      throw error;
    }
  }
}
