/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact two-second barrier and fixture revisions are under test. */
import { describe, expect, it } from "vitest";

import { createSceneRevision } from "../../../src/domain/model";
import {
  commandFailure,
  commandSuccess,
} from "../../../src/application/note-session/results";
import {
  createSidecarRevision,
  parseRemovalId,
  parseSha256Digest,
  type CommandResultV1,
  type NoteIdentityV1,
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
  RemovalRecordV1,
} from "../../../src/application/recovery";
import { createRecoveryHarness, deferred } from "./saga-support";

const PAYLOAD = "00000000000000000000000000";
const NOTE: NoteIdentityV1 = {
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "notes/source.md",
};
const BASE = {
  markdownPath: NOTE.vaultRelativeMarkdownPath,
  rawTextSha256: parseSha256Digest("a".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/source.inkbook.json",
};

function removal(now: number): RemovalRecordV1 {
  return {
    deadlineEpochMs: now + REMOVAL_BARRIER_TIMEOUT_MS_V1,
    deleteEventAcknowledged: false,
    expectedSceneRevision: createSceneRevision(1),
    kind: "annotation-removal",
    markerState: "present",
    noteIdentity: NOTE,
    removalId: parseRemovalId(`rm_${PAYLOAD}`),
    sidecarBase: BASE,
    trashAcknowledged: false,
  };
}

function activeRemoval(record: RemovalRecordV1): ActiveRemovalRecoveryV1 {
  return Object.freeze({
    attempts: Object.freeze([]),
    checkpoints: Object.freeze([]),
    removal: record,
  });
}

class ManualClock implements RemovalClockV1 {
  #now: number;
  #nextHandle = 1;
  readonly #timers = new Map<number, { callback: () => void; due: number }>();

  public constructor(now: number) {
    this.#now = now;
  }

  public now(): number {
    return this.#now;
  }

  public setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#timers.set(handle, { callback, due: this.#now + delayMs });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }

  public advanceTo(now: number): void {
    this.#now = now;
    const due = [...this.#timers.entries()].filter(
      ([, timer]) => timer.due <= now,
    );
    for (const [handle, timer] of due) {
      this.#timers.delete(handle);
      timer.callback();
    }
  }
}

function removalPorts(
  trash: Promise<void>,
  log: string[],
  markerFailure = { active: false },
): RemovalPortsV1 {
  const success =
    (name: string): (() => Promise<CommandResultV1<void>>) =>
    async () => {
      log.push(name);
      return commandSuccess(undefined);
    };
  return {
    clearSession: success("clear-session"),
    handleExternalDelete: success("external-delete"),
    removeMarker: async (): Promise<CommandResultV1<void>> => {
      log.push("remove-marker");
      if (markerFailure.active) {
        markerFailure.active = false;
        return commandFailure("sidecar-drift");
      }
      return commandSuccess(undefined);
    },
    resolveFailure: success("resolve-failure"),
    trashSidecar: () => trash,
  };
}

async function drainTrash(coordinator: {
  whenIdle(): Promise<void>;
}): Promise<void> {
  await Promise.resolve();
  await coordinator.whenIdle();
}

describe("annotation removal barrier", () => {
  it("accepts delete-event before trash acknowledgement", async () => {
    const now = 1000;
    const clock = new ManualClock(now);
    const trash = deferred<undefined>();
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const started = await beginAnnotationRemoval({
      clock,
      ports: removalPorts(trash.promise, log),
      record: removal(now),
      recovery: harness.store,
    });
    if (!started.ok) throw new Error("Expected removal coordinator.");
    await expect(
      started.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: true, reason: "accepted" });
    expect(log).toEqual([]);
    trash.resolve(undefined);
    await drainTrash(started.value);
    expect(log).toEqual(["remove-marker", "clear-session"]);
    expect(harness.removals.size).toBe(0);
  });

  it("accepts trash acknowledgement before delete-event and consumes duplicates once", async () => {
    const now = 2000;
    const clock = new ManualClock(now);
    const trash = deferred<undefined>();
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const started = await beginAnnotationRemoval({
      clock,
      ports: removalPorts(trash.promise, log),
      record: removal(now),
      recovery: harness.store,
    });
    if (!started.ok) throw new Error("Expected removal coordinator.");
    trash.resolve(undefined);
    await drainTrash(started.value);
    expect(log).toEqual([]);
    await expect(
      started.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: true, reason: "accepted" });
    await expect(
      started.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "duplicate" });
    expect(log.filter((entry) => entry === "remove-marker")).toHaveLength(1);
  });

  it("routes a mismatched event after completion through external deletion", async () => {
    const now = 2500;
    const clock = new ManualClock(now);
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const started = await beginAnnotationRemoval({
      clock,
      ports: removalPorts(Promise.resolve(), log),
      record: removal(now),
      recovery: harness.store,
    });
    if (!started.ok) throw new Error("Expected removal coordinator.");
    await drainTrash(started.value);
    await started.value.acceptDeleteEvent({ sidecarBase: BASE });
    await expect(
      started.value.acceptDeleteEvent({
        sidecarBase: {
          ...BASE,
          vaultRelativePath: "notes/replaced.inkbook.json",
        },
      }),
    ).resolves.toEqual({ consumed: false, reason: "mismatch" });
    expect(log.at(-1)).toBe("external-delete");
    expect(log.filter((entry) => entry === "remove-marker")).toHaveLength(1);
  });
});

