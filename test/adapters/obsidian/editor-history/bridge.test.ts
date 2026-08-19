import {
  Annotation,
  EditorState,
  Facet,
  type Transaction,
} from "@codemirror/state";
import { describe, expect, it } from "vitest";

import type {
  HistoryEntryId,
  HistoryEpoch,
  HostEffectDeliveryV1,
  HostEffectEnvelopeV1,
  HostEffectId,
  HostTransactionSequence,
  ViewId,
} from "../../../../src/application/host-history";
import {
  createEditorHistoryBridgeV1,
  EditorHistoryEffectSequencerV1,
  type CodeMirrorHistoryCapabilitiesV1,
  type EditorHistoryBridgeCallbacksV1,
  type EditorHistoryBridgeFailureV1,
} from "../../../../src/adapters/obsidian/editor-history";

const EDITOR = "editor" as ViewId;
const OWNER = "owner" as ViewId;
const EPOCH = 1 as HistoryEpoch;
const NOTE = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/probe.md",
});

describe("CodeMirror editor history bridge", () => {
  it("creates a real isolated invertible StateEffect without changing Markdown", () => {
    const capabilities = createCapabilities();
    const bridge = createEditorHistoryBridgeV1(
      capabilities,
      createCallbackHarness().callbacks,
    );
    expect(bridge.kind).toBe("available");
    if (bridge.kind !== "available") throw new Error("Bridge unavailable");
    const state = EditorState.create({
      doc: "Markdown A",
      extensions: bridge.extension,
    });
    const spec = bridge.transaction(envelope("forward"));
    expect(spec).not.toBeNull();
    if (spec === null) throw new Error("Expected transaction spec");
    const transaction = state.update(spec);
    const inverter = state.facet(capabilities.invertedEffects)[0];
    if (inverter === undefined) throw new Error("Expected inversion facet");
    const inverse = inverter(transaction);

    expect(transaction.newDoc.toString()).toBe("Markdown A");
    expect(transaction.annotation(capabilities.isolateHistory)).toBe("full");
    expect(inverse).toHaveLength(1);
    expect(inverse[0]?.is(bridge.effectType)).toBe(true);
    expect(inverse[0]?.value).toMatchObject({ direction: "inverse" });

    const undoTransaction = transaction.state.update({ effects: inverse });
    const redo = inverter(undoTransaction);
    expect(redo[0]?.value).toMatchObject({ direction: "forward" });
  });

  it("fails closed when either host-history capability is absent", () => {
    const callbacks = createCallbackHarness().callbacks;
    const capabilities = createCapabilities();

    expect(createEditorHistoryBridgeV1({}, callbacks)).toEqual({
      kind: "unavailable",
      reason: "inverted-effects-unavailable",
    });
    expect(
      createEditorHistoryBridgeV1(
        {
          invertedEffects: capabilities.invertedEffects,
        },
        callbacks,
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "isolation-unavailable",
    });
  });
});

