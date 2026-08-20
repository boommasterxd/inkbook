/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact invalid transitions and identities exercise fail-closed branches. */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  DATABASE_SCHEMA_VERSION,
  openIndexedDbRecoveryStore,
} from "../../../src/adapters/recovery-indexed-db";
import {
  createSettingsRevision,
  parseRecoveryAttemptId,
  parseRelocationId,
  parseSha256Digest,
} from "../../../src/application/note-session";
import {
  encodeRecoveryRecordV1,
  type RecoveryStore,
  type RelocationRecordV1,
  type RemovalRecordV1,
} from "../../../src/application/recovery";
import { sha256Bytes } from "../../../src/domain/codecs/sha256";
import { createSceneRevision } from "../../../src/domain/model";
import {
  BASE,
  NEXT_BASE,
  NOTE,
  fileRelocation,
  hostAcknowledgement,
  idPayload,
  openRawDatabase,
  openStore,
  prefixRelocation,
  preparedAttempt,
  replaceStoredEncodedKeepingSha256,
  removal,
} from "./support";

// eslint-disable-next-line max-lines-per-function -- The rejection scenarios form one cohesive fail-closed suite.
describe("IndexedDB recovery fail-closed branches", () => {
  it("rejects malformed schemas, invalid limits, and unavailable default storage", async () => {
    await expect(openIndexedDbRecoveryStore()).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    const factory = new IDBFactory();
    const malformed = await openRawDatabase(
      factory,
      "malformed-schema",
      DATABASE_SCHEMA_VERSION,
      (database) => database.createObjectStore("wrong"),
    );
    malformed.close();
    await expect(
      openIndexedDbRecoveryStore({
        databaseName: "malformed-schema",
        indexedDb: factory,
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await expect(
      openIndexedDbRecoveryStore({
        databaseName: "invalid-limits",
        indexedDb: new IDBFactory(),
        limits: { noteRecords: 0 },
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
  });

  it("rejects invalid starts, transitions, and attempt identities before writes", async () => {
    const { store } = await openStore("invalid-writes");
    await expect(
      store.beginRelocation(fileRelocation("sidecar-moved")),
    ).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    await expect(
      store.beginRemoval(removal({ trashAcknowledged: true })),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await expect(
      store.recordForward(
        "invalid" as ReturnType<typeof parseRecoveryAttemptId>,
        hostAcknowledgement(),
      ),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await expect(
      store.recordForward(
        parseRecoveryAttemptId(`ra_${idPayload(99)}`),
        hostAcknowledgement(),
      ),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });

  it("binds rekey to one durable relocation and collision-free destination", async () => {
    const { store } = await openStore("invalid-rekey");
    const replacement = {
      ...NOTE,
      vaultRelativeMarkdownPath: "notes/destination.md",
    };
    await expect(
      store.rekeyNote({
        prior: NOTE,
        relocationId: parseRelocationId(`rel_${idPayload(99)}`),
        replacement,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.rekeyNote({
        prior: NOTE,
        relocationId: parseRelocationId(`rel_${idPayload(99)}`),
        replacement: NOTE,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });

    const saga = fileRelocation();
    await store.beginRelocation(saga);
    await store.prepareForward(preparedAttempt(1, 1));
    await store.prepareForward(
      preparedAttempt(2, 1, {
        ...BASE,
        markdownPath: replacement.vaultRelativeMarkdownPath,
        vaultRelativePath: "notes/destination.inkbook.json",
      }),
    );
    await expect(
      store.rekeyNote({
        prior: NOTE,
        relocationId: saga.relocationId,
        replacement,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });

  it("rejects acknowledgement forks at an already occupied replacement base", async () => {
    const { store } = await openStore("acknowledgement-destination-fork");
    const prior = preparedAttempt(1, 1);
    const occupied = preparedAttempt(2, 2, NEXT_BASE, 2);
    const nextRevision = NEXT_BASE.revision;
    if (nextRevision === null) throw new Error("Expected a sidecar revision.");
    await store.prepareForward(prior);
    await store.prepareForward(occupied);
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: NEXT_BASE,
        coveredAttemptIds: [prior.attemptId],
        coveredCheckpointIds: [],
        expectedPriorBase: BASE,
        noteIdentity: NOTE,
        sceneRevision: 2 as typeof prior.expectedSceneRevision,
        sidecarRevision: nextRevision,
        sourceDigest: occupied.expectedSourceDigest,
        sourceGeneration: occupied.expectedSourceGeneration,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });

  it("rejects terminal saga payloads that no longer match their durable SHA", async () => {
    await rejectsCorruptFileCompletion();
    await rejectsCorruptPrefixCompletion();
    await rejectsCorruptRemovalCompletion();
  });
});

async function rejectsCorruptFileCompletion(): Promise<void> {
  const databaseName = "corrupt-file-completion";
  const { store, factory } = await openStore(databaseName);
  let expected = fileRelocation();
  await store.beginRelocation(expected);
  for (const step of [
    "sidecar-moved",
    "identities-rekeyed",
    "sidecar-metadata-saved",
    "marker-saved",
    "checkpoint-acknowledged",
    "complete",
  ] as const) {
    const replacement = fileRelocation(step);
    await store.advanceRelocation({ expected, replacement });
    expected = replacement;
  }
  await expectCorruptCompletionRejected(
    store,
    factory,
    databaseName,
    expected,
    {
      ...expected,
      expectedSceneRevision: createSceneRevision(2),
    },
  );
  await store.dispose();
}

async function rejectsCorruptPrefixCompletion(): Promise<void> {
  const databaseName = "corrupt-prefix-completion";
  const { store, factory } = await openStore(databaseName);
  const prepared = prefixRelocation();
  const complete = { ...prepared, step: "complete" as const };
  await store.beginRelocation(prepared);
  await store.advanceRelocation({ expected: prepared, replacement: complete });
  await expectCorruptCompletionRejected(
    store,
    factory,
    databaseName,
    complete,
    {
      ...complete,
      expectedSettingsRevision: createSettingsRevision(2),
    },
  );
  await store.dispose();
}

async function rejectsCorruptRemovalCompletion(): Promise<void> {
  const databaseName = "corrupt-removal-completion";
  const { store, factory } = await openStore(databaseName);
  const prepared = removal();
  const removing = removal({
    deleteEventAcknowledged: true,
    markerState: "removing",
    trashAcknowledged: true,
  });
  const complete = { ...removing, markerState: "removed" as const };
  await store.beginRemoval(prepared);
  await store.advanceRemoval({ expected: prepared, replacement: removing });
  await store.advanceRemoval({ expected: removing, replacement: complete });
  await expectCorruptCompletionRejected(
    store,
    factory,
    databaseName,
    complete,
    {
      ...complete,
      expectedSceneRevision: createSceneRevision(2),
    },
  );
  await store.dispose();
}

async function expectCorruptCompletionRejected(
  store: RecoveryStore,
  factory: IDBFactory,
  databaseName: string,
  original: RelocationRecordV1 | RemovalRecordV1,
  corrupted: RelocationRecordV1 | RemovalRecordV1,
): Promise<void> {
  const originalBytes = encodeRecoveryRecordV1(original);
  const corruptedBytes = encodeRecoveryRecordV1(corrupted);
  if (!originalBytes.ok || !corruptedBytes.ok) {
    throw new Error("Expected terminal saga encoding.");
  }
  expect(corruptedBytes.value.byteLength).toBe(originalBytes.value.byteLength);
  const removalSaga = original.kind === "annotation-removal";
  const kind = removalSaga ? "removal" : "relocation";
  const id = removalSaga ? original.removalId : original.relocationId;
  await replaceStoredEncodedKeepingSha256(
    factory,
    databaseName,
    `${kind}:${id}`,
    corruptedBytes.value,
  );
  const request = {
    expectedTerminalRecordSha256: parseSha256Digest(
      await sha256Bytes(originalBytes.value),
    ),
    id,
    kind,
  } as const;
  await expect(store.completeSaga(request)).resolves.toEqual({
    ok: false,
    code: "recovery-unavailable",
  });
  await expect(store.completeSaga(request)).resolves.toEqual({
    ok: false,
    code: "recovery-unavailable",
  });
}
