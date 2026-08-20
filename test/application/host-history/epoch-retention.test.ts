/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact epoch handoff boundaries are the fixtures under test. */
import { describe, expect, it } from "vitest";

import { createSceneRevision } from "../../../src/domain/model";
import {
  createAnnotationHistoryEntryV1,
  createHistoryEpoch,
  parseHistoryEntryId,
  parseOperationId,
} from "../../../src/domain/operations";
import {
  createRuntimeSceneStateV1,
  type RuntimeSceneStateV1,
} from "../../../src/domain/scene";
import type {
  HostEffectEnvelopeV1,
  HostTransactionSequence,
  NoteIdentityV1,
  SessionOrder,
} from "../../../src/application/note-session";
import {
  createHostTransactionSequence,
  parseHostEffectId,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseViewId,
} from "../../../src/application/note-session";
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
const PANE = parseViewId("view_a");
const EDITOR = parseViewId("editor_a");
const NOTE_APPEARANCE = Object.freeze({
  background: "none" as const,
  contrast: "medium" as const,
  horizontalSpacing: "standard" as const,
});

describe("HostHistoryCoordinatorV1 epoch retention", () => {
  it("releases old delivery state across repeated handoffs and restores safely", async () => {
    const harness = createHarness();
    let firstEnvelope: HostEffectEnvelopeV1 | undefined;
    const handoffCount = 257;
    for (let epoch = 1; epoch <= handoffCount; epoch += 1) {
      const prepared = await prepare(harness, epoch, epoch - 1);
      firstEnvelope ??= prepared.envelope;
      expect(
        (await harness.deliver(EDITOR, PANE, delivery(prepared.envelope, 1)))
          .kind,
      ).toBe("accepted");
      const inverse = Object.freeze({
        ...prepared.envelope,
        direction: "inverse" as const,
      });
      expect(
        (await harness.deliver(EDITOR, PANE, delivery(inverse, 2))).kind,
      ).toBe("accepted");
      expect(harness.closeOwner(PANE, true)).toBe(true);
      const snapshot = harness.snapshot();
      expect(snapshot.entries).toHaveLength(0);
      expect(snapshot.acceptedDeliveries).toHaveLength(0);
      expect(snapshot.highWaterMarks).toHaveLength(0);
      expect(snapshot.lease).toEqual({ kind: "unowned" });
    }

    if (firstEnvelope === undefined) throw new Error("Expected first envelope");
    const restored = createHarness({
      hostEffectsMayBeReachable: true,
      snapshot: harness.snapshot(),
    });
    const current = await prepare(restored, handoffCount + 1, handoffCount);
    expect(
      await restored.deliver(EDITOR, PANE, delivery(firstEnvelope, 1)),
    ).toEqual({ kind: "rejected", reason: "stale-epoch" });
    expect(
      (await restored.deliver(EDITOR, PANE, delivery(current.envelope, 1)))
        .kind,
    ).toBe("accepted");
    expect(restored.snapshot().acceptedDeliveries).toHaveLength(1);
    expect(restored.snapshot().highWaterMarks).toHaveLength(1);
  });
});

function createHarness(
  restore?: ConstructorParameters<typeof HostHistoryCoordinatorV1>[1],
): HostHistoryCoordinatorV1 {
  let operationNumber = 0;
  let attemptNumber = 0;
  let sessionOrder = 0;
  const observations: RecoveryFixtureObservations = {
    prepareAttempts: [],
    directionAttempts: [],
    recordedDirections: [],
    operationIds: [],
    expectedSceneRevisions: [],
  };
  const state: RecoveryFixtureState = {
    prepareFailures: 0,
    recordFailures: 0,
    directionFailures: 0,
    resolveRecordStarted: () => undefined,
    recordRelease: Promise.resolve(),
  };
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
    noteIdentity: NOTE,
    recovery: createRecovery({}, state, observations),
    recoveryContext,
  };
  return new HostHistoryCoordinatorV1(config, restore);
}

async function prepare(
  coordinator: HostHistoryCoordinatorV1,
  epoch: number,
  elementIndex: number,
): Promise<Extract<PrepareHostEffectResultV1, { readonly kind: "prepared" }>> {
  const element = rectangleElement(elementIndex);
  const historyEntry = createAnnotationHistoryEntryV1({
    forward: {
      elements: [
        {
          binding: element.binding,
          elementId: element.elementId,
          geometry: element.geometry,
          kind: element.kind,
          style: element.style,
        },
      ],
      kind: "create-elements",
      placement: {
        movedElementIds: [element.elementId],
        predecessorId:
          coordinator.scene.objectOrder.get(
            coordinator.scene.objectOrder.length - 1,
          ) ?? null,
        successorId: null,
      },
    },
    historyEntryId: parseHistoryEntryId(identifier("he", epoch + elementIndex)),
    historyEpoch: createHistoryEpoch(epoch),
  });
  if (!historyEntry.ok) throw new Error("History fixture is invalid.");
  const result = await coordinator.prepare({
    effectId: parseHostEffectId(identifier("eff", epoch + elementIndex)),
    historyEntry: historyEntry.value,
    operationId: parseOperationId(identifier("op", 100 + epoch + elementIndex)),
    viewId: PANE,
  });
  if (result.kind !== "prepared")
    throw new Error(`Preparation failed: ${result.reason}`);
  return result;
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

function emptyScene(): RuntimeSceneStateV1 {
  return createRuntimeSceneStateV1({
    elements: [],
    groups: [],
    noteAppearance: NOTE_APPEARANCE,
    objectOrder: [],
    revision: createSceneRevision(0),
  });
}

function identifier(prefix: string, index: number): string {
  return `${prefix}_${index.toString(16).padStart(26, "0")}`;
}
