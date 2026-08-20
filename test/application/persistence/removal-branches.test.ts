/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact barrier and revision values define the tested state transitions. */
import { describe, expect, it } from "vitest";

import {
  commandFailure,
  commandSuccess,
  createSidecarRevision,
  parseRemovalId,
  parseSha256Digest,
  type CommandResultV1,
} from "../../../src/application/note-session";
import {
  REMOVAL_BARRIER_TIMEOUT_MS_V1,
  beginAnnotationRemoval,
  resumeAnnotationRemovalV1,
  type RemovalClockV1,
  type RemovalPortsV1,
} from "../../../src/application/persistence/removal";
import type {
  ActiveRemovalRecoveryV1,
  RecoveryStore,
  RemovalRecordV1,
} from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import { createRecoveryHarness, deferred } from "./saga-support";

const NOW = 10_000;
const BASE = Object.freeze({
  markdownPath: "notes/removal.md",
  rawTextSha256: parseSha256Digest("a".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/removal.inkbook.json",
});

function record(
  markerState: RemovalRecordV1["markerState"] = "present",
  trashAcknowledged = false,
  deleteEventAcknowledged = false,
): RemovalRecordV1 {
  return {
    deadlineEpochMs: NOW + REMOVAL_BARRIER_TIMEOUT_MS_V1,
    deleteEventAcknowledged,
    expectedSceneRevision: createSceneRevision(1),
    kind: "annotation-removal",
    markerState,
    noteIdentity: {
      vaultIdHint: "vault",
      vaultRelativeMarkdownPath: BASE.markdownPath,
    },
    removalId: parseRemovalId("rm_00000000000000000000000000"),
    sidecarBase: BASE,
    trashAcknowledged,
  };
}

class MutableClock implements RemovalClockV1 {
  current = NOW;
  readonly callbacks: (() => void)[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void): unknown {
    this.callbacks.push(callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
  }

  expire(): void {
    this.current = NOW + REMOVAL_BARRIER_TIMEOUT_MS_V1;
    for (const callback of this.callbacks.splice(0)) callback();
  }
}

type PortName =
  "clear-session" | "external-delete" | "remove-marker" | "resolve-failure";

function ports(
  trashSidecar: () => Promise<void>,
  log: string[],
  failure?: PortName,
  rejection?: PortName,
): RemovalPortsV1 {
  const call =
    (name: PortName): (() => Promise<CommandResultV1<void>>) =>
    async () => {
      log.push(name);
      if (name === rejection) throw new Error(`Injected ${name} rejection.`);
      return name === failure
        ? commandFailure("sidecar-drift")
        : commandSuccess(undefined);
    };
  return {
    clearSession: call("clear-session"),
    handleExternalDelete: call("external-delete"),
    removeMarker: call("remove-marker"),
    resolveFailure: call("resolve-failure"),
    trashSidecar,
  };
}

function overrideStore(
  store: RecoveryStore,
  overrides: Partial<RecoveryStore>,
): RecoveryStore {
  return { ...store, ...overrides };
}

function activeRemoval(recordValue: RemovalRecordV1): ActiveRemovalRecoveryV1 {
  return Object.freeze({
    attempts: Object.freeze([]),
    checkpoints: Object.freeze([]),
    removal: recordValue,
  });
}

async function resumeAndDrain(
  value: RemovalRecordV1,
  recovery: RecoveryStore,
  removalPorts: RemovalPortsV1,
): Promise<void> {
  const resumed = await resumeAnnotationRemovalV1({
    activeRecovery: activeRemoval(value),
    clock: new MutableClock(),
    ports: removalPorts,
    recovery,
  });
  if (!resumed.ok) throw new Error(`Resume failed: ${resumed.code}`);
  await resumed.value.whenIdle();
}

describe("removal resume branch behavior", () => {
  it("resumes each partial barrier state without skipping the missing signal", async () => {
    const deleteFirst = createRecoveryHarness();
    const deleteAcknowledged = record("present", false, true);
    await deleteFirst.store.beginRemoval(deleteAcknowledged);
    const deleteLog: string[] = [];
    await resumeAndDrain(
      deleteAcknowledged,
      deleteFirst.store,
      ports(async () => undefined, deleteLog),
    );
    expect(deleteLog).toEqual(["remove-marker", "clear-session"]);
    expect(deleteFirst.removals.size).toBe(0);

    const trashFirst = createRecoveryHarness();
    const trashAcknowledged = record("present", true, false);
    await trashFirst.store.beginRemoval(trashAcknowledged);
    const trashLog: string[] = [];
    await resumeAndDrain(
      trashAcknowledged,
      trashFirst.store,
      ports(async () => undefined, trashLog),
    );
    expect(trashLog).toEqual([]);
    expect(trashFirst.removals.get(trashAcknowledged.removalId)).toEqual(
      trashAcknowledged,
    );
  });

  it("resumes an already removed marker without repeating marker I/O or journal transitions", async () => {
    const harness = createRecoveryHarness();
    const value = record("removed", true, true);
    await harness.store.beginRemoval(value);
    const log: string[] = [];
    await resumeAndDrain(
      value,
      harness.store,
      ports(async () => undefined, log),
    );
    expect(log).toEqual(["clear-session"]);
    expect(harness.removals.size).toBe(0);
  });

  it.each([
    ["clear-session", "clear-session", "removed"],
    ["remove-marker", "remove-marker", "removing"],
  ] as const)(
    "fails closed when %s returns a failure",
    async (_label, failure, expectedMarkerState) => {
      const harness = createRecoveryHarness();
      const value = record("removing", true, true);
      await harness.store.beginRemoval(value);
      const log: string[] = [];
      await resumeAndDrain(
        value,
        harness.store,
        ports(async () => undefined, log, failure),
      );
      expect(log).toContain(failure);
      expect(harness.removals.get(value.removalId)).toEqual({
        ...value,
        markerState: expectedMarkerState,
      });
    },
  );

  it("maps rejected ports and recovery transitions to recovery-unavailable", async () => {
    const harness = createRecoveryHarness();
    const value = record("removing", true, true);
    await harness.store.beginRemoval(value);
    const rejectedLog: string[] = [];
    await resumeAndDrain(
      value,
      harness.store,
      ports(async () => undefined, rejectedLog, undefined, "remove-marker"),
    );
    expect(rejectedLog).toEqual(["remove-marker"]);
    expect(harness.removals.get(value.removalId)).toEqual(value);

    const transitionHarness = createRecoveryHarness();
    const present = record("present", true, true);
    await transitionHarness.store.beginRemoval(present);
    const throwing = overrideStore(transitionHarness.store, {
      advanceRemoval: async () => {
        throw new Error("Injected recovery rejection.");
      },
    });
    const transitionLog: string[] = [];
    await resumeAndDrain(
      present,
      throwing,
      ports(async () => undefined, transitionLog),
    );
    expect(transitionLog).toEqual(["resolve-failure"]);
    expect(transitionHarness.removals.get(present.removalId)).toEqual(present);
  });
});

describe("removal resume conflict behavior", () => {
  it("propagates stale marker persistence and terminal saga conflicts", async () => {
    const firstHarness = createRecoveryHarness();
    const value = record("removing", true, true);
    await firstHarness.store.beginRemoval(value);
    const staleMarker = overrideStore(firstHarness.store, {
      advanceRemoval: async ({ replacement }) =>
        replacement.markerState === "removed"
          ? commandFailure("sidecar-conflict")
          : commandSuccess(undefined),
    });
    const markerLog: string[] = [];
    await resumeAndDrain(
      value,
      staleMarker,
      ports(async () => undefined, markerLog),
    );
    expect(markerLog).toEqual(["remove-marker", "resolve-failure"]);
    expect(firstHarness.removals.get(value.removalId)).toEqual(value);

    const secondHarness = createRecoveryHarness();
    const removed = record("removed", true, true);
    await secondHarness.store.beginRemoval(removed);
    const staleSaga = overrideStore(secondHarness.store, {
      finalizeRemovalRecovery: async () => commandFailure("sidecar-conflict"),
    });
    const sagaLog: string[] = [];
    await resumeAndDrain(
      removed,
      staleSaga,
      ports(async () => undefined, sagaLog),
    );
    expect(sagaLog).toEqual(["clear-session"]);
    expect(secondHarness.removals.get(removed.removalId)).toEqual(removed);
  });
});

describe("removal coordinator failure and lifecycle branches", () => {
  it("rejects invalid clocks, invalid deadlines, begin conflicts, and expiry during begin", async () => {
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const invalidClock = new MutableClock();
    invalidClock.current = Number.NaN;
    await expect(
      beginAnnotationRemoval({
        clock: invalidClock,
        ports: ports(async () => undefined, log),
        record: record(),
        recovery: harness.store,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });

    const wrongDeadline = { ...record(), deadlineEpochMs: NOW + 1 };
    await expect(
      beginAnnotationRemoval({
        clock: new MutableClock(),
        ports: ports(async () => undefined, log),
        record: wrongDeadline,
        recovery: harness.store,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });

    await harness.store.beginRemoval(record());
    await expect(
      beginAnnotationRemoval({
        clock: new MutableClock(),
        ports: ports(async () => undefined, log),
        record: record(),
        recovery: harness.store,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });

    let reads = 0;
    const expiringClock: RemovalClockV1 = {
      clearTimeout: () => undefined,
      now: () => {
        reads += 1;
        return reads === 1 ? NOW : NOW + REMOVAL_BARRIER_TIMEOUT_MS_V1;
      },
      setTimeout: () => 1,
    };
    const fresh = createRecoveryHarness();
    await expect(
      beginAnnotationRemoval({
        clock: expiringClock,
        ports: ports(async () => undefined, log),
        record: record(),
        recovery: fresh.store,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-drift" });
    expect(log).toContain("resolve-failure");
  });
});

describe("removal coordinator asynchronous lifecycle", () => {
  it("rejects an event that arrives after the deadline before the timer callback", async () => {
    const trash = deferred<undefined>();
    const clock = new MutableClock();
    const log: string[] = [];
    const started = await beginAnnotationRemoval({
      clock,
      ports: ports(() => trash.promise, log),
      record: record(),
      recovery: createRecoveryHarness().store,
    });
    if (!started.ok) throw new Error("Expected coordinator.");
    clock.current = NOW + REMOVAL_BARRIER_TIMEOUT_MS_V1;
    await expect(
      started.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "inactive" });
    expect(log).toEqual(["resolve-failure", "external-delete"]);
    trash.resolve(undefined);
    await started.value.whenIdle();
  });

  it("invalidates rejected trash and expired trash acknowledgements", async () => {
    const rejectedHarness = createRecoveryHarness();
    const rejectedLog: string[] = [];
    const rejected = await beginAnnotationRemoval({
      clock: new MutableClock(),
      ports: ports(
        async () => Promise.reject(new Error("Trash failed.")),
        rejectedLog,
      ),
      record: record(),
      recovery: rejectedHarness.store,
    });
    if (!rejected.ok) throw new Error("Expected coordinator.");
    await rejected.value.whenIdle();
    expect(rejectedLog).toEqual(["resolve-failure"]);

    const trash = deferred<undefined>();
    const clock = new MutableClock();
    const expiredLog: string[] = [];
    const expired = await beginAnnotationRemoval({
      clock,
      ports: ports(() => trash.promise, expiredLog),
      record: record(),
      recovery: createRecoveryHarness().store,
    });
    if (!expired.ok) throw new Error("Expected coordinator.");
    clock.current = NOW + REMOVAL_BARRIER_TIMEOUT_MS_V1;
    trash.resolve(undefined);
    await expired.value.whenIdle();
    expect(expiredLog).toEqual(["resolve-failure"]);
  });

  it("handles failed event persistence and idempotent disposal without reviving late work", async () => {
    const trash = deferred<undefined>();
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const store = overrideStore(harness.store, {
      advanceRemoval: async () => commandFailure("sidecar-conflict"),
    });
    const started = await beginAnnotationRemoval({
      clock: new MutableClock(),
      ports: ports(() => trash.promise, log),
      record: record(),
      recovery: store,
    });
    if (!started.ok) throw new Error("Expected coordinator.");
    await expect(
      started.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "inactive" });
    await started.value.dispose();
    await expect(started.value.retryCleanup()).resolves.toEqual({
      ok: false,
      code: "disposed",
    });
    trash.resolve(undefined);
    await started.value.whenIdle();
    expect(log.filter((entry) => entry === "resolve-failure")).toHaveLength(1);
  });

  it("treats completed release and duplicate lifecycle calls as idempotent", async () => {
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const started = await beginAnnotationRemoval({
      clock: new MutableClock(),
      ports: ports(async () => undefined, log),
      record: record("present", true, false),
      recovery: harness.store,
    });
    if (!started.ok) throw new Error("Expected coordinator.");
    await expect(
      started.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: true, reason: "accepted" });
    await started.value.whenIdle();
    await started.value.dispose();
    await started.value.dispose();
    await expect(
      started.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "duplicate" });
    expect(log.filter((entry) => entry === "remove-marker")).toHaveLength(1);
  });
});
