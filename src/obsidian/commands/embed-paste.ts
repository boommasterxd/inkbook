import type { Editor, EditorPosition } from "obsidian";

import { findMarkdownInkbookEmbeds, type MarkdownInkbookEmbed } from "../embeds/markdown-embed";
import type { MetadataGuardedFileRead } from "../../persistence/saving/save-ports";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";

export type EmbedPasteChoice = "duplicate" | "reference";

interface EmbedPasteChoicePort {
  choose(): Promise<EmbedPasteChoice | null>;
}

interface EmbedPasteDocumentPort {
  createAndReadBack(
    path: string,
    content: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead>;
  readWithMetadataGuard(path: string, maximumBytes: number): Promise<MetadataGuardedFileRead>;
}

interface EmbedPasteLinkPort {
  generateEmbed(filePath: string, sourcePath: string): string;
  resolveLinkTarget(linkpath: string, sourcePath: string): { readonly path: string } | null;
}

interface EmbedPastePlacementPort {
  preparePath(sourcePath: string): Promise<string>;
}

interface EmbedPasteTrashPort {
  trash(filePath: string): Promise<void>;
}

/** The implementation belongs to the document worker or its bounded fallback. */
interface EmbedPasteValidationPort {
  validate(content: string): Promise<boolean>;
}

interface EmbedPasteConfirmedOutputPort {
  matchesConfirmedOutput(read: MetadataGuardedFileRead): boolean;
}

export interface EmbedPasteRequest {
  readonly clipboardText: string;
  readonly editor: Editor;
  readonly insideInkWidget: boolean;
  readonly sourcePath: string;
}

export type EmbedPasteOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "ignored" }
  | { readonly kind: "inserted"; readonly mode: "duplicate" | "original" | "reference" }
  | { readonly cleanup: "failed" | "not-needed" | "trashed"; readonly kind: "stale" };

export interface EmbedPasteDependencies {
  readonly confirmedOutput?: EmbedPasteConfirmedOutputPort;
  readonly signal?: AbortSignal;
  readonly choices: EmbedPasteChoicePort;
  readonly documents: EmbedPasteDocumentPort;
  readonly links: EmbedPasteLinkPort;
  readonly placement: EmbedPastePlacementPort;
  readonly trash: EmbedPasteTrashPort;
  readonly validation: EmbedPasteValidationPort;
}

interface CapturedEditorTarget {
  readonly from: EditorPosition;
  readonly source: string;
  readonly to: EditorPosition;
  readonly value: string;
}

function exactEmbed(text: string): MarkdownInkbookEmbed | null {
  const embeds = findMarkdownInkbookEmbeds(text);
  const embed = embeds[0];
  return embeds.length === 1 && embed?.from === 0 && embed.to === text.length ? embed : null;
}

function samePosition(left: EditorPosition, right: EditorPosition): boolean {
  return left.line === right.line && left.ch === right.ch;
}

function captureTarget(editor: Editor): CapturedEditorTarget {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  return {
    from,
    source: editor.getRange(from, to),
    to,
    value: editor.getValue(),
  };
}

function replaceIfCurrent(
  editor: Editor,
  target: CapturedEditorTarget,
  replacement: string,
): boolean {
  if (!targetIsCurrent(editor, target)) return false;
  editor.replaceRange(replacement, target.from, target.to);
  return true;
}

function targetIsCurrent(editor: Editor, target: CapturedEditorTarget): boolean {
  return (
    editor.getValue() === target.value &&
    samePosition(editor.getCursor("from"), target.from) &&
    samePosition(editor.getCursor("to"), target.to) &&
    editor.getRange(target.from, target.to) === target.source
  );
}

export function isCopiedEmbedPaste(text: string, insideInkWidget: boolean): boolean {
  return !insideInkWidget && exactEmbed(text) !== null;
}

export class EmbedPasteController {
  readonly #dependencies: EmbedPasteDependencies;
  #pending = false;

  constructor(dependencies: EmbedPasteDependencies) {
    this.#dependencies = dependencies;
  }

  canHandle(request: EmbedPasteRequest): boolean {
    return (
      !this.#isAborted() &&
      request.sourcePath.length > 0 &&
      isCopiedEmbedPaste(request.clipboardText, request.insideInkWidget)
    );
  }

