/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact persistence transitions are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  PersistencePermitPool,
  SavePipeline,
  type EncodedSaveV1,
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
} from "../../../src/application/note-session";
import { createSceneRevision } from "../../../src/domain/model";

const DIGEST = parseSha256Digest("a".repeat(64));
const BASE = Object.freeze({
  vaultRelativePath: "Notes/Example.inkbook.json",
  markdownPath: "Notes/Example.md",
  revision: createSidecarRevision(1),
  rawTextSha256: DIGEST,
});
const NOTE = Object.freeze({
  vaultIdHint: "vault",
  vaultRelativeMarkdownPath: "Notes/Example.md",
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function pipeline(
  overrides: Partial<SavePipelinePortsV1<string, string>> = {},
  permits = new PersistencePermitPool("phone"),
): SavePipeline<string, string> {
  return new SavePipeline(NOTE, BASE, permits, {
    encode: async (): Promise<EncodedSaveV1<string>> => ({
      payload: "encoded",
      rawTextSha256: DIGEST,
    }),
    prepareVaultWrite: async () => ({ kind: "written" }),
    acknowledgeRecovery: async () => ({ ok: true }),
    nowEpochMs: () => 1,
    ...overrides,
  });
}

function request(generation: number): SaveGenerationRequestV1<string> {
  return {
    generation: createSaveGeneration(generation),
    coveredAttemptIds: [],
    coveredCheckpointIds: [],
    capture: (): SaveCaptureV1<string> => ({
      snapshot: `scene-${String(generation)}`,
      sceneRevision: createSceneRevision(generation),
      sourceGeneration: createSourceGeneration(generation),
      sourceDigest: DIGEST,
    }),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("PersistencePermitPool failure paths", () => {
  it("rejects aborted admission and releases queued ownership idempotently", async () => {
    const pool = new PersistencePermitPool("phone");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(pool.acquire(alreadyAborted.signal)).resolves.toBeNull();

    const held = await pool.acquire(new AbortController().signal);
    const waitingAbort = new AbortController();
    const waiting = pool.acquire(waitingAbort.signal);
    waitingAbort.abort();
    await expect(waiting).resolves.toBeNull();
    expect(pool.waitingCount).toBe(0);
    held?.release();
    held?.release();
    expect(pool.activeCount).toBe(0);
  });
});

describe("SavePipeline failure and cancellation paths", () => {
  it("keeps failed recovery coverage until a later generation is acknowledged", async () => {
    const acknowledgements: Parameters<
      SavePipelinePortsV1<string, string>["acknowledgeRecovery"]
    >[0][] = [];
    let writeCount = 0;
    const subject = pipeline({
      prepareVaultWrite: async () => ({
        kind: writeCount++ === 0 ? "failed" : "written",
      }),
      acknowledgeRecovery: async (value) => {
        acknowledgements.push(value);
        return { ok: true };
      },
    });
    const first = {
      ...request(1),
      coveredAttemptIds: [
        parseRecoveryAttemptId("ra_00000000000000000000000001"),
      ],
      coveredCheckpointIds: [
        parseSourceCheckpointId("scp_00000000000000000000000001"),
      ],
    };
    const second = {
      ...request(2),
      coveredAttemptIds: [
        parseRecoveryAttemptId("ra_00000000000000000000000002"),
      ],
      coveredCheckpointIds: [
        parseSourceCheckpointId("scp_00000000000000000000000002"),
      ],
    };

    await expect(subject.enqueue(first)).resolves.toEqual({ kind: "failed" });
    await expect(subject.enqueue(second)).resolves.toMatchObject({
      kind: "acknowledged",
    });
    expect(acknowledgements[0]?.coveredAttemptIds).toEqual([
      ...first.coveredAttemptIds,
      ...second.coveredAttemptIds,
    ]);
    expect(acknowledgements[0]?.coveredCheckpointIds).toEqual([
      ...first.coveredCheckpointIds,
      ...second.coveredCheckpointIds,
    ]);
  });

  it("retries the same dirty generation only after a transient failure", async () => {
    let writeCount = 0;
    const subject = pipeline({
      prepareVaultWrite: async () => {
        writeCount += 1;
        return { kind: writeCount === 1 ? "failed" : "written" };
      },
    });
    const dirty = request(1);

    await expect(subject.enqueue(dirty)).resolves.toEqual({ kind: "failed" });
    await expect(subject.enqueue(dirty)).resolves.toEqual({
      kind: "acknowledged",
      clearedLatestDirty: true,
    });
    expect(writeCount).toBe(2);
  });
});

describe("SavePipeline cancellation and acknowledgement paths", () => {
  it("cancels only the latest waiting generation", async () => {
    const encoding = deferred<EncodedSaveV1<string>>();
    const subject = pipeline({ encode: async () => encoding.promise });
    const active = subject.enqueue(request(1));
    await flush();
    const waiting = subject.enqueue(request(2));

    expect(subject.cancel(createSaveGeneration(2))).toBe(true);
    await expect(waiting).resolves.toEqual({ kind: "cancelled" });
    encoding.resolve({ payload: "encoded", rawTextSha256: DIGEST });
    await expect(active).resolves.toMatchObject({ kind: "acknowledged" });
  });

  it("disposes an idle pipeline immediately and idempotently", async () => {
    const subject = pipeline();

    await expect(subject.dispose()).resolves.toBeUndefined();
    await expect(subject.dispose()).resolves.toBeUndefined();
    expect(subject.snapshot.disposed).toBe(true);
  });

  it("drops waiting work after a recovery acknowledgement conflict", async () => {
    const encoding = deferred<EncodedSaveV1<string>>();
    const subject = pipeline({
      encode: async () => encoding.promise,
      acknowledgeRecovery: async () => ({ ok: false }),
    });
    const active = subject.enqueue(request(1));
    await flush();
    const waiting = subject.enqueue(request(2));
    encoding.resolve({ payload: "encoded", rawTextSha256: DIGEST });

    await expect(active).resolves.toEqual({ kind: "recovery-conflict" });
    await expect(waiting).resolves.toEqual({ kind: "stale" });
    await expect(subject.enqueue(request(3))).resolves.toEqual({
      kind: "rejected",
    });
  });

  it("fails closed when recovery acknowledgement throws after the write", async () => {
    const subject = pipeline({
      acknowledgeRecovery: async () => {
        throw new Error("simulated acknowledgement failure");
      },
    });

    await expect(subject.enqueue(request(1))).resolves.toEqual({
      kind: "recovery-conflict",
    });
  });

  it("reports cancellation when a committed write completes after abort", async () => {
    const writing = deferred<{ readonly kind: "written" }>();
    const subject = pipeline({
      prepareVaultWrite: async () => writing.promise,
    });
    const result = subject.enqueue(request(1));
    await flush();

    expect(subject.cancel(createSaveGeneration(1))).toBe(true);
    writing.resolve({ kind: "written" });
    await expect(result).resolves.toEqual({ kind: "cancelled" });
  });

  it("reports cancellation when acknowledgement rejects after abort", async () => {
    const acknowledging = deferred<{ readonly ok: boolean }>();
    const subject = pipeline({
      acknowledgeRecovery: async () => acknowledging.promise,
    });
    const result = subject.enqueue(request(1));
    await flush();

    expect(subject.cancel(createSaveGeneration(1))).toBe(true);
    acknowledging.reject(new Error("simulated late failure"));
    await expect(result).resolves.toEqual({ kind: "cancelled" });
  });

  it("cancels before capture when global admission is still queued", async () => {
    const pool = new PersistencePermitPool("phone");
    const held = await pool.acquire(new AbortController().signal);
    const subject = pipeline({}, pool);
    const result = subject.enqueue(request(1));
    await flush();

    expect(subject.cancel(createSaveGeneration(1))).toBe(true);
    await expect(result).resolves.toEqual({ kind: "cancelled" });
    held?.release();
    expect(pool.activeCount).toBe(0);
  });
});
