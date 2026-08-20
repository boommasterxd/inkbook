/* eslint-disable @typescript-eslint/no-magic-numbers -- Generations and revision transitions are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  PersistencePermitPool,
  SavePipeline,
  type EncodeSaveRequestV1,
  type EncodedSaveV1,
  type PreparedVaultWriteResultV1,
  type PreparedVaultWriteV1,
  type SaveCaptureV1,
  type SaveGenerationRequestV1,
  type SavePipelinePortsV1,
} from "../../../src/application/persistence/save-pipeline";
import {
  createSaveGeneration,
  createSidecarRevision,
  createSourceGeneration,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
  type NoteIdentityV1,
  type RecoveryAttemptId,
  type Sha256Digest,
  type SourceCheckpointId,
} from "../../../src/application/note-session";
import type {
  SidecarBaseIdentityV1,
  SidecarRecoveryAcknowledgementV1,
} from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";

const ID_PAYLOAD = "00000000000000000000000000";
const NOW = 1_755_734_400_000;
const NOTE: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/Example.md",
});
const ABSENT_BASE: SidecarBaseIdentityV1 = Object.freeze({
  vaultRelativePath: "Notes/Example.inkbook.json",
  revision: null,
  rawTextSha256: null,
  markdownPath: NOTE.vaultRelativeMarkdownPath,
});
const ACKNOWLEDGED_BASE: SidecarBaseIdentityV1 = Object.freeze({
  ...ABSENT_BASE,
  revision: createSidecarRevision(1),
  rawTextSha256: parseSha256Digest("f".repeat(64)),
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface TestHarness {
  readonly pipeline: SavePipeline<string, string>;
  readonly encodeRequests: EncodeSaveRequestV1<string>[];
  readonly writeRequests: PreparedVaultWriteV1<string>[];
  readonly acknowledgements: SidecarRecoveryAcknowledgementV1[];
  readonly encodeDeferred: Deferred<EncodedSaveV1<string>>[];
  readonly writeDeferred: Deferred<PreparedVaultWriteResultV1>[];
  readonly acknowledgementDeferred: Deferred<{ readonly ok: boolean }>[];
  readonly captures: number[];
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("Deferred promise was not initialized.");
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function digest(character: string): Sha256Digest {
  return parseSha256Digest(character.repeat(64));
}

function attemptId(index: number): RecoveryAttemptId {
  const suffix = String(index).padStart(2, "0");
  return parseRecoveryAttemptId(`ra_${ID_PAYLOAD.slice(0, -2)}${suffix}`);
}

function checkpointId(index: number): SourceCheckpointId {
  const suffix = String(index).padStart(2, "0");
  return parseSourceCheckpointId(`scp_${ID_PAYLOAD.slice(0, -2)}${suffix}`);
}

function request(
  generation: number,
  captures: number[],
  covered = generation,
): SaveGenerationRequestV1<string> {
  return {
    generation: createSaveGeneration(generation),
    coveredAttemptIds: [attemptId(covered)],
    coveredCheckpointIds: [checkpointId(covered)],
    capture: (): SaveCaptureV1<string> => {
      captures.push(generation);
      return {
        snapshot: `scene-${String(generation)}`,
        sceneRevision: createSceneRevision(generation),
        sourceGeneration: createSourceGeneration(generation),
        sourceDigest: digest("a"),
      };
    },
  };
}

function harness(
  permits = new PersistencePermitPool("phone"),
  controlled: Partial<Record<"encode" | "write" | "acknowledge", boolean>> = {},
  initialBase: SidecarBaseIdentityV1 = ACKNOWLEDGED_BASE,
): TestHarness {
  const encodeRequests: EncodeSaveRequestV1<string>[] = [];
  const writeRequests: PreparedVaultWriteV1<string>[] = [];
  const acknowledgements: SidecarRecoveryAcknowledgementV1[] = [];
  const encodeDeferred: Deferred<EncodedSaveV1<string>>[] = [];
  const writeDeferred: Deferred<PreparedVaultWriteResultV1>[] = [];
  const acknowledgementDeferred: Deferred<{ readonly ok: boolean }>[] = [];
  const captures: number[] = [];
  const ports: SavePipelinePortsV1<string, string> = {
    encode: async (value) => {
      encodeRequests.push(value);
      if (controlled.encode === true) {
        const pending = deferred<EncodedSaveV1<string>>();
        encodeDeferred.push(pending);
        return pending.promise;
      }
      return {
        payload: `encoded-${value.capture.snapshot}`,
        rawTextSha256: digest("b"),
      };
    },
    prepareVaultWrite: async (value) => {
      writeRequests.push(value);
      if (controlled.write === true) {
        const pending = deferred<PreparedVaultWriteResultV1>();
        writeDeferred.push(pending);
        return pending.promise;
      }
      return { kind: "written" };
    },
    acknowledgeRecovery: async (value) => {
      acknowledgements.push(value);
      if (controlled.acknowledge === true) {
        const pending = deferred<{ readonly ok: boolean }>();
        acknowledgementDeferred.push(pending);
        return pending.promise;
      }
      return { ok: true };
    },
    nowEpochMs: () => NOW,
  };
  return {
    pipeline: new SavePipeline(NOTE, initialBase, permits, ports),
    encodeRequests,
    writeRequests,
    acknowledgements,
    encodeDeferred,
    writeDeferred,
    acknowledgementDeferred,
    captures,
  };
}

describe("PersistencePermitPool", () => {
  it("enforces platform limits and admits waiters in FIFO order", async () => {
    const pool = new PersistencePermitPool("desktop-tablet");
    const first = await pool.acquire(new AbortController().signal);
    const second = await pool.acquire(new AbortController().signal);
    const thirdAbort = new AbortController();
    const thirdPromise = pool.acquire(thirdAbort.signal);

    expect(pool.limit).toBe(2);
    expect(pool.activeCount).toBe(2);
    expect(pool.waitingCount).toBe(1);
    first?.release();
    const third = await thirdPromise;
    expect(pool.activeCount).toBe(2);
    second?.release();
    third?.release();
    expect(pool.activeCount).toBe(0);

    expect(new PersistencePermitPool("phone").limit).toBe(1);
  });
});

describe("SavePipeline", () => {
  it("rejects an absent initial base so only FirstSidecarCoordinator may create revision 1", async () => {
    const test = harness(undefined, {}, ABSENT_BASE);

    await expect(
      test.pipeline.enqueue(request(1, test.captures)),
    ).resolves.toEqual({
      kind: "rejected",
    });
    expect(test.encodeRequests).toEqual([]);
    expect(test.writeRequests).toEqual([]);
    expect(test.acknowledgements).toEqual([]);
  });

  it("prepares a normal successor with exact base and recovery coverage", async () => {
    const test = harness();
    const result = await test.pipeline.enqueue(request(1, test.captures));

    expect(result).toEqual({ kind: "acknowledged", clearedLatestDirty: true });
    expect(test.encodeRequests[0]).toMatchObject({
      revision: 2,
      baseRevision: 1,
      savedAtEpochMs: NOW,
      capture: { snapshot: "scene-1" },
    });
    expect(test.writeRequests[0]).toMatchObject({
      kind: "compare-and-process",
      expectedPriorBase: ACKNOWLEDGED_BASE,
      acknowledgedReplacementBase: {
        ...ACKNOWLEDGED_BASE,
        revision: 2,
        rawTextSha256: digest("b"),
      },
      revision: 2,
      baseRevision: 1,
      payload: "encoded-scene-1",
    });
    expect(test.acknowledgements[0]).toEqual({
      noteIdentity: NOTE,
      expectedPriorBase: ACKNOWLEDGED_BASE,
      acknowledgedReplacementBase: {
        ...ACKNOWLEDGED_BASE,
        revision: createSidecarRevision(2),
        rawTextSha256: digest("b"),
      },
      coveredAttemptIds: [attemptId(1)],
      coveredCheckpointIds: [checkpointId(1)],
      sidecarRevision: createSidecarRevision(2),
      sceneRevision: createSceneRevision(1),
      sourceGeneration: createSourceGeneration(1),
      sourceDigest: digest("a"),
    });
    expect(test.pipeline.snapshot.latestDirtyGeneration).toBeNull();
  });

  it("coalesces only the waiting generation and never clears newer dirty work", async () => {
    const test = harness(undefined, { encode: true });
    const first = test.pipeline.enqueue(request(1, test.captures));
    await flushMicrotasks();
    const second = test.pipeline.enqueue(request(2, test.captures));
    const third = test.pipeline.enqueue(request(3, test.captures));

    await expect(second).resolves.toEqual({ kind: "replaced" });
    expect(test.captures).toEqual([1]);
    test.encodeDeferred[0]?.resolve({
      payload: "one",
      rawTextSha256: digest("b"),
    });
    await expect(first).resolves.toEqual({
      kind: "acknowledged",
      clearedLatestDirty: false,
    });
    expect(test.pipeline.snapshot.latestDirtyGeneration).toBe(
      createSaveGeneration(3),
    );
    await flushMicrotasks();
    expect(test.captures).toEqual([1, 3]);

    test.encodeDeferred[1]?.resolve({
      payload: "three",
      rawTextSha256: digest("c"),
    });
    await expect(third).resolves.toEqual({
      kind: "acknowledged",
      clearedLatestDirty: true,
    });
    expect(test.acknowledgements[1]?.coveredAttemptIds).toEqual([
      attemptId(2),
      attemptId(3),
    ]);
    expect(test.acknowledgements[1]?.coveredCheckpointIds).toEqual([
      checkpointId(2),
      checkpointId(3),
    ]);
    expect(test.writeRequests[1]).toMatchObject({
      kind: "compare-and-process",
      expectedPriorBase: { revision: 2, rawTextSha256: digest("b") },
      acknowledgedReplacementBase: { revision: 3, rawTextSha256: digest("c") },
      revision: 3,
      baseRevision: 2,
    });
  });
});

describe("SavePipeline scheduling", () => {
  it("keeps a permit while encoded work is blocked on I/O and serves notes fairly", async () => {
    const pool = new PersistencePermitPool("phone");
    const first = harness(pool, { write: true });
    const second = harness(pool, { write: true });
    const third = harness(pool, { write: true });
    const results = [
      first.pipeline.enqueue(request(1, first.captures)),
      second.pipeline.enqueue(request(1, second.captures)),
      third.pipeline.enqueue(request(1, third.captures)),
    ];
    await flushMicrotasks();

    expect(pool.activeCount).toBe(1);
    expect(pool.waitingCount).toBe(2);
    expect(first.writeRequests).toHaveLength(1);
    expect(second.captures).toEqual([]);
    first.writeDeferred[0]?.resolve({ kind: "written" });
    await expect(results[0]).resolves.toMatchObject({ kind: "acknowledged" });
    await flushMicrotasks();
    expect(second.writeRequests).toHaveLength(1);
    expect(third.captures).toEqual([]);
    second.writeDeferred[0]?.resolve({ kind: "written" });
    await expect(results[1]).resolves.toMatchObject({ kind: "acknowledged" });
    await flushMicrotasks();
    expect(third.writeRequests).toHaveLength(1);
    third.writeDeferred[0]?.resolve({ kind: "written" });

    await expect(Promise.all(results)).resolves.toEqual([
      { kind: "acknowledged", clearedLatestDirty: true },
      { kind: "acknowledged", clearedLatestDirty: true },
      { kind: "acknowledged", clearedLatestDirty: true },
    ]);
    expect(pool.activeCount).toBe(0);
  });

  it("cancels stale encoding without writing, acknowledging, or releasing twice", async () => {
    const pool = new PersistencePermitPool("phone");
    const test = harness(pool, { encode: true });
    const result = test.pipeline.enqueue(request(1, test.captures));
    await flushMicrotasks();

    expect(test.pipeline.cancel(createSaveGeneration(1))).toBe(true);
    test.encodeDeferred[0]?.resolve({
      payload: "stale",
      rawTextSha256: digest("b"),
    });
    await expect(result).resolves.toEqual({ kind: "cancelled" });
    expect(test.writeRequests).toEqual([]);
    expect(test.acknowledgements).toEqual([]);
    expect(test.pipeline.snapshot.latestDirtyGeneration).toBe(
      createSaveGeneration(1),
    );
    expect(pool.activeCount).toBe(0);
    expect(test.pipeline.cancel(createSaveGeneration(1))).toBe(false);
  });

  it("publishes nothing when cancellation makes a recovery acknowledgement stale", async () => {
    const pool = new PersistencePermitPool("phone");
    const test = harness(pool, { acknowledge: true });
    const result = test.pipeline.enqueue(request(1, test.captures));
    await flushMicrotasks();
    const baseBefore = test.pipeline.snapshot.currentBase;

    expect(test.pipeline.cancel(createSaveGeneration(1))).toBe(true);
    test.acknowledgementDeferred[0]?.resolve({ ok: true });
    await expect(result).resolves.toEqual({ kind: "cancelled" });
    expect(test.pipeline.snapshot.currentBase).toEqual(baseBefore);
    expect(test.pipeline.snapshot.latestDirtyGeneration).toBe(
      createSaveGeneration(1),
    );
    expect(pool.activeCount).toBe(0);
  });
});

describe("SavePipeline terminal behavior", () => {
  it.each([
    ["conflict", { kind: "conflict" }],
    ["failure", new Error("write failed")],
  ] as const)(
    "releases its permit exactly once after Vault %s",
    async (_name, completion) => {
      const pool = new PersistencePermitPool("phone");
      const test = harness(pool, { write: true });
      const result = test.pipeline.enqueue(request(1, test.captures));
      await flushMicrotasks();

      if (completion instanceof Error)
        test.writeDeferred[0]?.reject(completion);
      else test.writeDeferred[0]?.resolve(completion);
      await expect(result).resolves.toEqual({
        kind: completion instanceof Error ? "failed" : "conflict",
      });
      expect(pool.activeCount).toBe(0);
      expect(test.acknowledgements).toEqual([]);
    },
  );

  it("carries unacknowledged recovery coverage into the latest retry", async () => {
    const test = harness(undefined, { write: true });
    const first = test.pipeline.enqueue(request(1, test.captures));
    const retry = test.pipeline.enqueue(request(2, test.captures));
    await flushMicrotasks();

    test.writeDeferred[0]?.reject(new Error("write failed"));
    await expect(first).resolves.toEqual({ kind: "failed" });
    await flushMicrotasks();
    test.writeDeferred[1]?.resolve({ kind: "written" });
    await expect(retry).resolves.toMatchObject({ kind: "acknowledged" });
    expect(test.acknowledgements[0]?.coveredAttemptIds).toEqual([
      attemptId(1),
      attemptId(2),
    ]);
    expect(test.acknowledgements[0]?.coveredCheckpointIds).toEqual([
      checkpointId(1),
      checkpointId(2),
    ]);
  });

  it("disposes active and waiting work idempotently without stale publication", async () => {
    const pool = new PersistencePermitPool("phone");
    const test = harness(pool, { encode: true });
    const active = test.pipeline.enqueue(request(1, test.captures));
    const waiting = test.pipeline.enqueue(request(2, test.captures));
    await flushMicrotasks();
    const firstDispose = test.pipeline.dispose();
    const secondDispose = test.pipeline.dispose();

    await expect(waiting).resolves.toEqual({ kind: "disposed" });
    expect(pool.activeCount).toBe(1);
    test.encodeDeferred[0]?.resolve({
      payload: "late",
      rawTextSha256: digest("b"),
    });
    await expect(active).resolves.toEqual({ kind: "disposed" });
    await expect(Promise.all([firstDispose, secondDispose])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(test.writeRequests).toEqual([]);
    expect(test.acknowledgements).toEqual([]);
    expect(pool.activeCount).toBe(0);
    await expect(
      test.pipeline.enqueue(request(3, test.captures)),
    ).resolves.toEqual({
      kind: "disposed",
    });
  });

  it("does not retain a blocked note payload before global admission", async () => {
    const pool = new PersistencePermitPool("phone");
    const blocker = new AbortController();
    const permit = await pool.acquire(blocker.signal);
    const test = harness(pool);
    const result = test.pipeline.enqueue(request(1, test.captures));
    await flushMicrotasks();

    expect(test.captures).toEqual([]);
    expect(test.encodeRequests).toEqual([]);
    permit?.release();
    await expect(result).resolves.toEqual({
      kind: "acknowledged",
      clearedLatestDirty: true,
    });
    expect(test.captures).toEqual([1]);
  });

  it("rejects duplicate generations without replacing retained recovery coverage", async () => {
    const test = harness(undefined, { encode: true });
    const active = test.pipeline.enqueue(request(1, test.captures));
    await flushMicrotasks();
    const duplicate = test.pipeline.enqueue(request(1, test.captures, 2));

    await expect(duplicate).resolves.toEqual({ kind: "rejected" });
    test.encodeDeferred[0]?.resolve({
      payload: "one",
      rawTextSha256: digest("b"),
    });
    await expect(active).resolves.toMatchObject({ kind: "acknowledged" });
    expect(test.acknowledgements[0]?.coveredAttemptIds).toEqual([attemptId(1)]);
  });
});
