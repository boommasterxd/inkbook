/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact history sequences and scene revisions are the fixtures under test. */
import { describe, expect, it, vi } from "vitest";

import { createHistoryEpoch } from "../../../src/domain/operations";
import { createHostTransactionSequence } from "../../../src/application/note-session";
import { HostHistoryCoordinatorV1 } from "../../../src/application/host-history";
import {
  createHostHistoryHarness as createHarness,
  historyDelivery as delivery,
  HOST_HISTORY_EDITOR_A as EDITOR_A,
  HOST_HISTORY_EDITOR_B as EDITOR_B,
  HOST_HISTORY_PANE_A as PANE_A,
  HOST_HISTORY_PANE_B as PANE_B,
  invertHistoryEnvelope as invert,
  prepareHostHistory as prepare,
  prepareHostHistoryResult as prepareResult,
} from "./recovery-fixture";

describe("HostHistoryCoordinatorV1", () => {
  it("applies real forward, undo, and redo operations with durable recovery", async () => {
    const harness = createHarness();
    const prepared = await prepare(harness.coordinator, PANE_A, 1, 0);

    const forward = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );
    const duplicate = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );
    const undo = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(invert(prepared.envelope), 2),
    );
    const redo = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 3),
    );

    if (forward.kind !== "accepted") throw new Error("Expected acceptance.");
    expect(forward.affectedIds.elementIds).toHaveLength(1);
    expect(forward.affectedIds.groupIds).toEqual([]);
    expect(Object.isFrozen(forward.affectedIds)).toBe(true);
    expect(Object.isFrozen(forward.affectedIds.elementIds)).toBe(true);
    expect(Object.isFrozen(forward.affectedIds.groupIds)).toBe(true);
    expect(forward.recoveryAttempt).toMatchObject({
      attemptId: harness.prepareAttempts[0]?.attemptId,
      kind: "host-recorded-forward",
    });
    expect(Object.isFrozen(forward.recoveryAttempt)).toBe(true);
    expect(Object.isFrozen(forward.recoveryAttempt.acknowledgement)).toBe(true);
    expect(sceneSummary(forward)).toEqual({ elements: 1, revision: 1 });
    expect(sceneSummary(duplicate)).toEqual({ elements: 1, revision: 1 });
    expect(sceneSummary(undo)).toEqual({ elements: 0, revision: 2 });
    expect(sceneSummary(redo)).toEqual({ elements: 1, revision: 3 });
    if (undo.kind !== "accepted" || redo.kind !== "accepted") {
      throw new Error("Expected accepted direction deliveries.");
    }
    expect(undo.recoveryAttempt.kind).toBe("host-recorded-undo");
    expect(redo.recoveryAttempt.kind).toBe("host-recorded-redo");
    expect(harness.recordedDirections).toEqual([
      "forward",
      "inverse",
      "forward",
    ]);
    expect(new Set(harness.operationIds).size).toBe(3);
    expect(harness.prepareAttempts).toHaveLength(1);
    expect(harness.directionAttempts.map(({ kind }) => kind)).toEqual([
      "host-recorded-undo",
      "host-recorded-redo",
    ]);
  });
});

describe("HostHistoryCoordinatorV1 delivery sequencing", () => {
  it("rejects reentrant direct deliveries while preserving the active turn", async () => {
    const harness = createHarness();
    const prepared = await prepare(harness.coordinator, PANE_A, 1, 0);
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );

    const results = await Promise.all([
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(invert(prepared.envelope), 2),
      ),
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(prepared.envelope, 3),
      ),
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(invert(prepared.envelope), 4),
      ),
    ]);

    expect(results.map(({ kind }) => kind)).toEqual([
      "accepted",
      "rejected",
      "rejected",
    ]);
    expect(harness.coordinator.scene.revision).toBe(2);
    expect(
      harness.coordinator.sequenceHighWater(EDITOR_A, createHistoryEpoch(1)),
    ).toBe(createHostTransactionSequence(2));
    expect(harness.expectedSceneRevisions).toEqual([0, 1]);
  });

  it("rejects stale sequences and keeps the scene unchanged", async () => {
    const harness = createHarness();
    const prepared = await prepare(harness.coordinator, PANE_A, 1, 0);
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );

    expect(
      await harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(prepared.envelope, 0),
      ),
    ).toEqual({ kind: "rejected", reason: "invalid-sequence" });
    expect(harness.coordinator.scene.revision).toBe(1);
  });
});