  async paste(request: EmbedPasteRequest): Promise<EmbedPasteOutcome> {
    const embed = exactEmbed(request.clipboardText);
    if (request.insideInkWidget || request.sourcePath.length === 0 || embed === null) {
      return { kind: "ignored" };
    }

    if (this.#pending || this.#isAborted()) return { kind: "cancelled" };
    this.#pending = true;
    try {
      return await this.#paste(request, embed);
    } finally {
      this.#pending = false;
    }
  }

  async #paste(
    request: EmbedPasteRequest,
    embed: MarkdownInkbookEmbed,
  ): Promise<EmbedPasteOutcome> {
    const target = captureTarget(request.editor);
    const sourceFile = this.#dependencies.links.resolveLinkTarget(
      embed.linkpath,
      request.sourcePath,
    );
    if (sourceFile === null) return this.#insertOriginal(request, target);

    let sourceRead: MetadataGuardedFileRead;
    try {
      sourceRead = await this.#dependencies.documents.readWithMetadataGuard(
        sourceFile.path,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      );
      if (this.#isAborted()) return { kind: "cancelled" };
      if (sourceRead.identity.path !== sourceFile.path)
        return this.#insertOriginal(request, target);
      if (
        this.#dependencies.confirmedOutput?.matchesConfirmedOutput(sourceRead) !== true &&
        !(await this.#dependencies.validation.validate(sourceRead.content))
      ) {
        return this.#insertOriginal(request, target);
      }
    } catch {
      return this.#insertOriginal(request, target);
    }

    if (this.#isAborted()) return { kind: "cancelled" };
    const choice = await this.#dependencies.choices.choose();
    if (choice === null || this.#isAborted()) return { kind: "cancelled" };
    if (!targetIsCurrent(request.editor, target)) return { cleanup: "not-needed", kind: "stale" };
    if (choice === "reference") {
      return replaceIfCurrent(request.editor, target, request.clipboardText)
        ? { kind: "inserted", mode: "reference" }
        : { cleanup: "not-needed", kind: "stale" };
    }
    return this.#duplicate(request, target, sourceRead.content);
  }

  async #duplicate(
    request: EmbedPasteRequest,
    target: CapturedEditorTarget,
    sourceContent: string,
  ): Promise<EmbedPasteOutcome> {
    let duplicatePath: string | null = null;
    let created = false;
    try {
      duplicatePath = await this.#dependencies.placement.preparePath(request.sourcePath);
      if (this.#isAborted()) return { kind: "cancelled" };
      if (!targetIsCurrent(request.editor, target)) return { cleanup: "not-needed", kind: "stale" };
      const createdRead = await this.#dependencies.documents.createAndReadBack(
        duplicatePath,
        sourceContent,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      );
      created = true;
      if (this.#isAborted()) return this.#discardStale(duplicatePath);
      if (createdRead.identity.path !== duplicatePath || createdRead.content !== sourceContent) {
        throw new Error("The created duplicate did not pass read-back validation.");
      }
      if (this.#isAborted()) return this.#discardStale(duplicatePath);
      const markdown = this.#dependencies.links.generateEmbed(duplicatePath, request.sourcePath);
      if (replaceIfCurrent(request.editor, target, markdown)) {
        return { kind: "inserted", mode: "duplicate" };
      }
      return this.#discardStale(duplicatePath);
    } catch (error: unknown) {
      if (created && duplicatePath !== null && this.#isAborted()) {
        return this.#discardStale(duplicatePath);
      }
      if (created && duplicatePath !== null) await this.#trashCreated(duplicatePath);
      return { error, kind: "failed" };
    }
  }

  #isAborted(): boolean {
    return this.#dependencies.signal?.aborted === true;
  }

  async #discardStale(path: string): Promise<EmbedPasteOutcome> {
    return { cleanup: (await this.#trashCreated(path)) ? "trashed" : "failed", kind: "stale" };
  }

  #insertOriginal(request: EmbedPasteRequest, target: CapturedEditorTarget): EmbedPasteOutcome {
    if (this.#isAborted()) return { kind: "cancelled" };
    return replaceIfCurrent(request.editor, target, request.clipboardText)
      ? { kind: "inserted", mode: "original" }
      : { cleanup: "not-needed", kind: "stale" };
  }

  async #trashCreated(path: string): Promise<boolean> {
    try {
      await this.#dependencies.trash.trash(path);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * A CM6 paste handler must synchronously read `event.clipboardData`, call `canHandle`, and only
 * then prevent the default event. It may resolve the public Obsidian `Editor` and source path at
 * that host boundary before starting `paste`; the controller deliberately receives no EditorView.
 */
