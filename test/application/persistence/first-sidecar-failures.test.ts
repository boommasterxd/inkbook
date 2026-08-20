import { describe, expect, it } from "vitest";

import {
  createDeferred,
  createFirstSidecarHarness,
  flushMicrotasks,
  hostForwardAttempt,
} from "./first-sidecar-support";

const EXPECTED_POLICY_GATE_CHECKS = 2;
const FINAL_POLICY_GATE_CHECK = 3;

async function reachCheckpoint(
  harness: ReturnType<typeof createFirstSidecarHarness>,
): Promise<{
  readonly preparation: ReturnType<typeof harness.coordinator.prepare>;
}> {
  const preparation = harness.coordinator.prepare(harness.command);
  harness.acknowledgeMarker();
  await flushMicrotasks();
  return { preparation };
}

async function reachPending(
  harness: ReturnType<typeof createFirstSidecarHarness>,
): Promise<void> {
  const { preparation } = await reachCheckpoint(harness);
  await harness.acknowledgeCheckpoint();
  await expect(preparation).resolves.toMatchObject({ kind: "prepared" });
}

describe("first sidecar policy admission", () => {
  it.each(["read-only-mode", "relocation-pending"] as const)(
    "rejects %s before mutating the marker",
    async (failure) => {
      const harness = createFirstSidecarHarness();
      harness.setNewSidecarGateFailure(failure);

      await expect(
        harness.coordinator.prepare(harness.command),
      ).resolves.toEqual({ kind: "rejected" });
      expect(harness.gateChecks).toBe(1);
      expect(harness.events).toHaveLength(0);
      expect(harness.session.snapshot.persistence).toEqual({
        kind: "unannotated",
      });
    },
  );

  it.each(["read-only-mode", "relocation-pending"] as const)(
    "fails closed when %s starts between marker and create",
    async (failure) => {
      const harness = createFirstSidecarHarness();
      await reachPending(harness);
      await harness.publishHostForward();
      harness.setNewSidecarGateFailure(failure);

      await expect(
        harness.coordinator.recordHostForward({
          attempt: hostForwardAttempt(),
        }),
      ).resolves.toEqual({ kind: "drift" });
      expect(harness.gateChecks).toBe(EXPECTED_POLICY_GATE_CHECKS);
      expect(harness.creates).toHaveLength(0);
      expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
    },
  );

  it("rechecks policy immediately before calling create-if-absent", async () => {
    const harness = createFirstSidecarHarness();
    harness.setAdmissionCheckHook((check) => {
      if (check === FINAL_POLICY_GATE_CHECK) {
        harness.setNewSidecarGateFailure("relocation-pending");
      }
    });
    await reachPending(harness);
    await harness.publishHostForward();

    await expect(
      harness.coordinator.recordHostForward({
        attempt: hostForwardAttempt(),
      }),
    ).resolves.toEqual({ kind: "drift" });
    expect(harness.gateChecks).toBe(FINAL_POLICY_GATE_CHECK);
    expect(harness.creates).toHaveLength(0);
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
  });
});