describe("HostHistoryCoordinatorV1 delivery bounds", () => {
  it("rejects reentrant delivery before retention processing", async () => {
    const harness = createHarness({
      holdRecord: true,
      maxActionableEntries: 1,
    });
    const prepared = await prepare(harness.coordinator, PANE_A, 1, 0);
    const pending = harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );
    await harness.recordStarted;
    expect(harness.coordinator.scene.revision).toBe(0);

    await expect(
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(prepared.envelope, 2),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "pending-admission" });

    harness.releaseRecord();
    expect((await pending).kind).toBe("accepted");
  });
});

describe("HostHistoryCoordinatorV1 lease and branching", () => {
  it("releases the unreachable branch and advances the lease epoch", async () => {
    const released = vi.fn();
    const harness = createHarness({ onRelease: released });
    const first = await prepare(harness.coordinator, PANE_A, 1, 0);
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(first.envelope, 1),
    );
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(invert(first.envelope), 2),
    );

    const branch = await prepare(harness.coordinator, PANE_A, 1, 1);
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(branch.envelope, 3),
    );
    expect(released).toHaveBeenCalledOnce();

    expect(harness.coordinator.closeOwner(PANE_A, true)).toBe(true);
    const next = await prepare(harness.coordinator, PANE_B, 2, 2);
    const stale = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(invert(branch.envelope), 4),
    );
    const accepted = await harness.coordinator.deliver(
      EDITOR_B,
      PANE_B,
      delivery(next.envelope, 1),
    );

    expect(next.envelope.historyEpoch).toBe(createHistoryEpoch(2));
    expect(stale).toEqual({ kind: "rejected", reason: "stale-epoch" });
    expect(sceneSummary(accepted)).toEqual({ elements: 2, revision: 4 });
  });
});

describe("HostHistoryCoordinatorV1 recovery and lifecycle", () => {
  it("processes a delivery directly inside the owning session turn", async () => {
    const harness = createHarness();
    const prepared = await prepare(harness.coordinator, PANE_A, 1, 0);

    const result = await harness.coordinator.deliverInSessionTurn(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );

    expect(sceneSummary(result)).toEqual({ elements: 1, revision: 1 });
  });

  it("retries a failed prepare without publishing lease or history", async () => {
    const harness = createHarness({ prepareFailures: 1 });
    const first = await prepareResult(harness.coordinator, PANE_A, 1, 0);
    expect(first).toEqual({ kind: "rejected", reason: "recovery-failed" });
    expect(harness.coordinator.lease).toEqual({ kind: "unowned" });

    const second = await prepare(harness.coordinator, PANE_A, 1, 0);
    expect(second.envelope.historyEpoch).toBe(createHistoryEpoch(1));
  });

  it("fails closed when host acknowledgement persistence fails", async () => {
    const harness = createHarness({ recordFailures: 1 });
    const prepared = await prepare(harness.coordinator, PANE_A, 1, 0);
    const result = await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );

    expect(result).toEqual({ kind: "rejected", reason: "recovery-failed" });
    expect(harness.coordinator.scene.revision).toBe(0);
    expect(harness.coordinator.lease).toEqual({
      kind: "blocked",
      reason: "recovery-failed",
    });
  });
});