describe("annotation removal invalidation and recovery", () => {
  it("invalidates timeout, mismatch, and disposal before late events", async () => {
    for (const mode of ["timeout", "mismatch", "dispose"] as const) {
      const now = 3000;
      const clock = new ManualClock(now);
      const trash = deferred<undefined>();
      const harness = createRecoveryHarness();
      const log: string[] = [];
      const started = await beginAnnotationRemoval({
        clock,
        ports: removalPorts(trash.promise, log),
        record: removal(now),
        recovery: harness.store,
      });
      if (!started.ok) throw new Error("Expected removal coordinator.");
      if (mode === "timeout") {
        clock.advanceTo(now + REMOVAL_BARRIER_TIMEOUT_MS_V1);
      } else if (mode === "dispose") {
        await started.value.dispose();
      }
      const sidecarBase =
        mode === "mismatch"
          ? { ...BASE, vaultRelativePath: "notes/replaced.inkbook.json" }
          : BASE;
      await expect(
        started.value.acceptDeleteEvent({ sidecarBase }),
      ).resolves.toMatchObject({ consumed: false });
      expect(log).toContain("resolve-failure");
      expect(log).toContain("external-delete");
      expect(log).not.toContain("remove-marker");
    }
  });
});

describe("annotation removal barrier resume", () => {
  it("resumes a trash-acknowledged record without trashing again", async () => {
    const now = 4500;
    const clock = new ManualClock(now);
    const harness = createRecoveryHarness();
    const durable = { ...removal(now), trashAcknowledged: true };
    await harness.store.beginRemoval(durable);
    const log: string[] = [];
    let trashCalls = 0;
    const ports = removalPorts(Promise.resolve(), log);
    ports.trashSidecar = async (): Promise<void> => {
      trashCalls += 1;
    };
    const resumed = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(durable),
      clock,
      ports,
      recovery: harness.store,
    });
    if (!resumed.ok) throw new Error("Expected resumed removal coordinator.");
    await expect(
      resumed.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: true, reason: "accepted" });
    await expect(
      resumed.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "duplicate" });
    expect(trashCalls).toBe(0);
    expect(log).toEqual(["remove-marker", "clear-session"]);
    expect(harness.removals.size).toBe(0);
  });

  it("resumes a delete-acknowledged record by idempotently trashing again", async () => {
    const now = 4600;
    const clock = new ManualClock(now);
    const harness = createRecoveryHarness();
    const durable = { ...removal(now), deleteEventAcknowledged: true };
    await harness.store.beginRemoval(durable);
    const trash = deferred<undefined>();
    const log: string[] = [];
    let trashCalls = 0;
    const ports = removalPorts(trash.promise, log);
    ports.trashSidecar = (): Promise<void> => {
      trashCalls += 1;
      return trash.promise;
    };
    const resumed = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(durable),
      clock,
      ports,
      recovery: harness.store,
    });
    if (!resumed.ok) throw new Error("Expected resumed removal coordinator.");
    await expect(
      resumed.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "duplicate" });
    trash.resolve(undefined);
    await drainTrash(resumed.value);
    expect(trashCalls).toBe(1);
    expect(log).toEqual(["remove-marker", "clear-session"]);
    expect(harness.removals.size).toBe(0);
  });

  it("keeps the original deadline and routes a late event externally", async () => {
    const startedAt = 4700;
    const clock = new ManualClock(startedAt + 1);
    const harness = createRecoveryHarness();
    const durable = { ...removal(startedAt), trashAcknowledged: true };
    await harness.store.beginRemoval(durable);
    const log: string[] = [];
    const resumed = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(durable),
      clock,
      ports: removalPorts(Promise.resolve(), log),
      recovery: harness.store,
    });
    if (!resumed.ok) throw new Error("Expected resumed removal coordinator.");
    clock.advanceTo(durable.deadlineEpochMs);
    await resumed.value.whenIdle();
    await expect(
      resumed.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "inactive" });
    expect(log).toEqual(["resolve-failure", "external-delete"]);
    expect(harness.removals.get(durable.removalId)).toEqual(durable);
  });

  it("fails an already expired durable record without creating a coordinator", async () => {
    const startedAt = 4800;
    const durable = { ...removal(startedAt), deleteEventAcknowledged: true };
    const harness = createRecoveryHarness();
    await harness.store.beginRemoval(durable);
    const log: string[] = [];
    await expect(
      resumeAnnotationRemovalV1({
        activeRecovery: activeRemoval(durable),
        clock: new ManualClock(durable.deadlineEpochMs),
        ports: removalPorts(Promise.resolve(), log),
        recovery: harness.store,
      }),
    ).resolves.toEqual({ code: "sidecar-drift", ok: false });
    expect(log).toEqual(["resolve-failure"]);
    expect(harness.removals.get(durable.removalId)).toEqual(durable);
  });
});

