/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact history sequences and scene revisions are the fixtures under test. */
import { describe, expect, it, vi } from "vitest";

import {
  createAnnotationHistoryEntryV1,
  createHistoryEpoch,
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import { createSceneRevision } from "../../../src/domain/model";
import {
  createRuntimeSceneStateV1,
  type RuntimeSceneStateV1,
} from "../../../src/domain/scene";
import type {
  HostEffectEnvelopeV1,
  HostTransactionSequence,
  NoteIdentityV1,
  SessionOrder,
  ViewId,
} from "../../../src/application/note-session";
import {
  createHostTransactionSequence,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseViewId,
} from "../../../src/application/note-session";
import type {
  HostRecordedDirectionAttemptV1,
  PreparedForwardAttemptV1,
} from "../../../src/application/recovery";
import {
  HostHistoryCoordinatorV1,
  type HostEffectDeliveryV1,
  type HostHistoryCoordinatorConfigV1,
  type HostHistoryRecoveryContextV1,
  type PrepareHostEffectResultV1,
} from "../../../src/application/host-history";
import { rectangleElement } from "../../domain/model/support";
import {
  createRecovery,
  type RecoveryFixtureObservations,
  type RecoveryFixtureState,
} from "./recovery-fixture";

const NOTE: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/history.md",
});
const PANE_A = parseViewId("view_a");
const PANE_B = parseViewId("view_b");
const EDITOR_A = parseViewId("editor_a");
const EDITOR_B = parseViewId("editor_b");
const NOTE_APPEARANCE = Object.freeze({
  background: "none" as const,
  contrast: "medium" as const,
  horizontalSpacing: "standard" as const,
});

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

    expect(sceneSummary(forward)).toEqual({ elements: 1, revision: 1 });
    expect(sceneSummary(duplicate)).toEqual({ elements: 1, revision: 1 });
    expect(sceneSummary(undo)).toEqual({ elements: 0, revision: 2 });
    expect(sceneSummary(redo)).toEqual({ elements: 1, revision: 3 });
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

  it("serializes alternating deliveries and preserves per-editor epoch high-water", async () => {
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
      "accepted",
      "accepted",
    ]);
    expect(harness.coordinator.scene.revision).toBe(4);
    expect(
      harness.coordinator.sequenceHighWater(EDITOR_A, createHistoryEpoch(1)),
    ).toBe(createHostTransactionSequence(4));
    expect(harness.expectedSceneRevisions).toEqual([0, 1, 2, 3]);
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
  it("rejects delivery queue overflow before retention processing", async () => {
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

    await expect(
      harness.coordinator.deliver(
        EDITOR_A,
        PANE_A,
        delivery(prepared.envelope, 2),
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "payload-limit" });

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

interface HarnessOptions {
  readonly holdRecord?: boolean;
  readonly maxActionableEntries?: number;
  readonly noteIdentity?: NoteIdentityV1;
  readonly onRelease?: HostHistoryCoordinatorConfigV1["onRelease"];
  readonly prepareFailures?: number;
  readonly recordFailures?: number;
  readonly directionFailures?: number;
  readonly restore?: ConstructorParameters<typeof HostHistoryCoordinatorV1>[1];
}

interface Harness {
  readonly coordinator: HostHistoryCoordinatorV1;
  readonly prepareAttempts: readonly PreparedForwardAttemptV1[];
  readonly directionAttempts: readonly HostRecordedDirectionAttemptV1[];
  readonly recordedDirections: readonly ("forward" | "inverse")[];
  readonly operationIds: readonly string[];
  readonly expectedSceneRevisions: readonly number[];
  readonly recordStarted: Promise<void>;
  readonly releaseRecord: () => void;
}

function createHarness(options: HarnessOptions = {}): Harness {
  let operationNumber = 0;
  let attemptNumber = 0;
  let sessionOrder = 0;
  let resolveRecordStarted = (): void => undefined;
  let resolveRecord: (() => void) | undefined;
  const recordStarted = new Promise<void>((resolve) => {
    resolveRecordStarted = resolve;
  });
  const recordRelease = new Promise<void>((resolve) => {
    resolveRecord = resolve;
  });
  const observations: RecoveryFixtureObservations = {
    prepareAttempts: [],
    directionAttempts: [],
    recordedDirections: [],
    operationIds: [],
    expectedSceneRevisions: [],
  };
  const recoveryState: RecoveryFixtureState = {
    prepareFailures: options.prepareFailures ?? 0,
    recordFailures: options.recordFailures ?? 0,
    directionFailures: options.directionFailures ?? 0,
    resolveRecordStarted,
    recordRelease,
  };
  const recovery = createRecovery(options, recoveryState, observations);
  const recoveryContext: HostHistoryRecoveryContextV1 = {
    base: {
      markdownPath: NOTE.vaultRelativeMarkdownPath,
      rawTextSha256: null,
      revision: null,
      vaultRelativePath: NOTE.vaultRelativeMarkdownPath,
    },
    createRecoveryAttemptId: () =>
      parseRecoveryAttemptId(identifier("ra", ++attemptNumber)),
    expectedSourceDigest: parseSha256Digest("0".repeat(64)),
    expectedSourceGeneration:
      1 as import("../../../src/application/note-session").SourceGeneration,
    nextSessionOrder: () => ++sessionOrder as SessionOrder,
  };
  const config: HostHistoryCoordinatorConfigV1 = {
    createOperationId: () =>
      parseOperationId(identifier("op", ++operationNumber)),
    initialScene: emptyScene(),
    noteIdentity: options.noteIdentity ?? NOTE,
    recovery,
    recoveryContext,
    ...(options.onRelease === undefined
      ? {}
      : { onRelease: options.onRelease }),
    ...(options.maxActionableEntries === undefined
      ? {}
      : { limits: { maxActionableEntries: options.maxActionableEntries } }),
  };
  return {
    coordinator: new HostHistoryCoordinatorV1(config, options.restore),
    ...observations,
    recordStarted,
    releaseRecord: () => resolveRecord?.(),
  };
}

async function prepare(
  coordinator: HostHistoryCoordinatorV1,
  viewId: ViewId,
  epoch: number,
  elementIndex: number,
): Promise<Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }>> {
  const result = await prepareResult(coordinator, viewId, epoch, elementIndex);
  if (result.kind !== "prepared") {
    throw new Error(`Preparation failed: ${result.reason}`);
  }
  return result;
}

function prepareResult(
  coordinator: HostHistoryCoordinatorV1,
  viewId: ViewId,
  epoch: number,
  elementIndex: number,
): Promise<PrepareHostEffectResultV1> {
  const element = rectangleElement(elementIndex);
  const value = {
    binding: element.binding,
    elementId: element.elementId,
    geometry: element.geometry,
    kind: element.kind,
    style: element.style,
  };
  const predecessorId =
    coordinator.scene.objectOrder.get(
      coordinator.scene.objectOrder.length - 1,
    ) ?? null;
  const historyEntry = createAnnotationHistoryEntryV1({
    forward: {
      elements: [value],
      kind: "create-elements",
      placement: {
        movedElementIds: [element.elementId],
        predecessorId,
        successorId: null,
      },
    },
    historyEntryId: parseHistoryEntryId(identifier("he", elementIndex + epoch)),
    historyEpoch: createHistoryEpoch(epoch),
  });
  if (!historyEntry.ok) throw new Error("History fixture is invalid.");
  return coordinator.prepare({
    effectId: parseHostEffectId(identifier("eff", elementIndex + epoch)),
    historyEntry: historyEntry.value,
    operationId: parseOperationId(identifier("op", 100 + elementIndex + epoch)),
    viewId,
  });
}

function delivery(
  envelope: HostEffectEnvelopeV1,
  sequence: number,
): HostEffectDeliveryV1 {
  return Object.freeze({
    envelope,
    transactionSequence:
      sequence === 0
        ? (sequence as HostTransactionSequence)
        : createHostTransactionSequence(sequence),
  });
}

function invert(envelope: HostEffectEnvelopeV1): HostEffectEnvelopeV1 {
  return Object.freeze({
    ...envelope,
    direction: envelope.direction === "forward" ? "inverse" : "forward",
  });
}

function emptyScene(): RuntimeSceneStateV1 {
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: NOTE_APPEARANCE,
    objectOrder: [],
    revision: createSceneRevision(0),
  });
}

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

function identifier(prefix: string, index: number): string {
  return `${prefix}_${index.toString(16).padStart(26, "0")}`;
}
