import { RangeSetBuilder, type EditorState, type Range, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import { findMarkdownInkbookEmbeds, MARKDOWN_EMBED_LIMITS } from "./markdown-embed";
import type { EmbedIntegrationPorts } from "./presentation-port";
import { InkbookLivePreviewWidget, type VisibleEmbed } from "./live-preview-widget";
import { InkbookLoadingPreviewWidget } from "./live-preview-loading-widget";
import type { InkbookDocumentRecognition } from "./document-recognition";
import type { LivePreviewEntrances } from "./live-preview-entrances";

/** Keeps recognition-only updates independent of note parsing and link resolution. */
export class LivePreviewBlocks {
  private constructor(
    readonly decorations: DecorationSet,
    private readonly candidates: ReadonlyMap<string, readonly VisibleEmbed[]>,
    private readonly unavailable: ReadonlySet<string> = new Set(),
  ) {}

  static create(
    state: EditorState,
    ports: EmbedIntegrationPorts,
    entrances: LivePreviewEntrances,
    context: { readonly enabled: boolean; readonly sourcePath: string | undefined },
  ): LivePreviewBlocks {
    const candidates = new Map<string, VisibleEmbed[]>();
    const builder = new RangeSetBuilder<Decoration>();
    if (context.enabled && context.sourcePath !== undefined) {
      for (const embed of findMarkdownInkbookEmbeds(state.doc.toString())) {
        const resolved = ports.resolveDocument(embed.linkpath, context.sourcePath);
        if (resolved === undefined) continue;
        const candidate = {
          from: embed.from,
          to: embed.to,
          resolved,
          sourcePath: context.sourcePath,
        };
        const occurrences = candidates.get(resolved.documentId) ?? [];
        occurrences.push(candidate);
        candidates.set(resolved.documentId, occurrences);
        const decoration = decorate(candidate, ports, entrances);
        if (decoration !== undefined) builder.add(embed.from, embed.to, decoration);
      }
    }
    return new LivePreviewBlocks(builder.finish(), candidates);
  }

  mapPlainTextEdit(transaction: Transaction): LivePreviewBlocks | undefined {
    if (this.unavailable.size > 0 || !isPlainTextEdit(transaction)) return undefined;
    const candidates = new Map<string, VisibleEmbed[]>();
    for (const [documentId, occurrences] of this.candidates) {
      const mapped = occurrences.map((embed) => ({
        ...embed,
        from: transaction.changes.mapPos(embed.from, 1),
        to: transaction.changes.mapPos(embed.to, -1),
      }));
      candidates.set(documentId, mapped);
    }
    return new LivePreviewBlocks(mapDecorations(this.decorations, transaction), candidates);
  }

  visitVisible(
    ranges: readonly { readonly from: number; readonly to: number }[],
    visit: (embed: VisibleEmbed) => void,
  ): void {
    for (const [documentId, occurrences] of this.candidates) {
      if (this.unavailable.has(documentId)) continue;
      for (const embed of occurrences) {
        if (ranges.some((range) => embed.from >= range.from && embed.to <= range.to)) visit(embed);
      }
    }
  }

  has(documentId: string): boolean {
    return this.candidates.has(documentId);
  }

  suppressUnavailable(ids: ReadonlySet<string>): LivePreviewBlocks {
    if (ids.size === 0) return this;
    const unavailable = new Set(this.unavailable);
    for (const id of ids) if (this.candidates.has(id)) unavailable.add(id);
    if (unavailable.size === this.unavailable.size) return this;
    const decorations = this.decorations.update({
      filter: (_from, _to, decoration) => {
        const widget = (decoration.spec as { readonly widget: unknown }).widget;
        return !(
          widget instanceof InkbookLoadingPreviewWidget && unavailable.has(widget.documentId)
        );
      },
    });
    return new LivePreviewBlocks(decorations, this.candidates, unavailable);
  }

  refresh(
    changed: ReadonlySet<string>,
    ports: EmbedIntegrationPorts,
    entrances: LivePreviewEntrances,
  ): LivePreviewBlocks {
    if (changed.size === 0) return this;
    const replacements = new Map<number, InkbookLivePreviewWidget | undefined>();
    const unavailable = new Set(this.unavailable);
    const add = [];
    for (const documentId of changed) {
      // A save invalidation keeps the mounted safe preview until validation completes.
      const preview = ports.documents.cached(documentId);
      if (preview === undefined) continue;
      unavailable.delete(documentId);
      for (const candidate of this.candidates.get(documentId) ?? []) {
        const decoration = decorate(candidate, ports, entrances, preview);
        const widget = (decoration?.spec as { readonly widget?: unknown } | undefined)?.widget;
        replacements.set(
          candidate.from,
          widget instanceof InkbookLivePreviewWidget ? widget : undefined,
        );
        if (decoration !== undefined) add.push(decoration.range(candidate.from, candidate.to));
      }
    }
    if (replacements.size === 0) return this;
    return new LivePreviewBlocks(
      this.decorations.update({
        filter: (from, _to, previous) => {
          const widget = replacements.get(from);
          if (widget === undefined) return !replacements.has(from);
          const previousWidget = (previous.spec as { readonly widget: unknown }).widget;
          if (previousWidget instanceof InkbookLivePreviewWidget) {
            widget.retainHeightFrom(previousWidget);
          }
          return false;
        },
        add,
        sort: true,
      }),
      this.candidates,
      unavailable,
    );
  }
}

function decorate(
  embed: VisibleEmbed,
  ports: EmbedIntegrationPorts,
  entrances: LivePreviewEntrances,
  preview: InkbookDocumentRecognition | undefined = ports.documents.cached(
    embed.resolved.documentId,
  ),
): Decoration | undefined {
  if (preview === false) return undefined;
  const entrance = entrances.stateFor(embed.from, embed.to, embed.resolved.documentId);
  return Decoration.replace({
    block: true,
    widget:
      preview === undefined
        ? new InkbookLoadingPreviewWidget(embed.resolved.documentId, ports, entrance)
        : new InkbookLivePreviewWidget(
            {
              from: embed.from,
              to: embed.to,
              resolved: embed.resolved,
              sourcePath: embed.sourcePath,
              preview,
            },
            ports,
            entrance,
          ),
  });
}

/** Only edits wholly inside an ordinary prose line can bypass global Markdown parsing. */
function isPlainTextEdit(transaction: Transaction): boolean {
  if (
    transaction.startState.doc.length > MARKDOWN_EMBED_LIMITS.inputBytes / 4 ||
    transaction.newDoc.length > MARKDOWN_EMBED_LIMITS.inputBytes / 4
  )
    return false;
  let safe = true;
  transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    const line = transaction.startState.doc.lineAt(from);
    const insertedText = inserted.toString();
    const updatedLine =
      line.text.slice(0, from - line.from) + insertedText + line.text.slice(to - line.from);
    if (
      to > line.to ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 ]*$/u.test(line.text) ||
      !/^[a-zA-Z0-9 ]*$/u.test(insertedText) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 ]*$/u.test(updatedLine)
    )
      safe = false;
  });
  return safe;
}

function mapDecorations(decorations: DecorationSet, transaction: Transaction): DecorationSet {
  const mapped = decorations.map(transaction.changes);
  const replacements = new Set<number>();
  const add: Array<Range<Decoration>> = [];
  mapped.between(0, transaction.newDoc.length, (from, to, decoration) => {
    const widget = (decoration.spec as { readonly widget: unknown }).widget;
    if (!(widget instanceof InkbookLivePreviewWidget)) return;
    const updated = widget.withRange(from, to);
    if (updated === widget) return;
    replacements.add(from);
    add.push(Decoration.replace({ block: true, widget: updated }).range(from, to));
  });
  return replacements.size === 0
    ? mapped
    : mapped.update({ filter: (from) => !replacements.has(from), add });
}
