/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact barrier and revision values define the removal records. */
import { describe, expect, it } from "vitest";

import {
  runtimeRemovalMatchesBaseV1,
  runtimeRemovalSourceEvidenceV1,
  RuntimeRemovalV1,
} from "../../../src/adapters/obsidian/runtime-removal";
import type { VaultFileCapability } from "../../../src/adapters/obsidian/vault-sidecar/paths";
import {
  commandFailure,
  commandSuccess,
  createSidecarRevision,
  createSourceGeneration,
  parseRemovalId,
  parseSha256Digest,
  type CommandResultV1,
} from "../../../src/application/note-session";
import {
  REMOVAL_BARRIER_TIMEOUT_MS_V1,
  type RemovalClockV1,
} from "../../../src/application/persistence";
import type {
  ActiveRemovalRecoveryV1,
  RecoveryStore,
  RemovalRecordV1,
} from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import {
  createRecoveryHarness,
  deferred,
} from "../../application/persistence/saga-support";

const NOW = 30_000;
const REMOVAL_ID = parseRemovalId("rm_00000000000000000000000000");
const OTHER_REMOVAL_ID = parseRemovalId("rm_11111111111111111111111111");
const BASE = Object.freeze({
  markdownPath: "Notes/Removal.md",
  rawTextSha256: parseSha256Digest("a".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: "Notes/Removal.inkbook.json",
});

class FixedClock implements RemovalClockV1 {
  public now(): number {
    return NOW;
  }

  public setTimeout(): number {
    return 1;
  }

  public clearTimeout(): void {
    return undefined;
  }
}

type MarkerResult = Awaited<
  ReturnType<
    import("../../../src/adapters/obsidian/vault-sidecar/marker").SidecarMarkerWriter["remove"]
  >
>;

interface FixtureOptionsV1 {
  readonly marker?: () => Promise<MarkerResult>;
  readonly recovery?: RecoveryStore;
  readonly resolveFile?: () => VaultFileCapability | null;
  readonly trash?: () => Promise<void>;
}

interface FixtureV1 {
  readonly externalDeletes: string[];
  readonly failures: number[];
  readonly runtime: RuntimeRemovalV1;
}

function fixture(options: FixtureOptionsV1 = {}): FixtureV1 {
  const externalDeletes: string[] = [];
  const failures: number[] = [];
  const success = async (): Promise<CommandResultV1<void>> =>
    commandSuccess(undefined);
  return {
    externalDeletes,
    failures,
    runtime: new RuntimeRemovalV1({
      callbacks: {
        clearSession: success,
        handleExternalDelete: async (base): Promise<CommandResultV1<void>> => {
          externalDeletes.push(base.vaultRelativePath);
          return commandSuccess(undefined);
        },
        resolveFailure: async (): Promise<CommandResultV1<void>> => {
          failures.push(1);
          return commandSuccess(undefined);
        },
      },
      clock: new FixedClock(),
      marker: {
        remove:
          options.marker ??
          (async (): Promise<MarkerResult> => ({ kind: "acknowledged" })),
      },
      recovery: options.recovery ?? createRecoveryHarness().store,
      resolveMarkdownFile:
        options.resolveFile ??
        ((): VaultFileCapability => ({
          path: BASE.markdownPath,
          stat: { size: 0 },
        })),
      trash: {
        trashSidecar: options.trash ?? (async (): Promise<void> => undefined),
      },
    }),
  };
}

function record(
  trashAcknowledged = false,
  deleteEventAcknowledged = false,
): RemovalRecordV1 {
  return {
    deadlineEpochMs: NOW + REMOVAL_BARRIER_TIMEOUT_MS_V1,
    deleteEventAcknowledged,
    expectedSceneRevision: createSceneRevision(1),
    kind: "annotation-removal",
    markerState: "present",
    noteIdentity: {
      vaultIdHint: "vault",
      vaultRelativeMarkdownPath: BASE.markdownPath,
    },
    removalId: REMOVAL_ID,
    sidecarBase: BASE,
    trashAcknowledged,
  };
}

function bundle(value: RemovalRecordV1): ActiveRemovalRecoveryV1 {
  return Object.freeze({ attempts: [], checkpoints: [], removal: value });
}

describe("RuntimeRemovalV1 inactive and disposal branches", () => {
  it("routes inactive deletes and keeps lifecycle methods idempotent", async () => {
    const value = fixture();

    expect(value.runtime.acceptActiveDelete(BASE)).toBeNull();
    await expect(
      value.runtime.acceptDeleteEvent({
        removalId: REMOVAL_ID,
        sidecarBase: BASE,
      }),
    ).resolves.toEqual({ consumed: false, reason: "inactive" });
    await expect(value.runtime.retryCleanup()).resolves.toEqual({
      code: "disposed",
      ok: false,
    });
    await value.runtime.whenIdle();
    await value.runtime.dispose();
    await value.runtime.dispose();
    await expect(value.runtime.start(record())).resolves.toEqual({
      code: "disposed",
      ok: false,
    });
    await expect(value.runtime.resume(bundle(record()))).resolves.toEqual({
      code: "disposed",
      ok: false,
    });
    expect(value.externalDeletes).toEqual([BASE.vaultRelativePath]);
  });

  it("rejects concurrent starts and resumes while allowing bounded retry", async () => {
    const trash = deferred<undefined>();
    const value = fixture({ trash: () => trash.promise });
    await expect(value.runtime.start(record())).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    await expect(value.runtime.start(record())).resolves.toEqual({
      code: "invalid-command",
      ok: false,
    });
    await expect(value.runtime.resume(bundle(record()))).resolves.toEqual({
      code: "invalid-command",
      ok: false,
    });
    await expect(value.runtime.retryCleanup()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await value.runtime.dispose();
    trash.resolve(undefined);
    await value.runtime.whenIdle();
    expect(value.failures).toEqual([1]);
  });
});

describe("RuntimeRemovalV1 pending ownership", () => {
  it("returns begin failure and clears the failed owner", async () => {
    const harness = createRecoveryHarness();
    const value = fixture({
      recovery: {
        ...harness.store,
        beginRemoval: async () => commandFailure("sidecar-conflict"),
      },
    });

    await expect(value.runtime.start(record())).resolves.toEqual({
      code: "sidecar-conflict",
      ok: false,
    });
    await value.runtime.whenIdle();
    expect(value.runtime.acceptActiveDelete(BASE)).toBeNull();
  });

  it("routes a mismatched event when durable begin fails", async () => {
    const harness = createRecoveryHarness();
    const begin = deferred<CommandResultV1<void>>();
    const value = fixture({
      recovery: {
        ...harness.store,
        beginRemoval: () => begin.promise,
      },
    });
    const starting = value.runtime.start(record());
    const retrying = value.runtime.retryCleanup();
    const idling = value.runtime.whenIdle();
    const deleting = value.runtime.acceptDeleteEvent({
      removalId: OTHER_REMOVAL_ID,
      sidecarBase: BASE,
    });
    const matching = value.runtime.acceptDeleteEvent({
      removalId: REMOVAL_ID,
      sidecarBase: BASE,
    });
    begin.resolve(commandFailure("sidecar-conflict"));

    await expect(starting).resolves.toEqual({
      code: "sidecar-conflict",
      ok: false,
    });
    await expect(deleting).resolves.toEqual({
      consumed: false,
      reason: "mismatch",
    });
    await expect(matching).resolves.toEqual({
      consumed: false,
      reason: "inactive",
    });
    await expect(retrying).resolves.toEqual({
      code: "sidecar-drift",
      ok: false,
    });
    await idling;
    expect(value.externalDeletes).toEqual([
      BASE.vaultRelativePath,
      BASE.vaultRelativePath,
    ]);
  });

  it("disposes a coordinator that becomes ready after owner disposal", async () => {
    const harness = createRecoveryHarness();
    const begin = deferred<true>();
    const durableBegin = harness.store.beginRemoval.bind(harness.store);
    const value = fixture({
      recovery: {
        ...harness.store,
        beginRemoval: async (removal) => {
          await begin.promise;
          return durableBegin(removal);
        },
      },
    });
    const starting = value.runtime.start(record());
    const disposing = value.runtime.dispose();
    begin.resolve(true);

    await expect(starting).resolves.toEqual({ code: "disposed", ok: false });
    await disposing;
    expect(value.failures).toEqual([1]);
  });

  it("propagates an invalid durable resume and releases ownership", async () => {
    const value = fixture();
    const expired = { ...record(), deadlineEpochMs: NOW };

    await expect(value.runtime.resume(bundle(expired))).resolves.toEqual({
      code: "sidecar-drift",
      ok: false,
    });
    expect(value.runtime.acceptActiveDelete(BASE)).toBeNull();
    expect(value.failures).toEqual([1]);
  });
});

describe("RuntimeRemovalV1 marker cleanup failures", () => {
  it.each([
    [
      "missing file",
      (): null => null,
      async (): Promise<MarkerResult> => ({ kind: "acknowledged" }),
    ],
    [
      "marker conflict",
      (): VaultFileCapability => ({
        path: BASE.markdownPath,
        stat: { size: 0 },
      }),
      async (): Promise<MarkerResult> => ({ kind: "conflict" }),
    ],
    [
      "marker rejection",
      (): VaultFileCapability => ({
        path: BASE.markdownPath,
        stat: { size: 0 },
      }),
      async (): Promise<MarkerResult> =>
        Promise.reject(new Error("marker failed")),
    ],
  ] as const)("fails closed for %s", async (_name, resolveFile, marker) => {
    const harness = createRecoveryHarness();
    const durable = record(true, true);
    await harness.store.beginRemoval(durable);
    const value = fixture({ marker, recovery: harness.store, resolveFile });

    await expect(value.runtime.resume(bundle(durable))).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await value.runtime.whenIdle();
    await expect(value.runtime.retryCleanup()).resolves.toEqual({
      code: "sidecar-drift",
      ok: false,
    });
    expect(harness.removals.size).toBe(1);
  });

  it("retries a transient marker conflict without repeating the barrier", async () => {
    const harness = createRecoveryHarness();
    const durable = record(true, true);
    await harness.store.beginRemoval(durable);
    let attempts = 0;
    const value = fixture({
      marker: async () => {
        attempts += 1;
        return attempts === 1
          ? { kind: "cancelled" }
          : { kind: "acknowledged" };
      },
      recovery: harness.store,
    });

    await value.runtime.resume(bundle(durable));
    await value.runtime.whenIdle();
    await expect(value.runtime.retryCleanup()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(attempts).toBe(2);
    expect(harness.removals.size).toBe(0);
  });
});

describe("runtime removal restart evidence", () => {
  it("prefers current checkpoint evidence, then attempts, then generation one", () => {
    const currentDigest = parseSha256Digest("b".repeat(64));
    const staleDigest = parseSha256Digest("c".repeat(64));
    const checkpointGeneration = createSourceGeneration(3);
    const attemptGeneration = createSourceGeneration(2);
    const checkpointBundle = {
      ...bundle(record()),
      checkpoints: [
        {
          replacementDigest: currentDigest,
          replacementGeneration: checkpointGeneration,
        },
      ],
    } as unknown as ActiveRemovalRecoveryV1;
    const attemptBundle = {
      ...bundle(record()),
      attempts: [
        {
          expectedSourceDigest: currentDigest,
          expectedSourceGeneration: attemptGeneration,
        },
      ],
    } as unknown as ActiveRemovalRecoveryV1;

    expect(
      runtimeRemovalSourceEvidenceV1(checkpointBundle, currentDigest),
    ).toEqual({
      digest: currentDigest,
      generation: checkpointGeneration,
    });
    expect(
      runtimeRemovalSourceEvidenceV1(checkpointBundle, staleDigest),
    ).toBeNull();
    expect(
      runtimeRemovalSourceEvidenceV1(attemptBundle, currentDigest),
    ).toEqual({
      digest: currentDigest,
      generation: attemptGeneration,
    });
    expect(
      runtimeRemovalSourceEvidenceV1(attemptBundle, staleDigest),
    ).toBeNull();
    expect(
      runtimeRemovalSourceEvidenceV1(bundle(record()), currentDigest),
    ).toEqual({
      digest: currentDigest,
      generation: createSourceGeneration(1),
    });
  });

  it("requires the same note identity, sidecar base, and scene revision", () => {
    const active = bundle(record());
    const identity = active.removal.noteIdentity;

    expect(runtimeRemovalMatchesBaseV1(active, identity, BASE, 1)).toBe(true);
    expect(
      runtimeRemovalMatchesBaseV1(
        active,
        { ...identity, vaultIdHint: "other-vault" },
        BASE,
        1,
      ),
    ).toBe(false);
    expect(
      runtimeRemovalMatchesBaseV1(
        active,
        { ...identity, vaultRelativeMarkdownPath: "Notes/Other.md" },
        BASE,
        1,
      ),
    ).toBe(false);
    expect(
      runtimeRemovalMatchesBaseV1(
        active,
        identity,
        { ...BASE, revision: createSidecarRevision(2) },
        1,
      ),
    ).toBe(false);
    expect(runtimeRemovalMatchesBaseV1(active, identity, BASE, 2)).toBe(false);
  });
});