describe("annotation removal resumed authority", () => {
  it("fails closed when the durable record changed before signal CAS", async () => {
    const now = 4900;
    const clock = new ManualClock(now);
    const harness = createRecoveryHarness();
    const durable = { ...removal(now), trashAcknowledged: true };
    await harness.store.beginRemoval(durable);
    const stale = {
      ...durable,
      expectedSceneRevision: createSceneRevision(2),
    };
    const log: string[] = [];
    const resumed = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(stale),
      clock,
      ports: removalPorts(Promise.resolve(), log),
      recovery: harness.store,
    });
    if (!resumed.ok) throw new Error("Expected resumed removal coordinator.");
    await expect(
      resumed.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "inactive" });
    expect(log).toEqual(["resolve-failure"]);
    expect(harness.removals.get(durable.removalId)).toEqual(durable);
  });

  it("disposes resumed ownership before routing a late event externally", async () => {
    const now = 4950;
    const harness = createRecoveryHarness();
    const durable = { ...removal(now), trashAcknowledged: true };
    await harness.store.beginRemoval(durable);
    const log: string[] = [];
    const resumed = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(durable),
      clock: new ManualClock(now),
      ports: removalPorts(Promise.resolve(), log),
      recovery: harness.store,
    });
    if (!resumed.ok) throw new Error("Expected resumed removal coordinator.");
    await resumed.value.dispose();
    await expect(
      resumed.value.acceptDeleteEvent({ sidecarBase: BASE }),
    ).resolves.toEqual({ consumed: false, reason: "inactive" });
    expect(log).toEqual(["resolve-failure", "external-delete"]);
    expect(harness.removals.get(durable.removalId)).toEqual(durable);
  });
});

