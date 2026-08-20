import {
  StateEffect,
  type AnnotationType,
  type Extension,
  type Facet,
  type StateEffectType,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  ViewPlugin,
  type EditorView,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";

import type {
  HistoryEpoch,
  HostEffectDeliveryV1,
  HostEffectEnvelopeV1,
  HostTransactionSequence,
  ViewId,
} from "../../../application/host-history";
import { isValidEnvelope } from "../../../application/host-history/validation";
import type {
  ImmutableSourceDocumentV1,
  SourceOffsetMapV1,
} from "../../../application/source-coordination";

type InvertEffects = (
  transaction: Transaction,
) => readonly StateEffect<unknown>[];

// The sequencer retains one high-water counter per epoch until editor disposal.
export const MAX_TRACKED_HISTORY_EPOCHS_V1 = 256;

export interface CodeMirrorHistoryCapabilitiesV1 {
  readonly invertedEffects?: Facet<InvertEffects, readonly InvertEffects[]>;
  readonly isolateHistory?: AnnotationType<"after" | "before" | "full">;
}

export interface EditorHistoryAttachmentV1 {
  readonly editorViewId: ViewId;
  readonly ownerViewId: ViewId;
}

export interface EditorHistoryBridgeCallbacksV1 {
  attachEditor(view: EditorView): EditorHistoryAttachmentV1 | null;
  sequenceHighWater(
    editorViewId: ViewId,
    historyEpoch: HistoryEpoch,
  ): HostTransactionSequence | undefined;
  enqueueDelivery(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): void;
  enqueueSourceTransition?(
    editorViewId: ViewId,
    transition: EditorSourceTransitionV1,
  ): void;
  reportMalformed(
    editorViewId: ViewId,
    reason: EditorHistoryBridgeFailureV1,
  ): void;
  detachEditor(editorViewId: ViewId): void;
}

export interface EditorSourceTransitionV1 {
  readonly hostTransactionSequence: HostTransactionSequence;
  readonly offsetMap: SourceOffsetMapV1;
  readonly priorDocument: ImmutableSourceDocumentV1;
  readonly replacementDocument: ImmutableSourceDocumentV1;
}

export type EditorHistoryBridgeFailureV1 =
  | "epoch-limit-exhausted"
  | "invalid-envelope"
  | "multiple-effects-in-transaction"
  | "sequence-exhausted";

interface AvailableEditorHistoryBridgeV1 {
  readonly kind: "available";
  readonly extension: Extension;
  readonly effectType: StateEffectType<HostEffectEnvelopeV1>;
  transaction(envelope: HostEffectEnvelopeV1): TransactionSpec | null;
}

export type EditorHistoryBridgeAvailabilityV1 =
  | AvailableEditorHistoryBridgeV1
  | {
      readonly kind: "unavailable";
      readonly reason: "inverted-effects-unavailable" | "isolation-unavailable";
    };

export function createEditorHistoryBridgeV1(
  capabilities: CodeMirrorHistoryCapabilitiesV1,
  callbacks: EditorHistoryBridgeCallbacksV1,
): EditorHistoryBridgeAvailabilityV1 {
  if (capabilities.invertedEffects === undefined) {
    return Object.freeze({
      kind: "unavailable",
      reason: "inverted-effects-unavailable",
    });
  }
  if (capabilities.isolateHistory === undefined) {
    return Object.freeze({
      kind: "unavailable",
      reason: "isolation-unavailable",
    });
  }

  const effectType = StateEffect.define<HostEffectEnvelopeV1>();
  const invert = createEffectInverter(effectType);
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      readonly #sequencer: EditorHistoryEffectSequencerV1 | null;

      public constructor(view: EditorView) {
        const attachment = callbacks.attachEditor(view);
        if (attachment === null) {
          this.#sequencer = null;
          return;
        }
        this.#sequencer = new EditorHistoryEffectSequencerV1(
          attachment,
          effectType,
          callbacks,
        );
      }

      public update(update: ViewUpdate): void {
        this.#sequencer?.accept(update.transactions);
      }

      public destroy(): void {
        this.#sequencer?.dispose();
      }
    },
  );
  const isolateHistory = capabilities.isolateHistory;
  return Object.freeze({
    effectType,
    extension: Object.freeze([
      capabilities.invertedEffects.of(invert),
      plugin.extension,
    ]),
    kind: "available",
    transaction(envelope: HostEffectEnvelopeV1): TransactionSpec | null {
      if (!isValidEnvelope(envelope) || envelope.direction !== "forward") {
        return null;
      }
      return Object.freeze({
        annotations: isolateHistory.of("full"),
        effects: effectType.of(envelope),
      });
    },
  });
}

export class EditorHistoryEffectSequencerV1 {
  readonly #attachment: EditorHistoryAttachmentV1;
  readonly #effectType: StateEffectType<HostEffectEnvelopeV1>;
  readonly #callbacks: EditorHistoryBridgeCallbacksV1;
  readonly #sequences = new Map<HistoryEpoch, number>();
  readonly #exhausted = new Set<HistoryEpoch>();
  readonly #delivered = new WeakMap<Transaction, HostEffectDeliveryV1>();
  #disposed = false;
  #sourceSequence = 0;

