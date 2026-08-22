import { MarkdownView, type App, type Editor } from "obsidian";

import type {
  LivePreviewEmbedReference,
  PresentationEmbedReference,
  ReadingViewEmbedReference,
} from "../embeds/presentation-port";
import { findMarkdownInkbookEmbeds, MARKDOWN_EMBED_LIMITS } from "../embeds/markdown-embed";
import type { ObsidianLinkAdapter } from "../vault/links";
import type { ObsidianVaultFileAdapter } from "../vault/file-adapter";
import { resolvePresentationEmbedRange } from "./embed-reference-resolution";

export interface EmbedTargetReplacementPorts {
  readonly app: App;
  readonly files: ObsidianVaultFileAdapter;
  readonly links: ObsidianLinkAdapter;
}

interface ResolvedReplacement {
  readonly markdown: string;
}

function prepareReplacement(
  reference: PresentationEmbedReference,
  savedPath: string,
  ports: EmbedTargetReplacementPorts,
): ResolvedReplacement | undefined {
  let normalizedSavedPath: string;
  let markdown: string;
  try {
    normalizedSavedPath = ports.files.resolveFile(savedPath).path;
    if (normalizedSavedPath === reference.documentId) return undefined;
    markdown = ports.links.generateEmbed(normalizedSavedPath, reference.sourcePath);
  } catch {
    return undefined;
  }
  const generated = findMarkdownInkbookEmbeds(markdown);
  if (
    generated.length !== 1 ||
    generated[0]?.from !== 0 ||
    generated[0].to !== markdown.length ||
    markdown.includes("\n")
  ) {
    return undefined;
  }
  return { markdown };
}

function activeEditor(app: App, reference: LivePreviewEmbedReference): Editor | undefined {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (view === null || view.file?.path !== reference.sourcePath) return undefined;
  return view.editor;
}

function replaceLivePreviewTarget(
  reference: LivePreviewEmbedReference,
  replacement: ResolvedReplacement,
  ports: EmbedTargetReplacementPorts,
  isCurrent: () => boolean,
): boolean {
  const editor = activeEditor(ports.app, reference);
  if (editor === undefined) return false;
  const text = editor.getValue();
  const range = resolvePresentationEmbedRange(text, reference, ports.links);
  if (range === undefined) return false;
  try {
    const from = editor.offsetToPos(range.from);
    const to = editor.offsetToPos(range.to);
    if (editor.getRange(from, to) !== range.markdown || !isCurrent()) return false;
    editor.replaceRange(replacement.markdown, from, to);
    return true;
  } catch {
    return false;
  }
}

async function replaceReadingViewTarget(
  reference: ReadingViewEmbedReference,
  replacement: ResolvedReplacement,
  ports: EmbedTargetReplacementPorts,
  isCurrent: () => boolean,
): Promise<boolean> {
  let expectedContent: string;
  try {
    expectedContent = (
      await ports.files.readWithMetadataGuard(
        reference.sourcePath,
        MARKDOWN_EMBED_LIMITS.inputBytes,
      )
    ).content;
  } catch {
    return false;
  }
  if (
    !isCurrent() ||
    resolvePresentationEmbedRange(expectedContent, reference, ports.links) === undefined
  ) {
    return false;
  }

  let replaced = false;
  let expectedOutput: string | undefined;
  try {
    const processed = await ports.files.process(reference.sourcePath, (current) => {
      if (!isCurrent()) throw new Error("stale-recovery-operation");
      if (current !== expectedContent) throw new Error("stale-reading-view-reference");
      const range = resolvePresentationEmbedRange(current, reference, ports.links);
      if (range === undefined) throw new Error("unresolved-reading-view-reference");
      replaced = true;
      expectedOutput = `${current.slice(0, range.from)}${replacement.markdown}${current.slice(range.to)}`;
      return expectedOutput;
    });
    if (processed !== expectedOutput) return false;
  } catch {
    return false;
  }
  return replaced;
}

export async function replacePresentationEmbedTarget(
  reference: PresentationEmbedReference,
  savedPath: string,
  ports: EmbedTargetReplacementPorts,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isCurrent()) return false;
  const replacement = prepareReplacement(reference, savedPath, ports);
  if (replacement === undefined) return false;
  return reference.kind === "live-preview"
    ? replaceLivePreviewTarget(reference, replacement, ports, isCurrent)
    : replaceReadingViewTarget(reference, replacement, ports, isCurrent);
}