describe("HostHistoryCoordinatorV1 disposal and restoration", () => {
  it("does not publish a lease after disposal blocks a pending prepare", async () => {
    const harness = createHarness({ holdPrepare: true });
    const pending = prepareResult(harness.coordinator, PANE_A, 1, 0);
    await harness.prepareStarted;

    expect(harness.coordinator.disposeForReload(false)).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });
    harness.releasePrepare();

    await expect(pending).resolves.toEqual({
      kind: "rejected",
      reason: "blocked",
    });
    expect(harness.coordinator.lease).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });
    expect(harness.coordinator.snapshot().entries).toEqual([]);
  });

  it("restores a reachable host history and disposes unreachable history", async () => {
    const firstHarness = createHarness();
    const prepared = await prepare(firstHarness.coordinator, PANE_A, 1, 0);
    await firstHarness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(prepared.envelope, 1),
    );
    const disposal = firstHarness.coordinator.disposeForReload(true);
    expect(disposal.kind).toBe("snapshot");
    if (disposal.kind !== "snapshot") throw new Error("Expected snapshot");

    const restored = createHarness({
      restore: { hostEffectsMayBeReachable: true, snapshot: disposal.snapshot },
    });
    const undo = await restored.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(invert(prepared.envelope), 2),
    );
    expect(sceneSummary(undo)).toEqual({ elements: 0, revision: 2 });
    expect(
      restored.coordinator.sequenceHighWater(EDITOR_A, createHistoryEpoch(1)),
    ).toBe(createHostTransactionSequence(2));

    const disposed = createHarness().coordinator;
    expect(disposed.disposeForReload(false)).toEqual({
      kind: "disposed-unreachable",
    });
    expect(disposed.lease).toEqual({ kind: "unowned" });
  });
});

describe("HostHistoryCoordinatorV1 restored snapshot limits", () => {
  it("enforces the actionable entry limit before publishing a second entry", async () => {
    const harness = createHarness({ maxActionableEntries: 1 });
    const first = await prepare(harness.coordinator, PANE_A, 1, 0);
    await harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(first.envelope, 1),
    );
    expect(await prepareResult(harness.coordinator, PANE_A, 1, 1)).toEqual({
      kind: "rejected",
      reason: "payload-limit",
    });
  });

  it("blocks invalid restored epochs and rejects epoch exhaustion before mutation", async () => {
    const first = createHarness();
    await prepare(first.coordinator, PANE_A, 1, 0);
    const invalidSnapshot = {
      ...first.coordinator.snapshot(),
      nextEpoch: 1,
    };
    const invalidRestore = createHarness({
      restore: {
        hostEffectsMayBeReachable: true,
        snapshot: invalidSnapshot,
      },
    });
    expect(invalidRestore.coordinator.lease).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });

    const emptySnapshot = createHarness().coordinator.snapshot();
    const exhausted = createHarness({
      restore: {
        hostEffectsMayBeReachable: true,
        snapshot: { ...emptySnapshot, nextEpoch: Number.MAX_SAFE_INTEGER },
      },
    });
    await expect(
      prepareResult(exhausted.coordinator, PANE_A, Number.MAX_SAFE_INTEGER, 0),
    ).resolves.toEqual({ kind: "rejected", reason: "payload-limit" });
    expect(exhausted.coordinator.lease).toEqual({ kind: "unowned" });
  });

  it("rejects an invalid configured note identity", () => {
    expect(() =>
      createHarness({
        noteIdentity: {
          vaultIdHint: "vault",
          vaultRelativeMarkdownPath: "../history.md",
        },
      }),
    ).toThrow("note identity is invalid");
  });
});

function sceneSummary(
  result: Awaited<ReturnType<HostHistoryCoordinatorV1["deliver"]>>,
): { readonly elements: number; readonly revision: number } {
  if (result.kind === "rejected")
    throw new Error(`Delivery failed: ${result.reason}`);
  return {
    elements: result.scene.elementsById.size,
    revision: result.scene.revision,
  };
}