describe("annotation removal durable cleanup", () => {
  it("persists marker removal before clearing session and acknowledged recovery", async () => {
    const now = 4000;
    const clock = new ManualClock(now);
    const trash = deferred<undefined>();
    const harness = createRecoveryHarness();
    const log: string[] = [];
    const markerFailure = { active: true };
    const started = await beginAnnotationRemoval({
      clock,
      ports: removalPorts(trash.promise, log, markerFailure),
      record: removal(now),
      recovery: harness.store,
    });
    if (!started.ok) throw new Error("Expected removal coordinator.");
    await started.value.acceptDeleteEvent({ sidecarBase: BASE });
    trash.resolve(undefined);
    await drainTrash(started.value);
    expect(log).toEqual(["remove-marker"]);
    expect(harness.removals.values().next().value).toMatchObject({
      markerState: "removing",
    });
    await expect(started.value.retryCleanup()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(log).toEqual(["remove-marker", "remove-marker", "clear-session"]);
  });

  it("resumes cleanup from the exact durable marker step after a crash", async () => {
    const now = 5000;
    const harness = createRecoveryHarness();
    const both = {
      ...removal(now),
      deleteEventAcknowledged: true,
      trashAcknowledged: true,
    };
    await harness.store.beginRemoval(both);
    harness.crashAfterRemoval("removing");
    const log: string[] = [];
    const ports = removalPorts(Promise.resolve(), log);
    const interrupted = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(both),
      clock: new ManualClock(now),
      ports,
      recovery: harness.store,
    });
    if (!interrupted.ok) throw new Error("Expected resumed removal.");
    await interrupted.value.whenIdle();
    const durable = harness.removals.values().next().value;
    if (durable === undefined) throw new Error("Expected durable removal.");
    expect(durable.markerState).toBe("removing");
    const resumed = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(durable),
      clock: new ManualClock(now),
      ports,
      recovery: harness.store,
    });
    if (!resumed.ok) throw new Error("Expected resumed removal.");
    await resumed.value.whenIdle();
    expect(log).toEqual(["resolve-failure", "remove-marker", "clear-session"]);
    expect(harness.removals.size).toBe(0);
  });

  it("resumes terminal cleanup without deleting an already removed marker", async () => {
    const now = 5100;
    const harness = createRecoveryHarness();
    const removed = {
      ...removal(now),
      deleteEventAcknowledged: true,
      markerState: "removed" as const,
      trashAcknowledged: true,
    };
    await harness.store.beginRemoval(removed);
    const finalize = harness.store.finalizeRemovalRecovery.bind(harness.store);
    let finalizations = 0;
    let legacyCompletions = 0;
    harness.store.finalizeRemovalRecovery = async (
      request,
    ): Promise<CommandResultV1<void>> => {
      finalizations += 1;
      return finalize(request);
    };
    harness.store.completeSaga = async (): Promise<CommandResultV1<void>> => {
      legacyCompletions += 1;
      return commandFailure("sidecar-conflict");
    };
    const log: string[] = [];
    const resumed = await resumeAnnotationRemovalV1({
      activeRecovery: activeRemoval(removed),
      clock: new ManualClock(now),
      ports: removalPorts(Promise.resolve(), log),
      recovery: harness.store,
    });
    if (!resumed.ok) throw new Error("Expected resumed removal coordinator.");
    await resumed.value.whenIdle();
    expect(log).toEqual(["clear-session"]);
    expect(finalizations).toBe(1);
    expect(legacyCompletions).toBe(0);
    expect(harness.removals.size).toBe(0);
  });
});
