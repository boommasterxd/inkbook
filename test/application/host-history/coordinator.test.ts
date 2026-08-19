import { describe, expect, it, vi } from "vitest";

import {
  HostHistoryCoordinatorV1,
  type HistoryEntryId,
  type HostDispatchIntentV1,
  type HostEffectDeliveryV1,
  type HostEffectEnvelopeV1,
  type HostEffectId,
  type HostEffectRecoveryPortV1,
  type HostHistoryCoordinatorConfigV1,
  type HostTransactionSequence,
  type OperationId,
  type PrepareHostEffectResultV1,
  type ViewId,
} from "../../../src/application/host-history";

const NOTE = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/probe.md",
});
const PANE_A = "view_a" as ViewId;
const PANE_B = "view_b" as ViewId;
const EDITOR_A = "editor_a" as ViewId;
const EDITOR_B = "editor_b" as ViewId;
const FIRST_SEQUENCE = 1 as HostTransactionSequence;
const SECOND_SEQUENCE = (FIRST_SEQUENCE + 1) as HostTransactionSequence;
const THIRD_SEQUENCE = (SECOND_SEQUENCE + 1) as HostTransactionSequence;
const FOURTH_SEQUENCE = (THIRD_SEQUENCE + 1) as HostTransactionSequence;

describe("HostHistoryCoordinatorV1", () => {
  it("applies initial Forward once and creates fresh revision-bound Undo and Redo intents", async () => {
    const harness = createHarness();
    const prepared = prepare(harness.coordinator, PANE_A, "one", null, "B");

    const forward = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );
    const duplicate = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );
    const inverseEnvelope = invert(prepared.envelope);
    const undo = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(inverseEnvelope, SECOND_SEQUENCE),
    );
    const redo = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, THIRD_SEQUENCE),
    );

    expect(forward).toMatchObject({
      kind: "accepted",
      scene: { annotation: "B", revision: 1 },
    });
    expect(duplicate).toMatchObject({
      kind: "duplicate",
      scene: { annotation: "B", revision: 1 },
    });
    expect(undo).toMatchObject({
      kind: "accepted",
      scene: { annotation: null, revision: 2 },
    });
    expect(redo).toMatchObject({
      kind: "accepted",
      scene: { annotation: "B", revision: 3 },
    });
    expect(harness.recorded.map(({ intent }) => intent.direction)).toEqual([
      "forward",
      "undo",
      "redo",
    ]);
    expect(
      new Set(harness.recorded.map(({ intent }) => intent.operationId)).size,
    ).toBe(THIRD_SEQUENCE);
    expect(
      harness.recorded.map(({ intent }) => intent.expectedSceneRevision),
    ).toEqual([0, FIRST_SEQUENCE, SECOND_SEQUENCE]);
  });
});

describe("HostHistoryCoordinatorV1 invalid delivery", () => {
  it("rejects delayed duplicates, stale sequences, and lifecycle-invalid directions", async () => {
    const harness = createHarness();
    const prepared = prepare(harness.coordinator, PANE_A, "one", null, "B");
    const inverseEnvelope = invert(prepared.envelope);

    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );
    const invalidForward = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, SECOND_SEQUENCE),
    );
    const undo = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(inverseEnvelope, THIRD_SEQUENCE),
    );
    const delayedForward = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );
    const delayedInverse = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(inverseEnvelope, SECOND_SEQUENCE),
    );

    expect(invalidForward).toEqual({
      kind: "rejected",
      reason: "lifecycle-mismatch",
    });
    expect(undo.kind).toBe("accepted");
    expect(delayedForward).toEqual({
      kind: "rejected",
      reason: "stale-sequence",
    });
    expect(delayedInverse).toEqual({
      kind: "rejected",
      reason: "stale-sequence",
    });
    expect(harness.coordinator.scene).toEqual({
      annotation: null,
      revision: SECOND_SEQUENCE,
    });
  });
});

