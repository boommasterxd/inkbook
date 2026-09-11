import type { App } from "obsidian";

import { confirmInkbookAction } from "../dialogs/action-dialog";

import { findMarkdownInkbookEmbeds, type MarkdownInkbookEmbed } from "../embeds/markdown-embed";
import type { PresentationEmbedReference } from "../embeds/presentation-port";
import type { ObsidianLinkAdapter } from "../vault/links";
import type { ObsidianManagedFileAdapter } from "../vault/managed-files";
import type { ObsidianVaultFileAdapter } from "../vault/file-adapter";
import {
  removeResolvedEmbed,
  resolveEmbedActionReference,
  type EmbedActionUnavailableReason as ResolutionUnavailableReason,
  type ExactEmbedActionTarget,
  type ResolvedEmbedActionReference,
} from "./embed-action-resolution";
import { replacePresentationEmbedTarget } from "./embed-target-replacement";
import { createObsidianCommandVaultPorts } from "./obsidian-host";

type EmbedActionUnavailableReason =
  ResolutionUnavailableReason | "clipboard-unavailable" | "metadata-unresolved";

export type EmbedActionUnavailable = {
  readonly kind: "unavailable";
  readonly reason: EmbedActionUnavailableReason;
};

export type CopyEmbedOutcome =
  | EmbedActionUnavailable
  | { readonly error: unknown; readonly kind: "failed" }
  | { readonly kind: "copied"; readonly markdown: string };

export type DeleteEmbedOutcome =
  | EmbedActionUnavailable
  | { readonly kind: "cancelled"; readonly stage: "embed" | "file" }
  | { readonly kind: "deleted"; readonly fileDeleted: boolean }
  | { readonly error: unknown; readonly kind: "failed" };

export interface EmbedActionPorts {
  readonly app: App;
  readonly files: ObsidianVaultFileAdapter;
  readonly links: ObsidianLinkAdapter;
  readonly managedFiles: ObsidianManagedFileAdapter;
}

export type EmbedActionTarget = ExactEmbedActionTarget;

function unavailable(reason: EmbedActionUnavailableReason): EmbedActionUnavailable {
  return { kind: "unavailable", reason };
}

function findMatchingReferences(
  content: string,
  sourcePath: string,
  targetPath: string,
  links: ObsidianLinkAdapter,
): readonly MarkdownInkbookEmbed[] {
  return findMarkdownInkbookEmbeds(content).filter((embed) => {
    const target = links.resolveLinkTarget(embed.linkpath, sourcePath);
    return target?.path === targetPath;
  });
}

function sameReference(
  current: ResolvedEmbedActionReference,
  original: ResolvedEmbedActionReference,
): boolean {
  return (
    current.filePath === original.filePath &&
    current.targetPath === original.targetPath &&
    current.ownerWindow === original.ownerWindow &&
    current.editor === original.editor &&
    current.content === original.content &&
    current.match.from === original.match.from
  );
}

export class ObsidianEmbedActions {
  readonly #app: App;
  readonly #files: ObsidianVaultFileAdapter;
  readonly #links: ObsidianLinkAdapter;
  readonly #managedFiles: ObsidianManagedFileAdapter;
  readonly #lifetime = new AbortController();
  #deleting = false;

  constructor(ports: EmbedActionPorts) {
    this.#app = ports.app;
    this.#files = ports.files;
    this.#links = ports.links;
    this.#managedFiles = ports.managedFiles;
  }

  async copyEmbed(target: EmbedActionTarget): Promise<CopyEmbedOutcome> {
    const reference = await this.#resolveReference(target);
    if ("kind" in reference) return reference;

    const markdown = reference.match.markdown;

    const clipboard = reference.ownerWindow.navigator.clipboard;
    if (clipboard === undefined) return unavailable("clipboard-unavailable");
    try {
      await clipboard.writeText(markdown);
    } catch (error: unknown) {
      return { error, kind: "failed" };
    }
    return { kind: "copied", markdown };
  }

  public dispose(): void {
    this.#lifetime.abort();
  }

