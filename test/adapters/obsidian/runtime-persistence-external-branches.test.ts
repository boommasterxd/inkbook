/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact digest and revision values define persistence identities. */
import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";

import {
  createRuntimePersistenceExternalStateV1,
  RuntimePersistenceExternalV1,
  RuntimeOwnedSidecarWriteV1,
  type RuntimePersistenceExternalStateV1,
} from "../../../src/adapters/obsidian/runtime-persistence-external";
import type { RuntimePersistenceHistoryV1 } from "../../../src/adapters/obsidian/runtime-persistence-external";
import type { RuntimePersistenceConfigV1 } from "../../../src/adapters/obsidian/runtime-session";
import {
  createSidecarRevision,
  createSourceGeneration,
  parseRemovalId,
  parseSha256Digest,
  type NoteSessionV1,
} from "../../../src/application/note-session";
import type {
  RecoveryStore,
  RemovalRecordV1,
  SidecarBaseIdentityV1,
} from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import { createRecoveryHarness } from "../../application/persistence/saga-support";

const DIGEST = parseSha256Digest("a".repeat(64));
const BASE: SidecarBaseIdentityV1 = Object.freeze({
  markdownPath: "Notes/External.md",
  rawTextSha256: DIGEST,
  revision: createSidecarRevision(1),
  vaultRelativePath: "Notes/External.inkbook.json",
});
const INPUT = {
  activeRelocation: null,
  base: BASE,
  identity: {
    vaultIdHint: "vault",
    vaultRelativeMarkdownPath: BASE.markdownPath,
  },
  pendingRecovery: false,
  rawText: "{}\n",
  source: { digest: DIGEST, generation: createSourceGeneration(1) },
  sourceUtf16Length: 3,
} as const;

describe("runtime persistence external state admission", () => {
  it("requires both a durable sidecar base and source evidence", () => {
    expect(
      createRuntimePersistenceExternalStateV1({ ...INPUT, base: null }),
    ).toBeNull();
    expect(
      createRuntimePersistenceExternalStateV1({ ...INPUT, source: undefined }),
    ).toBeNull();
    expect(createRuntimePersistenceExternalStateV1(INPUT)).toEqual({
      activeRelocation: null,
      base: BASE,
      identity: INPUT.identity,
      pendingRecovery: false,
      rawText: INPUT.rawText,
      sourceDigest: DIGEST,
      sourceGeneration: createSourceGeneration(1),
      sourceUtf16Length: INPUT.sourceUtf16Length,
    });
  });
});

describe("runtime owned sidecar acknowledgements", () => {
  it("consumes only the prepared base once", () => {
    const writes = new RuntimeOwnedSidecarWriteV1();

    expect(writes.consume(BASE)).toBe(false);
    writes.prepare(BASE);
    expect(
      writes.consume({ ...BASE, revision: createSidecarRevision(2) }),
    ).toBe(false);
    expect(writes.consume(BASE)).toBe(true);
    expect(writes.consume(BASE)).toBe(false);
  });

  it("rejects only the exact prepared object", () => {
    const writes = new RuntimeOwnedSidecarWriteV1();
    writes.prepare(BASE);
    writes.reject({ ...BASE });
    expect(writes.consume(BASE)).toBe(true);

    writes.prepare(BASE);
    writes.reject(BASE);
    expect(writes.consume(BASE)).toBe(false);
  });
});

describe("runtime persistence without external capabilities", () => {
  it("fails closed while disposal and removal resume stay idempotent", async () => {
    const recovery = createRecoveryHarness().store;
    const owner = new RuntimePersistenceExternalV1({
      config: minimalConfig(recovery),
      consumeOwnedWrite: (): boolean => false,
      history: {} as RuntimePersistenceHistoryV1,
      marker: {
        remove: async (): Promise<{ readonly kind: "acknowledged" }> => ({
          kind: "acknowledged",
        }),
      },
      onReload: (): void => undefined,
      onRemoved: (): void => undefined,
      readState: (): null => null,
      session: {} as NoteSessionV1,
    });
    const removal = removalRecord();
    expect(owner.mutationBlocked).toBe(false);
    owner.resumeRemoval({ attempts: [], checkpoints: [], removal });

    await expect(
      owner.accept({
        kind: "delete",
        target: hostFile(BASE.vaultRelativePath),
      }),
    ).resolves.toEqual({ code: "sidecar-conflict", ok: false });
    await expect(
      owner.accept({
        kind: "modify",
        target: hostFile(BASE.vaultRelativePath),
      }),
    ).resolves.toEqual({ code: "sidecar-conflict", ok: false });
    await expect(owner.startRemoval(removal)).resolves.toEqual({
      code: "read-only-mode",
      ok: false,
    });
    await expect(owner.resolve({ kind: "cancel-read-only" })).resolves.toEqual({
      code: "sidecar-conflict",
      ok: false,
    });
    await owner.dispose();
    await owner.dispose();
  });

  it("retains a sanitized retry cause when removal resume fails", async () => {
    const removal = removalRecord();
    const owner = new RuntimePersistenceExternalV1({
      config: removalConfig(createRecoveryHarness().store),
      consumeOwnedWrite: (): boolean => false,
      history: {} as RuntimePersistenceHistoryV1,
      marker: {
        remove: async (): Promise<{ readonly kind: "acknowledged" }> => ({
          kind: "acknowledged",
        }),
      },
      onReload: (): void => undefined,
      onRemoved: (): void => undefined,
      readState: (): RuntimePersistenceExternalStateV1 | null =>
        createRuntimePersistenceExternalStateV1(INPUT),
      session: {
        enqueue: async () => ({
          kind: "rejected",
          reason: "resource-limit",
        }),
      } as unknown as NoteSessionV1,
    });
    owner.resumeRemoval({ attempts: [], checkpoints: [], removal });

    await expect(
      owner.accept({
        kind: "delete",
        target: hostFile(BASE.vaultRelativePath),
      }),
    ).resolves.toEqual({ code: "sidecar-conflict", ok: false });
    await expect(owner.startRemoval(removal)).resolves.toEqual({
      code: "invalid-command",
      ok: false,
    });
    expect(owner.issueStatus).toEqual({
      conflict: { kind: "none" },
      drift: { kind: "none" },
      retry: { action: "removal", attemptCount: 2, kind: "available" },
    });
    await owner.dispose();
  });
});

function removalRecord(): RemovalRecordV1 {
  return {
    deadlineEpochMs: 2_000,
    deleteEventAcknowledged: false,
    expectedSceneRevision: createSceneRevision(1),
    kind: "annotation-removal",
    markerState: "present",
    noteIdentity: INPUT.identity,
    removalId: parseRemovalId("rm_00000000000000000000000000"),
    sidecarBase: BASE,
    trashAcknowledged: false,
  };
}

function hostFile(path: string): TFile {
  const file = Object.create(TFile.prototype) as TFile;
  Object.defineProperties(file, {
    path: { value: path },
    stat: { value: { ctime: 0, mtime: 0, size: 0 } },
  });
  return file;
}

function minimalConfig(recovery: RecoveryStore): RuntimePersistenceConfigV1 {
  return {
    identity: INPUT.identity,
    recovery,
  } as unknown as RuntimePersistenceConfigV1;
}

function removalConfig(recovery: RecoveryStore): RuntimePersistenceConfigV1 {
  return {
    identity: INPUT.identity,
    recovery,
    removalTrash: { trashSidecar: async (): Promise<void> => undefined },
    resolveMarkdownFile: () => null,
  } as unknown as RuntimePersistenceConfigV1;
}
