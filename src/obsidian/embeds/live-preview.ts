import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";

import { utf8ByteLengthWithinLimit } from "../../persistence/scheduling/utf8-byte-length";
import { findMarkdownInkbookEmbeds, MARKDOWN_EMBED_LIMITS } from "./markdown-embed";
import { browserLockedPreviewSchemeCapability } from "./locked-preview-scheme-capability";
import { PresentationController } from "./presentation-controller";
import type { EmbedIntegrationPorts, ResolvedInkbookDocument } from "./presentation-port";

let nextLivePreviewAttachmentId = 0;
const documentRecognitionChanged = StateEffect.define<string>();

export interface VisibleTextRange {
  readonly from: number;
  readonly to: number;
}

export interface VisibleEmbed {
  readonly from: number;
  readonly resolved: ResolvedInkbookDocument;
  readonly sourcePath: string;
  readonly to: number;
}

export interface LivePreviewContext {
  readonly enabled: boolean;
  readonly sourcePath: string | undefined;
}

interface ExecutableSyntaxRange {
  readonly from: number;
  readonly to: number;
}

export type ExecutableSyntaxIterator = (
  range: VisibleTextRange,
  visit: (syntax: ExecutableSyntaxRange) => void,
) => boolean;

interface BoundedVisibleTextRange extends VisibleTextRange {
  readonly text: string;
}

export function findEmbedsInVisibleRanges(
  readText: (from: number, to: number) => string,
  ranges: readonly VisibleTextRange[],
  sourcePath: string,
  resolveDocument: EmbedIntegrationPorts["resolveDocument"],
  iterateExecutableSyntax: ExecutableSyntaxIterator,
): readonly VisibleEmbed[] {
  const visibleText = readBoundedVisibleText(readText, ranges);
  if (visibleText === null) return [];
  const candidates = collectExecutableEmbeds(visibleText, iterateExecutableSyntax);
  if (candidates === null) return [];
  return candidates.flatMap(({ from, linkpath, to }) => {
    const resolved = resolveDocument(linkpath, sourcePath);
    return resolved === undefined ? [] : [{ from, resolved, sourcePath, to }];
  });
}

const EXECUTABLE_EMBED_NODES = new Set(["Image", "hmd-embed"]);
const SUPPRESSED_EMBED_ANCESTORS = new Set([
  "BlockComment",
  "CodeBlock",
  "Comment",
  "Escape",
  "FencedCode",
  "HTMLComment",
  "InlineCode",
  "LineComment",
]);

export function isExecutableEmbedSyntax(view: EditorView, from: number, to: number): boolean {
  if (from < 0 || to <= from || !syntaxTreeAvailable(view.state, to)) return false;
  let recognized = false;
  let suppressed = false;
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.to <= from || node.from >= to) return;
      if (SUPPRESSED_EMBED_ANCESTORS.has(node.name)) suppressed = true;
      if (node.from === from && node.to === to && EXECUTABLE_EMBED_NODES.has(node.name)) {
        recognized = true;
      }
    },
    from,
    to,
  });
  return recognized && !suppressed;
}

function readBoundedVisibleText(
  readText: (from: number, to: number) => string,
  ranges: readonly VisibleTextRange[],
): readonly BoundedVisibleTextRange[] | null {
  const bounded: BoundedVisibleTextRange[] = [];
  let remainingBytes = MARKDOWN_EMBED_LIMITS.inputBytes;
  let previousTo = 0;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from < previousTo ||
      range.to <= range.from
    ) {
      return null;
    }
    const text = readText(range.from, range.to);
    if (text.length !== range.to - range.from) return null;
    const bytes = utf8ByteLengthWithinLimit(text, remainingBytes);
    if (bytes === null) return null;
    bounded.push({ ...range, text });
    remainingBytes -= bytes;
    previousTo = range.to;
  }
  return bounded;
}

function collectExecutableEmbeds(
  ranges: readonly BoundedVisibleTextRange[],
  iterateExecutableSyntax: ExecutableSyntaxIterator,
): readonly { readonly from: number; readonly linkpath: string; readonly to: number }[] | null {
  const embeds: Array<{ readonly from: number; readonly linkpath: string; readonly to: number }> =
    [];
  let exceeded = false;
  let invalidSyntaxOrder = false;
  let previousSyntaxTo = 0;
  for (const range of ranges) {
    const complete = iterateExecutableSyntax(range, (syntax) => {
      if (
        exceeded ||
        invalidSyntaxOrder ||
        !Number.isSafeInteger(syntax.from) ||
        !Number.isSafeInteger(syntax.to) ||
        syntax.from < range.from ||
        syntax.to > range.to ||
        syntax.to <= syntax.from
      ) {
        invalidSyntaxOrder = true;
        return;
      }
      if (syntax.from < previousSyntaxTo) {
        invalidSyntaxOrder = true;
        return;
      }
      previousSyntaxTo = syntax.to;
      const text = range.text.slice(syntax.from - range.from, syntax.to - range.from);
      const parsed = findMarkdownInkbookEmbeds(text);
      const embed = parsed.length === 1 ? parsed[0] : undefined;
      if (embed === undefined || embed.from !== 0 || embed.to !== text.length) return;
      if (embeds.length >= MARKDOWN_EMBED_LIMITS.matches) {
        exceeded = true;
        return;
      }
      embeds.push({ from: syntax.from, linkpath: embed.linkpath, to: syntax.to });
    });
    if (!complete) return null;
  }
  return exceeded || invalidSyntaxOrder ? null : embeds;
}

function livePreviewContext(view: EditorView): LivePreviewContext {
  return {
    enabled: view.state.field(editorLivePreviewField, false) ?? false,
    sourcePath: view.state.field(editorInfoField, false)?.file?.path,
  };
}

