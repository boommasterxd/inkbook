/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact first-revision identities are the contract under test. */
import { describe, expect, it } from "vitest";

import { parseOperationId } from "../../../src/domain/operations";
import {
  FIRST_SIDECAR_TIMEOUT_MS_V1,
  type FirstSidecarCreateResultV1,
} from "../../../src/application/persistence/first-sidecar-types";
import {
  COMMAND,
  DIGEST_C,
  EVIDENCE,
  createDeferred,
  createFirstSidecarHarness,
  flushMicrotasks,
  hostForwardAttempt,
} from "./first-sidecar-support";

async function prepareFirstSidecar(
  harness: ReturnType<typeof createFirstSidecarHarness>,
): Promise<void> {
  const preparation = harness.coordinator.prepare(harness.command);
  expect(harness.events).toEqual(["marker"]);
  harness.acknowledgeMarker();
  await flushMicrotasks();
  expect(harness.events).toEqual(["marker", "checkpoint"]);
  await harness.acknowledgeCheckpoint();
  await expect(preparation).resolves.toMatchObject({
    dispatch: "host-forward",
    kind: "prepared",
    pending: {
      expectedSettingsRevision: COMMAND.expectedSettingsRevision,
      expectedSourceDigest: EVIDENCE.digest,
      expectedSourceGeneration: EVIDENCE.generation,
      expectedVaultRelativePath: COMMAND.expectedVaultRelativePath,
      historyEntryId: COMMAND.historyEntryId,
      noteIdentity: COMMAND.noteIdentity,
      operationId: COMMAND.operationId,
    },
  });
}

describe("first sidecar split-phase orchestration", () => {
  it("waits for marker observation and a durable checkpoint without retaining a session turn", async () => {
    const harness = createFirstSidecarHarness();
    const preparation = harness.coordinator.prepare(harness.command);

    expect(harness.events).toEqual(["marker"]);
    expect(harness.session.snapshot.persistence).toEqual({
      kind: "unannotated",
    });
    harness.acknowledgeMarker();
    await flushMicrotasks();

    expect(harness.events).toEqual(["marker", "checkpoint"]);
    expect(harness.session.snapshot.persistence).toEqual({
      kind: "unannotated",
    });
    await harness.acknowledgeCheckpoint();
    await expect(preparation).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.events).toEqual([
      "marker",
      "checkpoint",
      "prepare-dispatch",
    ]);
    expect(harness.creates).toHaveLength(0);
    expect(harness.session.snapshot.persistence.kind).toBe(
      "first-sidecar-pending",
    );
  });

  it("creates the exact complete revision one only after matching host-recorded Forward", async () => {
    const harness = createFirstSidecarHarness();
    await prepareFirstSidecar(harness);
    expect(harness.creates).toHaveLength(0);
    await harness.publishHostForward();

    const first = harness.coordinator.recordHostForward({
      attempt: hostForwardAttempt(),
    });
    const duplicate = harness.coordinator.recordHostForward({
      attempt: hostForwardAttempt(),
    });

    expect(first).toBe(duplicate);
    await expect(first).resolves.toEqual({ kind: "acknowledged" });
    expect(harness.creates).toHaveLength(1);
    expect(harness.creates[0]).toMatchObject({
      expectedVaultRelativePath: COMMAND.expectedVaultRelativePath,
      sidecar: {
        baseRevision: null,
        format: "inkbook-obsidian-annotations",
        noteIdentity: {
          markdownContentDigest: EVIDENCE.digest,
          sourceGeneration: EVIDENCE.generation,
          vaultRelativeMarkdownPath:
            COMMAND.noteIdentity.vaultRelativeMarkdownPath,
        },
        revision: 1,
        savedAtEpochMs: 1_755_734_400_000,
        scene: { revision: 1 },
        schemaVersion: { major: 1, minor: 0 },
        storageLayout: { kind: "adjacent" },
      },
    });
    expect(harness.acknowledgements).toHaveLength(1);
    const acknowledgement = harness.acknowledgements[0];
    expect(acknowledgement).toBeDefined();
    if (acknowledgement === undefined) return;
    expect(acknowledgement.acknowledgedReplacementBase).toMatchObject({
      rawTextSha256: DIGEST_C,
      revision: 1,
    });
    expect(acknowledgement.coveredAttemptIds).toEqual([
      hostForwardAttempt().attemptId,
    ]);
    expect(acknowledgement.coveredCheckpointIds).toEqual([
      EVIDENCE.checkpointId,
    ]);
    expect(acknowledgement.expectedPriorBase).toMatchObject({
      rawTextSha256: null,
      revision: null,
    });
    expect(acknowledgement.sceneRevision).toBe(1);
    expect(acknowledgement.sidecarRevision).toBe(1);
    expect(harness.session.snapshot.persistence).toEqual({
      kind: "clean",
      sidecarRevision: 1,
    });
  });
});

describe("first sidecar completion boundaries", () => {
  it("rejects a nonmatching Forward without consuming the pending transition", async () => {
    const harness = createFirstSidecarHarness();
    await prepareFirstSidecar(harness);
    await harness.publishHostForward();
    const pending = harness.session.snapshot.persistence;

    await expect(
      harness.coordinator.recordHostForward({
        attempt: hostForwardAttempt({
          expectedSourceDigest: DIGEST_C,
        }),
      }),
    ).resolves.toEqual({ kind: "rejected" });

    expect(harness.creates).toHaveLength(0);
    expect(harness.session.snapshot.persistence).toEqual(pending);
    await expect(
      harness.coordinator.recordHostForward({ attempt: hostForwardAttempt() }),
    ).resolves.toEqual({ kind: "acknowledged" });
  });

  it("rejects another annotation command without replacing the pending identity", async () => {
    const harness = createFirstSidecarHarness();
    await prepareFirstSidecar(harness);
    const pending = harness.session.snapshot.persistence;

    await expect(
      harness.coordinator.prepare({
        ...harness.command,
        operationId: parseOperationId("op_11111111111111111111111111"),
      }),
    ).resolves.toEqual({ kind: "rejected" });

    expect(harness.session.snapshot.persistence).toEqual(pending);
    expect(harness.creates).toHaveLength(0);
  });

  it("publishes conflict and never overwrites a create-if-absent collision", async () => {
    const harness = createFirstSidecarHarness();
    harness.createResult = { kind: "collision" };
    await prepareFirstSidecar(harness);
    await harness.publishHostForward();

    await expect(
      harness.coordinator.recordHostForward({ attempt: hostForwardAttempt() }),
    ).resolves.toEqual({ kind: "conflict" });

    expect(harness.creates).toHaveLength(1);
    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.session.snapshot.persistence).toEqual({ kind: "conflict" });
  });

  it("ignores a late create completion after cancellation", async () => {
    const harness = createFirstSidecarHarness();
    const creation = createDeferred<FirstSidecarCreateResultV1>();
    harness.createResult = creation;
    await prepareFirstSidecar(harness);
    await harness.publishHostForward();
    const completion = harness.coordinator.recordHostForward({
      attempt: hostForwardAttempt(),
    });
    await harness.createStarted;
    expect(harness.creates).toHaveLength(1);

    await expect(harness.coordinator.cancel()).resolves.toBe(true);
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
    creation.resolve({ kind: "created", rawTextSha256: DIGEST_C });
    await expect(completion).resolves.toEqual({ kind: "drift" });

    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
  });

  it("uses the bounded controlled timeout", () => {
    expect(FIRST_SIDECAR_TIMEOUT_MS_V1).toBe(2_000);
  });
});
