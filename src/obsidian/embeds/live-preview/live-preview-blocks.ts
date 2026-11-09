import {
  RangeSetBuilder,
  RangeValue,
  type ChangeDesc,
  type EditorState,
  type Range,
  type RangeSet,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import { findMarkdownInkbookEmbeds, MARKDOWN_EMBED_LIMITS } from "../markdown-embed";
import type { EmbedIntegrationPorts } from "../presentation/presentation-port";
import { InkbookLivePreviewWidget, type VisibleEmbed } from "./live-preview-widget";
import type { InkbookDocumentRecognition } from "../preview/document-recognition";
import type { LivePreviewEntrances } from "./live-preview-entrances";

class EmbedCandidate extends RangeValue {
  override startSide = 1;
  override endSide = -1;

  constructor(readonly embed: VisibleEmbed) {
    super();
  }
}

/** Keeps recognition-only updates independent of note parsing and link resolution. */
export class LivePreviewBlocks {
  private constructor(
    readonly decorations: DecorationSet,
    private readonly candidates: ReadonlyMap<string, readonly VisibleEmbed[]>,
    private readonly candidateRanges: RangeSet<EmbedCandidate>,
    // Lookup occurrences keep their parse-time coordinates; only targeted refreshes translate them.
    private readonly candidateChanges?: ChangeDesc,
  ) {}

  static create(
    state: EditorState,
    ports: EmbedIntegrationPorts,
    entrances: LivePreviewEntrances,
    context: { readonly enabled: boolean; readonly sourcePath: string | undefined },
  ): LivePreviewBlocks {
    const candidates = new Map<string, VisibleEmbed[]>();
    const builder = new RangeSetBuilder<Decoration>();
    const candidateRanges = new RangeSetBuilder<EmbedCandidate>();
    if (context.enabled && context.sourcePath !== undefined) {
      for (const embed of findMarkdownInkbookEmbeds(state.doc.toString())) {
        const resolved = ports.resolveDocument(embed.linkpath, context.sourcePath);
        if (resolved === undefined) continue;
        const candidate = {
          ...(embed.description === undefined ? {} : { description: embed.description }),
          ...(embed.width === undefined ? {} : { width: embed.width }),
          from: embed.from,
          to: embed.to,
          resolved,
          sourcePath: context.sourcePath,
        };
        const occurrences = candidates.get(resolved.documentId) ?? [];
        occurrences.push(candidate);
        candidates.set(resolved.documentId, occurrences);
        candidateRanges.add(embed.from, embed.to, new EmbedCandidate(candidate));
        const decoration = decorate(candidate, ports, entrances);
        if (decoration !== undefined) builder.add(embed.from, embed.to, decoration);
      }
    }
    return new LivePreviewBlocks(builder.finish(), candidates, candidateRanges.finish());
  }

  mapPlainTextEdit(transaction: Transaction): LivePreviewBlocks | undefined {
    if (!isPlainTextEdit(transaction)) return undefined;
    return new LivePreviewBlocks(
      mapDecorations(this.decorations, transaction),
      this.candidates,
      this.candidateRanges.map(transaction.changes),
      this.candidateChanges?.composeDesc(transaction.changes) ?? transaction.changes.desc,
    );
  }

  visitVisible(
    ranges: readonly { readonly from: number; readonly to: number }[],
    visit: (embed: VisibleEmbed) => void,
  ): void {
    const visited = new Set<number>();
    let coveredTo = -1;
    for (const range of [...ranges].sort((a, b) => a.from - b.from || b.to - a.to)) {
      if (range.to <= coveredTo) continue;
      coveredTo = range.to;
      this.candidateRanges.between(range.from, range.to, (from, to, candidate) => {
        if (from < range.from || to > range.to || visited.has(from)) return;
        visited.add(from);
        visit({ ...candidate.embed, from, to });
      });
    }
  }

  has(documentId: string): boolean {
    return this.candidates.has(documentId);
  }

  refresh(
    changed: ReadonlySet<string>,
    ports: EmbedIntegrationPorts,
    entrances: LivePreviewEntrances,
  ): LivePreviewBlocks {
    if (changed.size === 0) return this;
    const replacements = new Map<number, InkbookLivePreviewWidget | undefined>();
    const add = [];
    for (const documentId of changed) {
      // A save invalidation keeps the mounted safe preview until validation completes.
      const preview = ports.documents.cached(documentId);
      if (preview === undefined) continue;
      for (const candidate of this.candidates.get(documentId) ?? []) {
        const from = this.candidateChanges?.mapPos(candidate.from, 1) ?? candidate.from;
        const to = this.candidateChanges?.mapPos(candidate.to, -1) ?? candidate.to;
        const decoration = decorate({ ...candidate, from, to }, ports, entrances, preview);
        const widget = (decoration?.spec as { readonly widget?: unknown } | undefined)?.widget;
        replacements.set(from, widget instanceof InkbookLivePreviewWidget ? widget : undefined);
        if (decoration !== undefined) add.push(decoration.range(from, to));
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
      this.candidateRanges,
      this.candidateChanges,
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
  if (preview === false || preview === undefined) return undefined;
  const entrance = entrances.stateFor(embed.from, embed.to, embed.resolved.documentId);
  return Decoration.replace({
    block: true,
    widget: new InkbookLivePreviewWidget({ ...embed, preview }, ports, entrance),
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