describe("CodeMirror editor history bridge delivery", () => {
  it("delivers effects in transaction order with restored per-editor epoch high-water", () => {
    const capabilities = createCapabilities();
    const restoredHighWater = Number("7") as HostTransactionSequence;
    const harness = createCallbackHarness(restoredHighWater);
    const bridge = createEditorHistoryBridgeV1(capabilities, harness.callbacks);
    if (bridge.kind !== "available") throw new Error("Bridge unavailable");
    const sequencer = new EditorHistoryEffectSequencerV1(
      { editorViewId: EDITOR, ownerViewId: OWNER },
      bridge.effectType,
      harness.callbacks,
    );
    const state = EditorState.create({ doc: "" });
    const markdownA = state.update({ changes: { from: 0, insert: "A" } });
    const effectB = markdownA.state.update({
      effects: bridge.effectType.of(envelope("forward")),
    });
    const markdownC = effectB.state.update({
      changes: { from: 1, insert: "C" },
    });
    const inverseB = markdownC.state.update({
      effects: bridge.effectType.of(envelope("inverse")),
    });

    sequencer.accept([markdownA, effectB, markdownC, inverseB]);

    expect(
      harness.deliveries.map(({ delivery, editorViewId, ownerViewId }) => ({
        editorViewId,
        ownerViewId,
        transactionSequence: delivery.transactionSequence,
      })),
    ).toEqual([
      {
        editorViewId: EDITOR,
        ownerViewId: OWNER,
        transactionSequence: restoredHighWater + 1,
      },
      {
        editorViewId: EDITOR,
        ownerViewId: OWNER,
        transactionSequence: restoredHighWater + 1 + 1 + 1,
      },
    ]);
    expect(inverseB.newDoc.toString()).toBe("AC");
  });

  it("rejects multiple annotation effects in one host transaction and disposes once", () => {
    const capabilities = createCapabilities();
    const harness = createCallbackHarness();
    const bridge = createEditorHistoryBridgeV1(capabilities, harness.callbacks);
    if (bridge.kind !== "available") throw new Error("Bridge unavailable");
    const sequencer = new EditorHistoryEffectSequencerV1(
      { editorViewId: EDITOR, ownerViewId: OWNER },
      bridge.effectType,
      harness.callbacks,
    );
    const transaction = EditorState.create().update({
      effects: [
        bridge.effectType.of(envelope("forward")),
        bridge.effectType.of(envelope("forward")),
      ],
    });

    sequencer.accept([transaction]);
    sequencer.dispose();
    sequencer.dispose();

    expect(harness.deliveries).toEqual([]);
    expect(harness.malformed).toEqual([
      { editorViewId: EDITOR, reason: "multiple-effects-in-transaction" },
    ]);
    expect(harness.detached).toEqual([EDITOR]);
  });

  it("rejects a non-forward admission envelope before dispatch", () => {
    const bridge = createEditorHistoryBridgeV1(
      createCapabilities(),
      createCallbackHarness().callbacks,
    );
    if (bridge.kind !== "available") throw new Error("Bridge unavailable");
    expect(bridge.transaction(envelope("inverse"))).toBeNull();
  });
});

function createCapabilities(): Required<CodeMirrorHistoryCapabilitiesV1> {
  type Inverter = (transaction: Transaction) => readonly never[];
  return {
    invertedEffects: Facet.define<Inverter, readonly Inverter[]>(),
    isolateHistory: Annotation.define<"after" | "before" | "full">(),
  };
}

interface CallbackHarness {
  readonly callbacks: EditorHistoryBridgeCallbacksV1;
  readonly deliveries: {
    readonly editorViewId: ViewId;
    readonly ownerViewId: ViewId;
    readonly delivery: HostEffectDeliveryV1;
  }[];
  readonly detached: ViewId[];
  readonly malformed: {
    readonly editorViewId: ViewId;
    readonly reason: EditorHistoryBridgeFailureV1;
  }[];
}

function createCallbackHarness(
  highWater?: HostTransactionSequence,
): CallbackHarness {
  const deliveries: CallbackHarness["deliveries"] = [];
  const detached: ViewId[] = [];
  const malformed: CallbackHarness["malformed"] = [];
  const callbacks: EditorHistoryBridgeCallbacksV1 = {
    attachEditor: () => ({ editorViewId: EDITOR, ownerViewId: OWNER }),
    detachEditor: (editorViewId) => {
      detached.push(editorViewId);
    },
    enqueueDelivery: (editorViewId, ownerViewId, delivery) => {
      deliveries.push({ delivery, editorViewId, ownerViewId });
    },
    reportMalformed: (editorViewId, reason) => {
      malformed.push({ editorViewId, reason });
    },
    sequenceHighWater: () => highWater,
  };
  return { callbacks, deliveries, detached, malformed };
}

function envelope(direction: "forward" | "inverse"): HostEffectEnvelopeV1 {
  return Object.freeze({
    direction,
    effectId: "eff_probe" as HostEffectId,
    historyEntryId: "he_probe" as HistoryEntryId,
    historyEpoch: EPOCH,
    noteIdentity: NOTE,
  });
}
