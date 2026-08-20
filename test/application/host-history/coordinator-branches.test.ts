/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact epochs, revisions, and sequences define the history scenarios. */
import { describe, expect, it, vi } from "vitest";

import {
  createAnnotationHistoryEntryV1,
  createHistoryEpoch,
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import {
  parseHostEffectId,
  type HostEffectEnvelopeV1,
} from "../../../src/application/note-session";
import type { HostHistoryCoordinatorV1 } from "../../../src/application/host-history";
import {
  createHostHistoryHarness as createHarness,
  historyDelivery as delivery,
  HOST_HISTORY_EDITOR_A as EDITOR_A,
  HOST_HISTORY_NOTE as NOTE,
  HOST_HISTORY_PANE_A as PANE_A,
  HOST_HISTORY_PANE_B as PANE_B,
  invertHistoryEnvelope as invert,
  prepareHostHistory as prepare,
  prepareHostHistoryResult as prepareResult,
} from "./recovery-fixture";

type PrepareRequest = Parameters<HostHistoryCoordinatorV1["prepare"]>[0];

describe("HostHistoryCoordinatorV1 admission branches", () => {
  it("rejects concurrent and duplicate admissions and cancels the sole lease", async () => {
    const released = vi.fn();
    const harness = createHarness({ holdPrepare: true, onRelease: released });
    const pending = prepareResult(harness.coordinator, PANE_A, 1, 0);
    await harness.prepareStarted;

    await expect(
      prepareResult(harness.coordinator, PANE_A, 1, 1),
    ).resolves.toEqual({ kind: "rejected", reason: "pending-admission" });
    expect(
      harness.coordinator.rekeyNoteIdentity(NOTE, {
        ...NOTE,
        vaultRelativeMarkdownPath: "Notes/blocked-rename.md",
      }),
    ).toBe(false);

    harness.releasePrepare();
    const admitted = await pending;
    if (admitted.kind !== "prepared") throw new Error("Expected admission.");
    await expect(
      prepareResult(harness.coordinator, PANE_A, 1, 0),
    ).resolves.toEqual({ kind: "rejected", reason: "duplicate-identity" });
    await expect(
      prepareResult(harness.coordinator, PANE_A, 1, 1),
    ).resolves.toEqual({ kind: "rejected", reason: "pending-admission" });

    expect(
      harness.coordinator.cancelAdmission(
        admitted.envelope.effectId,
        createHistoryEpoch(2),
      ),
    ).toBe(false);
    expect(
      harness.coordinator.cancelAdmission(
        admitted.envelope.effectId,
        createHistoryEpoch(1),
      ),
    ).toBe(true);
    expect(harness.coordinator.lease).toEqual({ kind: "unowned" });
    expect(released).toHaveBeenCalledOnce();
  });

  it("rejects malformed operation identities and duplicate scene mutation", async () => {
    const harness = createHarness();
    const admitted = await prepare(harness.coordinator, PANE_A, 1, 0);
    const entry = harness.coordinator.snapshot().entries[0];
    if (entry === undefined) throw new Error("Expected actionable entry.");
    expect(
      harness.coordinator.cancelAdmission(
        admitted.envelope.effectId,
        createHistoryEpoch(1),
      ),
    ).toBe(true);

    const nextHistory = createAnnotationHistoryEntryV1({
      forward: entry.historyEntry.forward,
      historyEntryId: parseHistoryEntryId(identifier("he", 80)),
      historyEpoch: createHistoryEpoch(2),
    });
    if (!nextHistory.ok) throw new Error("Expected valid history.");
    const baseRequest: PrepareRequest = {
      effectId: parseHostEffectId(identifier("eff", 80)),
      historyEntry: nextHistory.value,
      operationId: parseOperationId(identifier("op", 80)),
      viewId: PANE_A,
    };
    await expect(
      harness.coordinator.prepare({
        ...baseRequest,
        operationId: "invalid-operation-id" as PrepareRequest["operationId"],
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "invalid-operation" });

    const duplicateHarness = createHarness();
    const first = await prepare(duplicateHarness.coordinator, PANE_A, 1, 0);
    await duplicateHarness.coordinator.deliverInSessionTurn(
      EDITOR_A,
      PANE_A,
      delivery(first.envelope, 1),
    );
    const duplicateHistory = createAnnotationHistoryEntryV1({
      forward: entry.historyEntry.forward,
      historyEntryId: parseHistoryEntryId(identifier("he", 81)),
      historyEpoch: createHistoryEpoch(1),
    });
    if (!duplicateHistory.ok) throw new Error("Expected valid history.");
    await expect(
      duplicateHarness.coordinator.prepare({
        effectId: parseHostEffectId(identifier("eff", 81)),
        historyEntry: duplicateHistory.value,
        operationId: parseOperationId(identifier("op", 81)),
        viewId: PANE_A,
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "invalid-operation" });
  });
});

describe("HostHistoryCoordinatorV1 delivery branches", () => {
  it("rejects malformed, non-owner, missing, and mismatched deliveries", async () => {
    const harness = createHarness();
    const admitted = await prepare(harness.coordinator, PANE_A, 1, 0);
    const invalidNote = {
      ...admitted.envelope,
      noteIdentity: { ...NOTE, vaultRelativeMarkdownPath: "../invalid.md" },
    } as HostEffectEnvelopeV1;
    const missingEntry = {
      ...admitted.envelope,
      effectId: parseHostEffectId(identifier("eff", 90)),
    };
    const mismatchedEntry = {
      ...admitted.envelope,
      historyEntryId: parseHistoryEntryId(identifier("he", 90)),
    };

    await expect(
      harness.coordinator.deliverInSessionTurn(
        EDITOR_A,
        PANE_A,
        delivery(invalidNote, 1),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "invalid-envelope" });
    await expect(
      harness.coordinator.deliverInSessionTurn(
        EDITOR_A,
        PANE_B,
        delivery(admitted.envelope, 1),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "non-owner" });
    await expect(
      harness.coordinator.deliverInSessionTurn(
        EDITOR_A,
        PANE_A,
        delivery(missingEntry, 1),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "entry-not-found" });
    await expect(
      harness.coordinator.deliverInSessionTurn(
        EDITOR_A,
        PANE_A,
        delivery(mismatchedEntry, 1),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "invalid-envelope" });

    expect(
      harness.coordinator.cancelAdmission(
        admitted.envelope.effectId,
        createHistoryEpoch(1),
      ),
    ).toBe(true);
    await expect(
      harness.coordinator.deliverInSessionTurn(
        EDITOR_A,
        PANE_A,
        delivery(admitted.envelope, 1),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "stale-epoch" });
  });
});

describe("HostHistoryCoordinatorV1 delivery lifecycle", () => {
  it("rejects lifecycle mismatch and releases only an undone entry", async () => {
    const released = vi.fn();
    const harness = createHarness({ onRelease: released });
    const admitted = await prepare(harness.coordinator, PANE_A, 1, 0);
    expect(
      (
        await harness.coordinator.deliverInSessionTurn(
          EDITOR_A,
          PANE_A,
          delivery(admitted.envelope, 1),
        )
      ).kind,
    ).toBe("accepted");
    await expect(
      harness.coordinator.deliverInSessionTurn(
        EDITOR_A,
        PANE_A,
        delivery(admitted.envelope, 2),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "lifecycle-mismatch" });
    expect(
      harness.coordinator.releaseUnreachable(
        admitted.envelope.effectId,
        createHistoryEpoch(1),
      ),
    ).toBe(false);
    expect(
      (
        await harness.coordinator.deliverInSessionTurn(
          EDITOR_A,
          PANE_A,
          delivery(invert(admitted.envelope), 3),
        )
      ).kind,
    ).toBe("accepted");
    expect(
      harness.coordinator.releaseUnreachable(
        admitted.envelope.effectId,
        createHistoryEpoch(1),
      ),
    ).toBe(true);
    expect(released).toHaveBeenCalledOnce();
  });
});

describe("HostHistoryCoordinatorV1 lifecycle branches", () => {
  it("blocks reachable close and missing reachable restoration", async () => {
    const harness = createHarness();
    const admitted = await prepare(harness.coordinator, PANE_A, 1, 0);
    await harness.coordinator.deliverInSessionTurn(
      EDITOR_A,
      PANE_A,
      delivery(admitted.envelope, 1),
    );
    expect(harness.coordinator.closeOwner(PANE_B, true)).toBe(false);
    expect(harness.coordinator.closeOwner(PANE_A, false)).toBe(false);
    expect(harness.coordinator.lease).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });
    expect(harness.coordinator.disposeForReload(true)).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });

    const missing = createHarness({
      restore: { hostEffectsMayBeReachable: true },
    });
    expect(missing.coordinator.lease).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });
    await expect(
      prepareResult(missing.coordinator, PANE_A, 1, 0),
    ).resolves.toEqual({ kind: "rejected", reason: "blocked" });
  });

  it("releases unreachable disposal exactly once and rejects later work", async () => {
    const released = vi.fn();
    const harness = createHarness({ onRelease: released });
    const admitted = await prepare(harness.coordinator, PANE_A, 1, 0);
    await harness.coordinator.deliverInSessionTurn(
      EDITOR_A,
      PANE_A,
      delivery(admitted.envelope, 1),
    );

    expect(harness.coordinator.disposeForReload(false)).toEqual({
      kind: "disposed-unreachable",
    });
    expect(released).toHaveBeenCalledOnce();
    expect(harness.coordinator.snapshot().entries).toEqual([]);
    expect(harness.coordinator.disposeForReload(true)).toEqual({
      kind: "disposed-unreachable",
    });
    expect(
      harness.coordinator.rekeyNoteIdentity(NOTE, {
        ...NOTE,
        vaultRelativeMarkdownPath: "Notes/disposed.md",
      }),
    ).toBe(false);
    await expect(
      prepareResult(harness.coordinator, PANE_A, 1, 1),
    ).resolves.toEqual({ kind: "rejected", reason: "disposed" });
    await expect(
      harness.coordinator.deliverInSessionTurn(
        EDITOR_A,
        PANE_A,
        delivery(admitted.envelope, 2),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "disposed" });
  });

  it("blocks rekey and disposal while delivery recovery is pending", async () => {
    const harness = createHarness({ holdRecord: true });
    const admitted = await prepare(harness.coordinator, PANE_A, 1, 0);
    const pending = harness.coordinator.deliver(
      EDITOR_A,
      PANE_A,
      delivery(admitted.envelope, 1),
    );
    await harness.recordStarted;

    expect(
      harness.coordinator.rekeyNoteIdentity(NOTE, {
        ...NOTE,
        vaultRelativeMarkdownPath: "Notes/pending.md",
      }),
    ).toBe(false);
    expect(harness.coordinator.disposeForReload(true)).toEqual({
      kind: "blocked",
      reason: "unrestorable-history",
    });
    harness.releaseRecord();
    await expect(pending).resolves.toMatchObject({ kind: "accepted" });
  });
});

function identifier(prefix: string, index: number): string {
  return `${prefix}_${index.toString(16).padStart(26, "0")}`;
}
