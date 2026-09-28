import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import {
  Prec,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";

import type { EmbedIntegrationPorts } from "./presentation-port";
import { LivePreviewBlocks } from "./live-preview-blocks";
import {
  documentRecognitionChanged,
  documentRecognitionUnavailable,
} from "./live-preview-recognition-effects";
import { LivePreviewEntrances } from "./live-preview-entrances";

export interface LivePreviewContext {
  readonly enabled: boolean;
  readonly sourcePath: string | undefined;
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

function recognizeVisibleEmbeds(
  view: EditorView,
  blocks: LivePreviewBlocks,
  ports: EmbedIntegrationPorts,
): void {
  const pending = new Set<string>();
  blocks.visitVisible(view.visibleRanges, (embed) => {
    const documentId = embed.resolved.documentId;
    if (
      !pending.has(documentId) &&
      ports.documents.cached(documentId) === undefined &&
      isExecutableEmbedSyntax(view, embed.from, embed.to)
    ) {
      pending.add(documentId);
      void ports.documents.recognize(documentId, view.dom.ownerDocument.defaultView);
    }
  });
}

export function createLivePreviewExtension(ports: EmbedIntegrationPorts): Extension {
  const entrances = StateField.define<LivePreviewEntrances>({
    create: (state) => new LivePreviewEntrances(livePreviewStateContext(state).sourcePath),
    update: (value, transaction) =>
      value.update(transaction.changes, livePreviewStateContext(transaction.state).sourcePath),
  });
  const blockDecorations = StateField.define<LivePreviewBlockState>({
    create: (state) => ({
      context: livePreviewStateContext(state),
      blocks: LivePreviewBlocks.create(
        state,
        ports,
        state.field(entrances),
        livePreviewStateContext(state),
      ),
    }),
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.blocks.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).blocks.decorations),
    ],
    update: (value, transaction) => {
      const previousContext = value.context;
      const currentContext = livePreviewStateContext(transaction.state);
      if (
        transaction.docChanged &&
        previousContext.enabled === currentContext.enabled &&
        previousContext.sourcePath === currentContext.sourcePath
      ) {
        const blocks = value.blocks.mapPlainTextEdit(transaction);
        if (blocks !== undefined) return { context: currentContext, blocks };
      }
      if (
        transaction.docChanged ||
        previousContext.enabled !== currentContext.enabled ||
        previousContext.sourcePath !== currentContext.sourcePath
      ) {
        return {
          context: currentContext,
          blocks: LivePreviewBlocks.create(
            transaction.state,
            ports,
            transaction.state.field(entrances),
            currentContext,
          ),
        };
      }
      if (transaction.effects.length === 0) return value;
      const blocks = refreshRecognizedBlocks(value.blocks, transaction, ports, entrances);
      return blocks === value.blocks ? value : { context: currentContext, blocks };
    },
  });
  return Prec.highest([
    entrances,
    blockDecorations,
    ViewPlugin.fromClass(
      class {
        #context: LivePreviewContext;
        readonly #releaseRecognition: () => void;

        constructor(view: EditorView) {
          this.#context = livePreviewContext(view);
          recognizeVisibleEmbeds(view, view.state.field(blockDecorations).blocks, ports);
          this.#releaseRecognition = subscribeRecognitions(view, ports, blockDecorations);
        }

        update(update: ViewUpdate): void {
          const context = livePreviewContext(update.view);
          const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
          if (syntaxChanged || shouldRefreshLivePreview(update, this.#context, context)) {
            recognizeVisibleEmbeds(update.view, update.state.field(blockDecorations).blocks, ports);
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

interface LivePreviewBlockState {
  readonly context: LivePreviewContext;
  readonly blocks: LivePreviewBlocks;
}

function refreshRecognizedBlocks(
  blocks: LivePreviewBlocks,
  transaction: Transaction,
  ports: EmbedIntegrationPorts,
  entrances: StateField<LivePreviewEntrances>,
): LivePreviewBlocks {
  let changed: Set<string> | undefined;
  let unavailable: Set<string> | undefined;
  for (const effect of transaction.effects) {
    if (effect.is(documentRecognitionChanged)) {
      for (const id of effect.value) {
        changed ??= new Set();
        changed.add(id);
      }
    } else if (effect.is(documentRecognitionUnavailable)) {
      unavailable ??= new Set();
      unavailable.add(effect.value);
    }
  }
  if (unavailable !== undefined) blocks = blocks.suppressUnavailable(unavailable);
  return changed === undefined
    ? blocks
    : blocks.refresh(changed, ports, transaction.state.field(entrances));
}

function subscribeRecognitions(
  view: EditorView,
  ports: EmbedIntegrationPorts,
  field: StateField<LivePreviewBlockState>,
): () => void {
  let disposed = false;
  let scheduled = false;
  let queuedBlocks = view.state.field(field).blocks;
  const pending = new Set<string>();
  const release = ports.documents.subscribe((documentId) => {
    const ownerWindow = view.dom.ownerDocument.defaultView;
    if (ownerWindow === null || !view.state.field(field).blocks.has(documentId)) return;
    const blocks = view.state.field(field).blocks;
    if (blocks !== queuedBlocks) {
      for (const id of pending) if (!blocks.has(id)) pending.delete(id);
      queuedBlocks = blocks;
    }
    pending.add(documentId);
    if (scheduled) return;
    scheduled = true;
    ownerWindow.queueMicrotask(() => {
      if (disposed) return;
      const currentBlocks = view.state.field(field).blocks;
      const changed = [...pending].filter((id) => currentBlocks.has(id));
      pending.clear();
      scheduled = false;
      if (changed.length === 0) return;
      view.dispatch({ effects: documentRecognitionChanged.of(changed) });
      for (const id of changed) {
        if (view.state.field(field).blocks.has(id) && ports.documents.cached(id) === undefined)
          void ports.documents.recognize(id, view.dom.ownerDocument.defaultView);
      }
    });
  });
  return () => {
    disposed = true;
    pending.clear();
    release();
  };
}
