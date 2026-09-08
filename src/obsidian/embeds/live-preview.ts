import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import {
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
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
import type { InkbookDocumentRecognition } from "./document-recognition";
import { createInkbookLockedPreview } from "./locked-preview";
import { PresentationController } from "./presentation-controller";
import type { EmbedIntegrationPorts, ResolvedInkbookDocument } from "./presentation-port";
import { samePreviewContentIdentity } from "./safe-preview-svg";

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

interface RecognizedVisibleEmbed extends VisibleEmbed {
  readonly preview: Exclude<InkbookDocumentRecognition, false>;
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
  return isExecutableEmbedState(view.state, from, to);
}

function isExecutableEmbedState(state: EditorState, from: number, to: number): boolean {
  if (from < 0 || to <= from || !syntaxTreeAvailable(state, to)) return false;
  let suppressed = false;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.to <= from || node.from >= to) return;
      if (SUPPRESSED_EMBED_ANCESTORS.has(node.name)) suppressed = true;
    },
    from,
    to,
  });
  return !suppressed;
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
    const executableRanges: ExecutableSyntaxRange[] = [];
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
      executableRanges.push(syntax);
    });
    if (!complete) return null;
    const parsed = findMarkdownInkbookEmbeds(range.text);
    for (const embed of parsed) {
      if (embeds.length >= MARKDOWN_EMBED_LIMITS.matches) {
        exceeded = true;
        break;
      }
      const from = range.from + embed.from;
      const to = range.from + embed.to;
      if (!executableRanges.some((syntax) => syntax.from === from && syntax.to === to)) continue;
      embeds.push({
        from,
        linkpath: embed.linkpath,
        to,
      });
    }
  }
  return exceeded || invalidSyntaxOrder ? null : embeds;
}

function livePreviewContext(view: EditorView): LivePreviewContext {
  return livePreviewStateContext(view.state);
}

function livePreviewStateContext(state: EditorState): LivePreviewContext {
  return {
    enabled: state.field(editorLivePreviewField, false) ?? false,
    sourcePath: state.field(editorInfoField, false)?.file?.path,
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
): readonly RecognizedVisibleEmbed[] {
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
      const visibleText = state.doc.sliceString(range.from, range.to);
      for (const embed of findMarkdownInkbookEmbeds(visibleText)) {
        const from = range.from + embed.from;
        const to = range.from + embed.to;
        if (isExecutableEmbedSyntax(view, from, to)) visit({ from, to });
      }
      return true;
    },
  );
  return candidates.flatMap((candidate) => {
    const documentId = candidate.resolved.documentId;
    const recognized = ports.documents.cached(documentId);
    if (recognized === undefined) void ports.documents.recognize(documentId);
    return recognized === undefined || recognized === false
      ? []
      : [{ ...candidate, preview: recognized }];
  });
}

export class InkbookLivePreviewWidget extends WidgetType {
  readonly #embed: RecognizedVisibleEmbed;
  readonly #ports: EmbedIntegrationPorts;

  constructor(embed: RecognizedVisibleEmbed, ports: EmbedIntegrationPorts) {
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
      this.#embed.resolved.resourceUrl === other.#embed.resolved.resourceUrl &&
      samePreviewContentIdentity(
        this.#embed.preview.contentIdentity,
        other.#embed.preview.contentIdentity,
      )
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const root = view.dom.createDiv({
      attr: { contenteditable: "false" },
      cls: "inkbook-root inkbook-embed-root",
    });
    root.remove();
    const button = root.createEl("button", {
      attr: { "aria-label": "Edit handwriting", type: "button" },
      cls: "inkbook-locked-preview",
    });
    const preview = createInkbookLockedPreview(button, this.#embed.preview);

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
      {
        contentIdentity: this.#embed.preview.contentIdentity,
        element: preview.element,
        refresh: preview.refresh,
        requestHostMeasure: () => view.requestMeasure(),
        setDescriptor: preview.setDescriptor,
        setAspectRatio: preview.setAspectRatio,
        setSource: preview.setSource,
      },
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

function buildStateDecorations(state: EditorState, ports: EmbedIntegrationPorts): DecorationSet {
  const context = livePreviewStateContext(state);
  if (!context.enabled || context.sourcePath === undefined) return Decoration.none;
  const text = state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  for (const embed of findMarkdownInkbookEmbeds(text)) {
    const resolved = ports.resolveDocument(embed.linkpath, context.sourcePath);
    if (resolved === undefined) continue;
    const preview = ports.documents.cached(resolved.documentId);
    if (preview === undefined || preview === false) continue;
    builder.add(
      embed.from,
      embed.to,
      Decoration.replace({
        block: true,
        widget: new InkbookLivePreviewWidget(
          {
            from: embed.from,
            preview,
            resolved,
            sourcePath: context.sourcePath,
            to: embed.to,
          },
          ports,
        ),
      }),
    );
  }
  return builder.finish();
}

function changedRecognitionsArePending(
  state: EditorState,
  ports: EmbedIntegrationPorts,
  changedDocumentIds: ReadonlySet<string>,
): boolean {
  const context = livePreviewStateContext(state);
  if (!context.enabled || context.sourcePath === undefined) return false;
  const relevantDocumentIds = new Set<string>();
  for (const embed of findMarkdownInkbookEmbeds(state.doc.toString())) {
    const resolved = ports.resolveDocument(embed.linkpath, context.sourcePath);
    if (resolved !== undefined && changedDocumentIds.has(resolved.documentId)) {
      relevantDocumentIds.add(resolved.documentId);
    }
  }
  return (
    relevantDocumentIds.size > 0 &&
    [...relevantDocumentIds].every((documentId) => ports.documents.cached(documentId) === undefined)
  );
}

export function createLivePreviewExtension(ports: EmbedIntegrationPorts): Extension {
  const blockDecorations = StateField.define<DecorationSet>({
    create: (state) => buildStateDecorations(state, ports),
    provide: (field) => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
    update: (decorations, transaction) => {
      const changedDocumentIds = new Set(
        transaction.effects.flatMap((effect) =>
          effect.is(documentRecognitionChanged) ? [effect.value] : [],
        ),
      );
      const recognitionChanged = changedDocumentIds.size > 0;
      const previousContext = livePreviewStateContext(transaction.startState);
      const currentContext = livePreviewStateContext(transaction.state);
      if (
        recognitionChanged &&
        !transaction.docChanged &&
        previousContext.enabled === currentContext.enabled &&
        previousContext.sourcePath === currentContext.sourcePath &&
        changedRecognitionsArePending(transaction.state, ports, changedDocumentIds)
      ) {
        return decorations;
      }
      return transaction.docChanged ||
        recognitionChanged ||
        previousContext.enabled !== currentContext.enabled ||
        previousContext.sourcePath !== currentContext.sourcePath
        ? buildStateDecorations(transaction.state, ports)
        : decorations;
    },
  });
  return Prec.highest([
    blockDecorations,
    ViewPlugin.fromClass(
      class {
        #context: LivePreviewContext;
        readonly #releaseRecognition: () => void;

        constructor(view: EditorView) {
          this.#context = livePreviewContext(view);
          void findVisibleEmbeds(view, ports);
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
            void findVisibleEmbeds(update.view, ports);
          }
          this.#context = context;
        }

        destroy(): void {
          this.#releaseRecognition();
        }
      },
    ),
  ]);
}