export function shouldRefreshLivePreview(
  update: Pick<ViewUpdate, "docChanged" | "viewportChanged">,
  previous: LivePreviewContext,
  current: LivePreviewContext,
): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    previous.enabled !== current.enabled ||
    previous.sourcePath !== current.sourcePath
  );
}

function findVisibleEmbeds(
  view: EditorView,
  ports: EmbedIntegrationPorts,
): readonly VisibleEmbed[] {
  const context = livePreviewContext(view);
  if (!context.enabled) {
    return [];
  }
  const sourcePath = context.sourcePath;
  if (sourcePath === undefined) {
    return [];
  }
  const state = view.state;
  const lastRange = view.visibleRanges[view.visibleRanges.length - 1];
  let tree: ReturnType<typeof syntaxTree> | undefined;
  let syntaxChecked = false;
  const candidates = findEmbedsInVisibleRanges(
    (from, to) => state.doc.sliceString(from, to),
    view.visibleRanges,
    sourcePath,
    ports.resolveDocument,
    (range, visit) => {
      if (!syntaxChecked) {
        syntaxChecked = true;
        if (lastRange !== undefined && syntaxTreeAvailable(state, lastRange.to)) {
          tree = syntaxTree(state);
        }
      }
      if (tree === undefined) return false;
      let suppressedDepth = 0;
      tree.iterate({
        enter: (node) => {
          if (SUPPRESSED_EMBED_ANCESTORS.has(node.name)) suppressedDepth += 1;
          if (
            suppressedDepth === 0 &&
            node.from >= range.from &&
            node.to <= range.to &&
            EXECUTABLE_EMBED_NODES.has(node.name)
          ) {
            visit({ from: node.from, to: node.to });
          }
        },
        from: range.from,
        leave: (node) => {
          if (SUPPRESSED_EMBED_ANCESTORS.has(node.name)) suppressedDepth -= 1;
        },
        to: range.to,
      });
      return true;
    },
  );
  return candidates.filter((candidate) => {
    const documentId = candidate.resolved.documentId;
    const recognized = ports.documents.cached(documentId);
    if (recognized === undefined) void ports.documents.recognize(documentId);
    return recognized === true;
  });
}

export class InkbookLivePreviewWidget extends WidgetType {
  readonly #embed: VisibleEmbed;
  readonly #ports: EmbedIntegrationPorts;

  constructor(embed: VisibleEmbed, ports: EmbedIntegrationPorts) {
    super();
    this.#embed = embed;
    this.#ports = ports;
  }

  override eq(other: InkbookLivePreviewWidget): boolean {
    return (
      this.#ports === other.#ports &&
      this.#embed.from === other.#embed.from &&
      this.#embed.to === other.#embed.to &&
      this.#embed.sourcePath === other.#embed.sourcePath &&
      this.#embed.resolved.documentId === other.#embed.resolved.documentId &&
      this.#embed.resolved.resourceUrl === other.#embed.resolved.resourceUrl
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const root = view.dom.createSpan({
      attr: { contenteditable: "false" },
      cls: "inkbook-root inkbook-embed-root",
    });
    root.remove();
    const button = root.createEl("button", {
      attr: { "aria-label": "Edit handwriting", type: "button" },
      cls: "inkbook-locked-preview",
    });
    const image = button.createEl("img", {
      attr: { alt: "", src: this.#embed.resolved.resourceUrl },
    });

    const attachmentId = `live-preview-${++nextLivePreviewAttachmentId}`;
    const controller = new PresentationController(
      {
        attachmentId,
        attachmentGeneration: 1,
        documentId: this.#embed.resolved.documentId,
        embedReference: {
          documentId: this.#embed.resolved.documentId,
          from: this.#embed.from,
          kind: "live-preview",
          sourcePath: this.#embed.sourcePath,
          to: this.#embed.to,
        },
        root,
      },
      this.#ports.sessions,
      this.#ports.scheme,
      { capability: browserLockedPreviewSchemeCapability, image },
    );
    controller.mount();
    const activate = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      controller.activate();
    };
    button.addEventListener("click", activate);
    const releaseLifecycle = this.#ports.lifecycle.register(root, () => {
      button.removeEventListener("click", activate);
      controller.dispose();
    });
    if (releaseLifecycle === undefined) {
      button.removeEventListener("click", activate);
      controller.dispose();
    }
    return root;
  }

  override destroy(dom: HTMLElement): void {
    this.#ports.lifecycle.dispose(dom);
  }
}

function buildDecorations(view: EditorView, ports: EmbedIntegrationPorts): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const embed of findVisibleEmbeds(view, ports)) {
    builder.add(
      embed.from,
      embed.to,
      Decoration.replace({ widget: new InkbookLivePreviewWidget(embed, ports) }),
    );
  }
  return builder.finish();
}

export function createLivePreviewExtension(ports: EmbedIntegrationPorts): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      #context: LivePreviewContext;
      readonly #releaseRecognition: () => void;

      constructor(view: EditorView) {
        this.#context = livePreviewContext(view);
        this.decorations = buildDecorations(view, ports);
        this.#releaseRecognition = ports.documents.subscribe((documentId) => {
          view.dispatch({ effects: documentRecognitionChanged.of(documentId) });
        });
      }

      update(update: ViewUpdate): void {
        const context = livePreviewContext(update.view);
        const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
        const recognitionChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(documentRecognitionChanged)),
        );
        if (
          recognitionChanged ||
          syntaxChanged ||
          shouldRefreshLivePreview(update, this.#context, context)
        ) {
          this.decorations = buildDecorations(update.view, ports);
        }
        this.#context = context;
      }

      destroy(): void {
        this.#releaseRecognition();
      }
    },
    { decorations: (value) => value.decorations },
  );
}