describe("first sidecar failure windows", () => {
  it("turns marker rejection into visible drift without dispatch or create", async () => {
    const harness = createFirstSidecarHarness();
    const preparation = harness.coordinator.prepare(harness.command);
    harness.failMarker();

    await expect(preparation).resolves.toEqual({ kind: "drift" });
    expect(harness.events).toEqual(["marker"]);
    expect(harness.creates).toHaveLength(0);
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
    await expect(harness.coordinator.cancel()).resolves.toBe(false);
  });

  it("turns a rejected marker host promise into drift", async () => {
    const harness = createFirstSidecarHarness();
    const preparation = harness.coordinator.prepare(harness.command);
    harness.rejectMarker();

    await expect(preparation).resolves.toEqual({ kind: "drift" });
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
  });

  it("turns cancellation during source observation into drift", async () => {
    const harness = createFirstSidecarHarness();
    const { preparation } = await reachCheckpoint(harness);

    await expect(harness.coordinator.cancel()).resolves.toBe(true);
    await expect(preparation).resolves.toEqual({ kind: "drift" });
    expect(harness.creates).toHaveLength(0);
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
  });

  it("turns timeout into drift and ignores a late checkpoint", async () => {
    const harness = createFirstSidecarHarness();
    const { preparation } = await reachCheckpoint(harness);
    harness.timer.fire();
    await expect(preparation).resolves.toEqual({ kind: "drift" });
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });

    await harness.acknowledgeCheckpoint();
    await flushMicrotasks();
    expect(harness.events).not.toContain("prepare-dispatch");
    expect(harness.creates).toHaveLength(0);
  });

  it("turns identity or policy revalidation mismatch into drift", async () => {
    const harness = createFirstSidecarHarness();
    const { preparation } = await reachCheckpoint(harness);
    harness.currentIdentityValid = false;
    await harness.acknowledgeCheckpoint();

    await expect(preparation).resolves.toEqual({ kind: "drift" });
    expect(harness.events).not.toContain("prepare-dispatch");
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
  });

  it("turns disposal into drift before invalidating late work", async () => {
    const harness = createFirstSidecarHarness();
    await reachPending(harness);

    await harness.coordinator.dispose();
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
    expect(harness.events).toContain("prepare-dispatch");
    expect(harness.creates).toHaveLength(0);
    await expect(harness.coordinator.prepare(harness.command)).resolves.toEqual(
      {
        kind: "rejected",
      },
    );
    await harness.coordinator.dispose();
  });

  it("turns a post-prepare identity or policy mismatch into drift", async () => {
    const harness = createFirstSidecarHarness();
    await reachPending(harness);
    await harness.publishHostForward();
    harness.currentIdentityValid = false;

    await expect(
      harness.coordinator.recordHostForward({ attempt: hostForwardAttempt() }),
    ).resolves.toEqual({ kind: "drift" });
    expect(harness.creates).toHaveLength(0);
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
  });
});

describe("first sidecar write failures and completion races", () => {
  it("turns create and recovery acknowledgement failures into drift", async () => {
    const createFailure = createFirstSidecarHarness();
    createFailure.createResult = { kind: "failed" };
    await reachPending(createFailure);
    await createFailure.publishHostForward();
    await expect(
      createFailure.coordinator.recordHostForward({
        attempt: hostForwardAttempt(),
      }),
    ).resolves.toEqual({ kind: "drift" });
    expect(createFailure.session.snapshot.persistence).toEqual({
      kind: "drift",
    });
    expect(createFailure.acknowledgements).toHaveLength(0);

    const acknowledgementFailure = createFirstSidecarHarness();
    acknowledgementFailure.acknowledgementOk = false;
    await reachPending(acknowledgementFailure);
    await acknowledgementFailure.publishHostForward();
    await expect(
      acknowledgementFailure.coordinator.recordHostForward({
        attempt: hostForwardAttempt(),
      }),
    ).resolves.toEqual({ kind: "drift" });
    expect(acknowledgementFailure.acknowledgements).toHaveLength(1);
    expect(acknowledgementFailure.session.snapshot.persistence).toEqual({
      kind: "drift",
    });
  });

  it("does not acknowledge after disposal wins the completion race", async () => {
    const harness = createFirstSidecarHarness();
    const acknowledgement = createDeferred<{ readonly ok: boolean }>();
    harness.setAcknowledgementGate(acknowledgement);
    await reachPending(harness);
    await harness.publishHostForward();
    const completion = harness.coordinator.recordHostForward({
      attempt: hostForwardAttempt(),
    });
    await harness.acknowledgementStarted;

    await harness.session.dispose(false);
    acknowledgement.resolve({ ok: true });

    await expect(completion).resolves.toEqual({ kind: "drift" });
    expect(harness.session.snapshot.lifecycle).toBe("disposed");
    expect(harness.session.snapshot.persistence.kind).not.toBe("clean");
  });

  it("publishes drift when revalidation becomes stale after Vault acknowledgement", async () => {
    const harness = createFirstSidecarHarness();
    const acknowledgement = createDeferred<{ readonly ok: boolean }>();
    harness.setAcknowledgementGate(acknowledgement);
    await reachPending(harness);
    await harness.publishHostForward();
    const completion = harness.coordinator.recordHostForward({
      attempt: hostForwardAttempt(),
    });
    await harness.acknowledgementStarted;

    harness.currentIdentityValid = false;
    acknowledgement.resolve({ ok: true });

    await expect(completion).resolves.toEqual({ kind: "drift" });
    expect(harness.session.snapshot.persistence).toEqual({ kind: "drift" });
  });
});