  public constructor(
    attachment: EditorHistoryAttachmentV1,
    effectType: StateEffectType<HostEffectEnvelopeV1>,
    callbacks: EditorHistoryBridgeCallbacksV1,
  ) {
    this.#attachment = attachment;
    this.#effectType = effectType;
    this.#callbacks = callbacks;
  }

  public accept(transactions: readonly Transaction[]): void {
    if (this.#disposed) return;
    for (const transaction of transactions)
      this.#acceptTransaction(transaction);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sequences.clear();
    this.#exhausted.clear();
    this.#callbacks.detachEditor(this.#attachment.editorViewId);
  }

  #acceptTransaction(transaction: Transaction): void {
    this.#acceptSourceTransaction(transaction);
    const priorDelivery = this.#delivered.get(transaction);
    if (priorDelivery !== undefined) {
      this.#enqueue(priorDelivery);
      return;
    }
    const envelopes = transaction.effects
      .filter((effect) => effect.is(this.#effectType))
      .map((effect) => effect.value);
    this.#advanceKnownEpochs();
    if (envelopes.length === 0) return;
    if (envelopes.length > 1) {
      this.#report("multiple-effects-in-transaction");
      return;
    }
    const envelope = envelopes[0];
    if (envelope === undefined || !isValidEnvelope(envelope)) {
      this.#report("invalid-envelope");
      return;
    }
    const sequence = this.#sequenceFor(envelope.historyEpoch);
    if (sequence === null) return;
    const delivery = Object.freeze({
      envelope,
      transactionSequence: sequence as HostTransactionSequence,
    });
    this.#delivered.set(transaction, delivery);
    this.#enqueue(delivery);
  }

  #acceptSourceTransaction(transaction: Transaction): void {
    if (!transaction.docChanged) return;
    if (this.#sourceSequence === Number.MAX_SAFE_INTEGER) {
      this.#report("sequence-exhausted");
      return;
    }
    this.#sourceSequence += 1;
    const spans: SourceOffsetMapV1["spans"][number][] = [];
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      spans.push(
        Object.freeze({
          newFromUtf16: fromB,
          newToUtf16: toB,
          oldFromUtf16: fromA,
          oldToUtf16: toA,
        }),
      );
    });
    this.#callbacks.enqueueSourceTransition?.(
      this.#attachment.editorViewId,
      Object.freeze({
        hostTransactionSequence: this
          .#sourceSequence as HostTransactionSequence,
        offsetMap: Object.freeze({ spans: Object.freeze(spans) }),
        priorDocument: sourceDocumentCapability(transaction.startState.doc),
        replacementDocument: sourceDocumentCapability(transaction.newDoc),
      }),
    );
  }

  #advanceKnownEpochs(): void {
    for (const [epoch, sequence] of this.#sequences) {
      if (this.#exhausted.has(epoch)) continue;
      if (sequence === Number.MAX_SAFE_INTEGER) {
        this.#exhausted.add(epoch);
        this.#report("sequence-exhausted");
        continue;
      }
      this.#sequences.set(epoch, sequence + 1);
    }
  }

  #sequenceFor(epoch: HistoryEpoch): number | null {
    if (this.#exhausted.has(epoch)) return null;
    const existing = this.#sequences.get(epoch);
    if (existing !== undefined) return existing;
    if (this.#sequences.size >= MAX_TRACKED_HISTORY_EPOCHS_V1) {
      this.#report("epoch-limit-exhausted");
      return null;
    }
    const restored = this.#callbacks.sequenceHighWater(
      this.#attachment.editorViewId,
      epoch,
    );
    const sequence = (restored ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) {
      this.#exhausted.add(epoch);
      this.#report("sequence-exhausted");
      return null;
    }
    this.#sequences.set(epoch, sequence);
    return sequence;
  }

  #report(reason: EditorHistoryBridgeFailureV1): void {
    this.#callbacks.reportMalformed(this.#attachment.editorViewId, reason);
  }

  #enqueue(delivery: HostEffectDeliveryV1): void {
    this.#callbacks.enqueueDelivery(
      this.#attachment.editorViewId,
      this.#attachment.ownerViewId,
      delivery,
    );
  }
}

function sourceDocumentCapability(
  document: Transaction["newDoc"],
): ImmutableSourceDocumentV1 {
  const utf16Length = document.length;
  return Object.freeze({
    sliceString(fromUtf16: number, toUtf16: number): string {
      if (
        !Number.isSafeInteger(fromUtf16) ||
        !Number.isSafeInteger(toUtf16) ||
        fromUtf16 < 0 ||
        toUtf16 < fromUtf16 ||
        toUtf16 > utf16Length
      ) {
        throw new RangeError("Invalid immutable source document range.");
      }
      return document.sliceString(fromUtf16, toUtf16);
    },
    utf16Length,
  });
}

function createEffectInverter(
  effectType: StateEffectType<HostEffectEnvelopeV1>,
): InvertEffects {
  return (transaction: Transaction): readonly StateEffect<unknown>[] =>
    transaction.effects
      .filter((effect) => effect.is(effectType))
      .map((effect) => effectType.of(invertEnvelope(effect.value)));
}

function invertEnvelope(envelope: HostEffectEnvelopeV1): HostEffectEnvelopeV1 {
  return Object.freeze({
    ...envelope,
    direction: envelope.direction === "forward" ? "inverse" : "forward",
  });
}
