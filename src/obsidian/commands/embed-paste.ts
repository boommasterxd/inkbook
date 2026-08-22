import type { Editor, EditorPosition } from "obsidian";

import { findMarkdownInkbookEmbeds, type MarkdownInkbookEmbed } from "../embeds/markdown-embed";
import type { MetadataGuardedFileRead } from "../../persistence/saving/save-ports";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";

export const CREATE_ANOTHER_REFERENCE = "Reference existing file";
export const MAKE_DUPLICATE = "Make duplicate";

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
  | { readonly duplicateTrashed: boolean; readonly kind: "stale" };

export interface EmbedPasteDependencies {
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
  if (editor.getValue() !== target.value) return false;
  if (!samePosition(editor.getCursor("from"), target.from)) return false;
  if (!samePosition(editor.getCursor("to"), target.to)) return false;
  if (editor.getRange(target.from, target.to) !== target.source) return false;
  editor.replaceRange(replacement, target.from, target.to);
  return true;
}

export function isCopiedEmbedPaste(text: string, insideInkWidget: boolean): boolean {
  return !insideInkWidget && exactEmbed(text) !== null;
}

export class OwnerWindowEmbedPasteChoice implements EmbedPasteChoicePort {
  readonly #ownerWindow: Window;

  constructor(ownerWindow: Window) {
    this.#ownerWindow = ownerWindow;
  }

  async choose(): Promise<EmbedPasteChoice | null> {
    const answer = this.#ownerWindow.prompt(
      `Paste Inkbook embed. Enter "${CREATE_ANOTHER_REFERENCE}" or "${MAKE_DUPLICATE}".`,
      CREATE_ANOTHER_REFERENCE,
    );
    if (answer === null) return null;
    if (answer === CREATE_ANOTHER_REFERENCE) return "reference";
    if (answer === MAKE_DUPLICATE) return "duplicate";
    return null;
  }
}

export class EmbedPasteController {
  readonly #dependencies: EmbedPasteDependencies;

  constructor(dependencies: EmbedPasteDependencies) {
    this.#dependencies = dependencies;
  }

  canHandle(request: EmbedPasteRequest): boolean {
    return (
      request.sourcePath.length > 0 &&
      isCopiedEmbedPaste(request.clipboardText, request.insideInkWidget)
    );
  }

  async paste(request: EmbedPasteRequest): Promise<EmbedPasteOutcome> {
    const embed = exactEmbed(request.clipboardText);
    if (request.insideInkWidget || request.sourcePath.length === 0 || embed === null) {
      return { kind: "ignored" };
    }

    const target = captureTarget(request.editor);
    const sourceFile = this.#dependencies.links.resolveLinkTarget(
      embed.linkpath,
      request.sourcePath,
    );
    if (sourceFile === null) return this.#insertOriginal(request, target);

    let sourceContent: string;
    try {
      sourceContent = (
        await this.#dependencies.documents.readWithMetadataGuard(
          sourceFile.path,
          FILE_SCHEMA_LIMITS.totalInputBytes,
        )
      ).content;
      if (!(await this.#dependencies.validation.validate(sourceContent))) {
        return this.#insertOriginal(request, target);
      }
    } catch {
      return this.#insertOriginal(request, target);
    }

    const choice = await this.#dependencies.choices.choose();
    if (choice === null) return { kind: "cancelled" };
    if (choice === "reference") {
      return replaceIfCurrent(request.editor, target, request.clipboardText)
        ? { kind: "inserted", mode: "reference" }
        : { duplicateTrashed: false, kind: "stale" };
    }
    return this.#duplicate(request, target, sourceContent);
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
      const createdRead = await this.#dependencies.documents.createAndReadBack(
        duplicatePath,
        sourceContent,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      );
      created = true;
      if (
        createdRead.identity.path !== duplicatePath ||
        createdRead.content !== sourceContent ||
        !(await this.#dependencies.validation.validate(createdRead.content))
      ) {
        throw new Error("The created duplicate did not pass read-back validation.");
      }
      const markdown = this.#dependencies.links.generateEmbed(duplicatePath, request.sourcePath);
      if (replaceIfCurrent(request.editor, target, markdown)) {
        return { kind: "inserted", mode: "duplicate" };
      }
      const duplicateTrashed = await this.#trashCreated(duplicatePath);
      created = false;
      return { duplicateTrashed, kind: "stale" };
    } catch (error: unknown) {
      if (created && duplicatePath !== null) await this.#trashCreated(duplicatePath);
      return { error, kind: "failed" };
    }
  }

  #insertOriginal(request: EmbedPasteRequest, target: CapturedEditorTarget): EmbedPasteOutcome {
    return replaceIfCurrent(request.editor, target, request.clipboardText)
      ? { kind: "inserted", mode: "original" }
      : { duplicateTrashed: false, kind: "stale" };
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
export interface EmbedPasteExtensionBoundary {
  handleClipboardPaste(request: EmbedPasteRequest): boolean;
}

export function createEmbedPasteExtensionBoundary(
  controller: EmbedPasteController,
  report: (outcome: EmbedPasteOutcome) => void,
): EmbedPasteExtensionBoundary {
  return {
    handleClipboardPaste: (request) => {
      if (!controller.canHandle(request)) return false;
      void controller.paste(request).then(report);
      return true;
    },
  };
}