describe("HostHistoryCoordinatorV1 sequencing and ownership", () => {
  it("serializes rapid alternating deliveries without revision ABA", async () => {
    const harness = createHarness();
    const prepared = prepare(harness.coordinator, PANE_A, "one", null, "B");
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );

    const results = await Promise.all([
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(invert(prepared.envelope), SECOND_SEQUENCE),
      ),
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(prepared.envelope, THIRD_SEQUENCE),
      ),
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(invert(prepared.envelope), FOURTH_SEQUENCE),
      ),
    ]);

    expect(results.map(({ kind }) => kind)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(harness.coordinator.scene).toEqual({
      annotation: null,
      revision: FOURTH_SEQUENCE,
    });
    expect(
      harness.recorded.map(({ intent }) => intent.expectedSceneRevision),
    ).toEqual([0, FIRST_SEQUENCE, SECOND_SEQUENCE, THIRD_SEQUENCE]);
  });

  it("keeps a single pane lease and permanently rejects an earlier epoch after handoff", async () => {
    const harness = createHarness();
    const first = prepare(harness.coordinator, PANE_A, "one", null, "B");
    const paneBConflict = harness.coordinator.prepare({
      effectId: "eff_two" as HostEffectId,
      historyEntryId: "he_two" as HistoryEntryId,
      patch: { prior: null, replacement: "C" },
      viewId: PANE_B,
    });
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(first.envelope, FIRST_SEQUENCE),
    );

    expect(paneBConflict).toEqual({ kind: "rejected", reason: "non-owner" });
    expect(harness.coordinator.closeOwner(PANE_A, true)).toBe(true);
    const second = prepare(harness.coordinator, PANE_B, "two", "B", "C");
    const stale = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(invert(first.envelope), SECOND_SEQUENCE),
    );
    const accepted = await harness.coordinator.deliver(
      EDITOR_B,
      PANE_B,
      delivery(second.envelope, FIRST_SEQUENCE),
    );

    expect(second.envelope.historyEpoch).toBe(SECOND_SEQUENCE);
    expect(stale).toEqual({ kind: "rejected", reason: "stale-epoch" });
    expect(accepted.kind).toBe("accepted");
    expect(harness.coordinator.scene).toEqual({
      annotation: "C",
      revision: SECOND_SEQUENCE,
    });
  });
});

describe("HostHistoryCoordinatorV1 retention and recovery", () => {
  it("releases the unreachable redo branch when a new original Forward is observed", async () => {
    const released = vi.fn();
    const harness = createHarness({ onRelease: released });
    const first = prepare(harness.coordinator, PANE_A, "one", null, "B");
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(first.envelope, FIRST_SEQUENCE),
    );
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(invert(first.envelope), SECOND_SEQUENCE),
    );
    const branch = prepare(harness.coordinator, PANE_A, "two", null, "C");
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(branch.envelope, THIRD_SEQUENCE),
    );

    expect(released).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: "eff_one" }),
    );
    const unreachableRedo = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(first.envelope, FOURTH_SEQUENCE),
    );
    expect(unreachableRedo).toEqual({
      kind: "rejected",
      reason: "entry-not-found",
    });
    expect(harness.coordinator.scene).toEqual({
      annotation: "C",
      revision: THIRD_SEQUENCE,
    });
  });

  it("fails closed when durable host acknowledgement cannot be recorded", async () => {
    const harness = createHarness({ recoveryResult: false });
    const prepared = prepare(harness.coordinator, PANE_A, "one", null, "B");

    const result = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );

    expect(result).toEqual({ kind: "rejected", reason: "recovery-failed" });
    expect(harness.coordinator.scene).toEqual({
      annotation: null,
      revision: 0,
    });
    expect(harness.coordinator.lease).toEqual({
      kind: "blocked",
      reason: "recovery-failed",
    });
  });
});