  async deleteEmbed(target: EmbedActionTarget): Promise<DeleteEmbedOutcome> {
    if (this.#deleting || this.#lifetime.signal.aborted)
      return { kind: "cancelled", stage: "embed" };
    this.#deleting = true;
    try {
      return await this.#deleteEmbed(target);
    } finally {
      this.#deleting = false;
    }
  }

  async #deleteEmbed(target: EmbedActionTarget): Promise<DeleteEmbedOutcome> {
    let reference = await this.#resolveReference(target);
    if ("kind" in reference) return reference;

    const knowledge = this.#referenceKnowledge(reference);
    if (knowledge.state === "unresolved") return unavailable("metadata-unresolved");
    if (!Number.isSafeInteger(knowledge.references) || knowledge.references < 1) {
      return unavailable("metadata-unresolved");
    }

    const original = reference;
    if (
      !(await confirmInkbookAction(this.#app, {
        title: "Delete embed?",
        description:
          knowledge.references === 1
            ? "Remove this embed from the note. The SVG file will be kept unless you choose to move it to trash next."
            : "Remove this embed from the note. The shared SVG file will be kept.",
        confirmLabel: "Delete embed",
        destructive: true,
        signal: this.#lifetime.signal,
      }))
    ) {
      return { kind: "cancelled", stage: "embed" };
    }

    const requestedFileDeletion =
      knowledge.references === 1 &&
      (await confirmInkbookAction(this.#app, {
        title: "Move SVG file to trash?",
        description: `This is the last known reference to “${reference.targetPath}”. You can keep the file or move it to trash.`,
        confirmLabel: "Move to trash",
        cancelLabel: "Keep file",
        destructive: true,
        signal: this.#lifetime.signal,
      }));
    reference = await this.#resolveReference(target);
    if ("kind" in reference) return reference;
    if (this.#lifetime.signal.aborted) return { kind: "cancelled", stage: "file" };
    if (!sameReference(reference, original)) return unavailable("editor-changed");
    const currentKnowledge = this.#referenceKnowledge(reference);
    if (currentKnowledge.state === "unresolved") return unavailable("metadata-unresolved");
    const deleteFile = currentKnowledge.references === 1 && requestedFileDeletion;
    const removed = await removeResolvedEmbed(reference, {
      app: this.#app,
      files: this.#files,
      links: this.#links,
    });
    if (!removed) {
      return unavailable("editor-changed");
    }

    if (!deleteFile) {
      return { fileDeleted: false, kind: "deleted" };
    }
    try {
      await this.#managedFiles.trash(reference.targetPath);
    } catch (error: unknown) {
      return { error, kind: "failed" };
    }
    return { fileDeleted: true, kind: "deleted" };
  }

  async replaceEmbedTarget(
    reference: PresentationEmbedReference,
    savedPath: string,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    return replacePresentationEmbedTarget(
      reference,
      savedPath,
      {
        app: this.#app,
        files: this.#files,
        links: this.#links,
      },
      isCurrent,
    );
  }

  #referenceKnowledge(reference: ResolvedEmbedActionReference) {
    const references = findMatchingReferences(
      reference.content,
      reference.filePath,
      reference.targetPath,
      this.#links,
    ).length;
    return this.#links.referenceKnowledge(reference.targetPath, {
      references,
      sourcePath: reference.filePath,
    });
  }

  async #resolveReference(
    target: EmbedActionTarget,
  ): Promise<ResolvedEmbedActionReference | EmbedActionUnavailable> {
    const reference = await resolveEmbedActionReference(target, {
      app: this.#app,
      files: this.#files,
      links: this.#links,
    });
    return typeof reference === "string" ? unavailable(reference) : reference;
  }
}

export function createObsidianEmbedActions(
  app: App,
  isMetadataResolved: () => boolean,
): ObsidianEmbedActions {
  const { files, links, managedFiles } = createObsidianCommandVaultPorts(app, isMetadataResolved);
  return new ObsidianEmbedActions({
    app,
    files,
    links,
    managedFiles,
  });
}
