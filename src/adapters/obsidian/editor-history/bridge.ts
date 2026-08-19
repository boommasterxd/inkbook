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
import type { EditorInputProbeContract } from "../../../input/phase-zero";
import { isValidEnvelope } from "../../../application/host-history/validation";
import { CodeMirrorInputProbeBinding } from "./input-probe-binding";

type InvertEffects = (
  transaction: Transaction,
) => readonly StateEffect<unknown>[];

export interface CodeMirrorHistoryCapabilitiesV1 {
  readonly invertedEffects?: Facet<InvertEffects, readonly InvertEffects[]>;
  readonly isolateHistory?: AnnotationType<"after" | "before" | "full">;
}

export interface EditorHistoryAttachmentV1 {
  readonly editorViewId: ViewId;
  readonly ownerViewId: ViewId;
  readonly inputProbe?: EditorInputProbeContract;
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
  reportMalformed(
    editorViewId: ViewId,
    reason: EditorHistoryBridgeFailureV1,
  ): void;
  detachEditor(editorViewId: ViewId): void;
}

export type EditorHistoryBridgeFailureV1 =
  | "attachment-unavailable"
  | "invalid-envelope"
  | "multiple-effects-in-transaction"
  | "sequence-exhausted";

export interface AvailableEditorHistoryBridgeV1 {
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
      readonly #input: CodeMirrorInputProbeBinding | null;

      public constructor(view: EditorView) {
        const attachment = callbacks.attachEditor(view);
        if (attachment === null) {
          this.#sequencer = null;
          this.#input = null;
          return;
        }
        this.#sequencer = new EditorHistoryEffectSequencerV1(
          attachment,
          effectType,
          callbacks,
        );
        this.#input =
          attachment.inputProbe === undefined
            ? null
            : new CodeMirrorInputProbeBinding(view, attachment.inputProbe);
      }

      public update(update: ViewUpdate): void {
        this.#sequencer?.accept(update.transactions);
        this.#input?.update(update);
      }

      public destroy(): void {
        this.#input?.dispose();
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
  #disposed = false;

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
    this.#callbacks.detachEditor(this.#attachment.editorViewId);
  }

  #acceptTransaction(transaction: Transaction): void {
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
    this.#callbacks.enqueueDelivery(
      this.#attachment.editorViewId,
      this.#attachment.ownerViewId,
      Object.freeze({
        envelope,
        transactionSequence: sequence as HostTransactionSequence,
      }),
    );
  }

  #advanceKnownEpochs(): void {
    for (const [epoch, sequence] of this.#sequences) {
      if (sequence === Number.MAX_SAFE_INTEGER) {
        this.#report("sequence-exhausted");
        continue;
      }
      this.#sequences.set(epoch, sequence + 1);
    }
  }

  #sequenceFor(epoch: HistoryEpoch): number | null {
    const existing = this.#sequences.get(epoch);
    if (existing !== undefined) return existing;
    const restored = this.#callbacks.sequenceHighWater(
      this.#attachment.editorViewId,
      epoch,
    );
    const sequence = (restored ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) {
      this.#report("sequence-exhausted");
      return null;
    }
    this.#sequences.set(epoch, sequence);
    return sequence;
  }

  #report(reason: EditorHistoryBridgeFailureV1): void {
    this.#callbacks.reportMalformed(this.#attachment.editorViewId, reason);
  }
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