describe("HostHistoryCoordinatorV1 restart and bounds", () => {
  it("restores actionable entries and sequence high-water before accepting a reachable Undo", async () => {
    const firstHarness = createHarness();
    const prepared = prepare(
      firstHarness.coordinator,
      PANE_A,
      "one",
      null,
      "B",
    );
    await firstHarness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );
    const disposal = firstHarness.coordinator.disposeForReload(true);
    expect(disposal.kind).toBe("snapshot");
    if (disposal.kind !== "snapshot")
      throw new Error("Expected reload snapshot");

    const restoredHarness = createHarness({
      restore: {
        hostEffectsMayBeReachable: true,
        snapshot: disposal.snapshot,
      },
    });
    const undo = await restoredHarness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(invert(prepared.envelope), SECOND_SEQUENCE),
    );
    const missingSnapshot = createHarness({
      restore: { hostEffectsMayBeReachable: true },
    }).coordinator;

    expect(
      restoredHarness.coordinator.sequenceHighWater(
        EDITOR_A,
        prepared.envelope.historyEpoch,
      ),
    ).toBe(SECOND_SEQUENCE);
    expect(undo).toMatchObject({
      kind: "accepted",
      scene: { annotation: null, revision: 2 },
    });
    expect(missingSnapshot.lease).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });
    expect(
      missingSnapshot.prepare({
        effectId: "eff_blocked" as HostEffectId,
        historyEntryId: "he_blocked" as HistoryEntryId,
        patch: { prior: null, replacement: "X" },
        viewId: PANE_A,
      }),
    ).toEqual({ kind: "rejected", reason: "blocked" });
  });

  it("does not snapshot while an acknowledgement delivery remains unsettled", async () => {
    let resolveRecovery: ((value: boolean) => void) | undefined;
    const recovery: HostEffectRecoveryPortV1 = {
      record: () =>
        new Promise<boolean>((resolve) => {
          resolveRecovery = resolve;
        }),
    };
    const harness = createHarness({ recovery });
    const prepared = prepare(harness.coordinator, PANE_A, "one", null, "B");
    const pending = harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, FIRST_SEQUENCE),
    );

    expect(harness.coordinator.disposeForReload(true)).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });
    resolveRecovery?.(true);
    await pending;
    expect(harness.coordinator.scene).toEqual({
      annotation: null,
      revision: 0,
    });
    expect(harness.coordinator.lease.kind).toBe("blocked");
  });

  it("rejects an entry before lease acquisition when its bounded payload cannot fit", () => {
    const harness = createHarness({ maxPayloadBytes: 1 });
    const result = harness.coordinator.prepare({
      effectId: "eff_large" as HostEffectId,
      historyEntryId: "he_large" as HistoryEntryId,
      patch: { prior: null, replacement: "payload" },
      viewId: PANE_A,
    });

    expect(result).toEqual({ kind: "rejected", reason: "payload-limit" });
    expect(harness.coordinator.lease).toEqual({ kind: "unowned" });
  });
});

interface HarnessOptions {
  readonly maxPayloadBytes?: number;
  readonly onRelease?: HostHistoryCoordinatorConfigV1["onRelease"];
  readonly recovery?: HostEffectRecoveryPortV1;
  readonly recoveryResult?: boolean;
  readonly restore?: ConstructorParameters<typeof HostHistoryCoordinatorV1>[1];
}

function createHarness(options: HarnessOptions = {}): {
  readonly coordinator: HostHistoryCoordinatorV1;
  readonly recorded: { readonly intent: HostDispatchIntentV1 }[];
} {
  let operation = 0;
  const recorded: { readonly intent: HostDispatchIntentV1 }[] = [];
  const recovery = options.recovery ?? {
    record: async (intent: HostDispatchIntentV1): Promise<boolean> => {
      recorded.push({ intent });
      return options.recoveryResult ?? true;
    },
  };
  const config: HostHistoryCoordinatorConfigV1 = {
    createOperationId: () => `op_${String(++operation)}` as OperationId,
    initialAnnotation: null,
    noteIdentity: NOTE,
    recovery,
    ...(options.maxPayloadBytes === undefined
      ? {}
      : { limits: { maxPayloadBytes: options.maxPayloadBytes } }),
    ...(options.onRelease === undefined
      ? {}
      : { onRelease: options.onRelease }),
  };
  return {
    coordinator: new HostHistoryCoordinatorV1(config, options.restore),
    recorded,
  };
}

function prepare(
  coordinator: HostHistoryCoordinatorV1,
  viewId: ViewId,
  suffix: string,
  prior: string | null,
  replacement: string,
): Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }> {
  const result = coordinator.prepare({
    effectId: `eff_${suffix}` as HostEffectId,
    historyEntryId: `he_${suffix}` as HistoryEntryId,
    patch: { prior, replacement },
    viewId,
  });
  if (result.kind !== "prepared")
    throw new Error(`Preparation failed: ${result.reason}`);
  return result;
}

function delivery(
  envelope: HostEffectEnvelopeV1,
  transactionSequence: HostTransactionSequence,
): HostEffectDeliveryV1 {
  return Object.freeze({ envelope, transactionSequence });
}

function invert(envelope: HostEffectEnvelopeV1): HostEffectEnvelopeV1 {
  return Object.freeze({
    ...envelope,
    direction: envelope.direction === "forward" ? "inverse" : "forward",
  });
}
