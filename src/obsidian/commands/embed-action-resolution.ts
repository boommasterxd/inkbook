import { MarkdownView, type App, type Editor } from "obsidian";

import { findMarkdownInkbookEmbeds, MARKDOWN_EMBED_LIMITS } from "../embeds/markdown-embed";
import type { PresentationEmbedReference } from "../embeds/presentation-port";
import type { ObsidianLinkAdapter } from "../vault/links";
import type { ObsidianVaultFileAdapter } from "../vault/file-adapter";
import {
  resolvePresentationEmbedRange,
  type ResolvedEmbedRange,
} from "./embed-reference-resolution";

export type EmbedActionUnavailableReason =
  | "ambiguous-embed"
  | "document-not-found"
  | "editor-changed"
  | "embed-not-found"
  | "no-active-markdown-view"
  | "no-owner-window"
  | "no-source-file";

export type ExactEmbedActionTarget = PresentationEmbedReference | string;

export interface ResolvedEmbedActionReference {
  readonly content: string;
  readonly editor?: Editor;
  readonly filePath: string;
  readonly match: ResolvedEmbedRange;
  readonly ownerWindow: Window;
  readonly presentation?: PresentationEmbedReference;
  readonly targetPath: string;
}

export interface EmbedActionResolutionPorts {
  readonly app: App;
  readonly files: ObsidianVaultFileAdapter;
  readonly links: ObsidianLinkAdapter;
}

function ownerWindowOf(view: MarkdownView): Window | undefined {
  return view.containerEl?.ownerDocument.defaultView ?? undefined;
}

function resolveTargetPath(
  target: ExactEmbedActionTarget,
  files: ObsidianVaultFileAdapter,
): string | undefined {
  try {
    return files.resolveFile(typeof target === "string" ? target : target.documentId).path;
  } catch {
    return undefined;
  }
}

function uniqueStringTarget(
  content: string,
  sourcePath: string,
  targetPath: string,
  links: ObsidianLinkAdapter,
): ResolvedEmbedRange | "ambiguous-embed" | undefined {
  const matches = findMarkdownInkbookEmbeds(content).filter(
    (embed) => links.resolveLinkTarget(embed.linkpath, sourcePath)?.path === targetPath,
  );
  if (matches.length > 1) return "ambiguous-embed";
  const match = matches[0];
  return match === undefined
    ? undefined
    : { from: match.from, markdown: match.markdown, to: match.to };
}

async function currentContent(
  target: PresentationEmbedReference,
  editor: Editor | undefined,
  files: ObsidianVaultFileAdapter,
): Promise<string | undefined> {
  if (target.kind === "live-preview") return editor?.getValue();
  try {
    return (await files.readWithMetadataGuard(target.sourcePath, MARKDOWN_EMBED_LIMITS.inputBytes))
      .content;
  } catch {
    return undefined;
  }
}

export async function resolveEmbedActionReference(
  target: ExactEmbedActionTarget,
  ports: EmbedActionResolutionPorts,
): Promise<ResolvedEmbedActionReference | EmbedActionUnavailableReason> {
  const view = ports.app.workspace.getActiveViewOfType(MarkdownView);
  if (view === null) return "no-active-markdown-view";
  if (view.file === null) return "no-source-file";
  const sourcePath = typeof target === "string" ? view.file.path : target.sourcePath;
  if (view.file.path !== sourcePath) return "embed-not-found";
  const ownerWindow = ownerWindowOf(view);
  if (ownerWindow === undefined) return "no-owner-window";
  const targetPath = resolveTargetPath(target, ports.files);
  if (targetPath === undefined) return "document-not-found";
  const editor = view.editor;
  if ((typeof target === "string" || target.kind === "live-preview") && editor === undefined) {
    return "no-active-markdown-view";
  }
  const content =
    typeof target === "string"
      ? editor?.getValue()
      : await currentContent(target, editor, ports.files);
  if (content === undefined) return "embed-not-found";
  const resolved =
    typeof target === "string"
      ? uniqueStringTarget(content, sourcePath, targetPath, ports.links)
      : resolvePresentationEmbedRange(content, target, ports.links);
  if (resolved === "ambiguous-embed") return resolved;
  if (resolved === undefined) return "embed-not-found";
  return {
    content,
    ...(typeof target === "string" || target.kind === "live-preview" ? { editor } : {}),
    filePath: sourcePath,
    match: resolved,
    ownerWindow,
    ...(typeof target === "string" ? {} : { presentation: target }),
    targetPath,
  };
}

export async function removeResolvedEmbed(
  reference: ResolvedEmbedActionReference,
  ports: EmbedActionResolutionPorts,
): Promise<boolean> {
  if (reference.editor !== undefined) {
    try {
      const from = reference.editor.offsetToPos(reference.match.from);
      const to = reference.editor.offsetToPos(reference.match.to);
      if (reference.editor.getRange(from, to) !== reference.match.markdown) return false;
      reference.editor.replaceRange("", from, to);
      return true;
    } catch {
      return false;
    }
  }
  const presentation = reference.presentation;
  if (presentation?.kind !== "reading-view") return false;
  let expectedOutput: string | undefined;
  try {
    const processed = await ports.files.process(reference.filePath, (current) => {
      if (current !== reference.content) throw new Error("stale-reading-view-reference");
      const range = resolvePresentationEmbedRange(current, presentation, ports.links);
      if (range === undefined) throw new Error("unresolved-reading-view-reference");
      expectedOutput = `${current.slice(0, range.from)}${current.slice(range.to)}`;
      return expectedOutput;
    });
    return expectedOutput !== undefined && processed === expectedOutput;
  } catch {
    return false;
  }
}
