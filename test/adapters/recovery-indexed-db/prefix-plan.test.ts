/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact bounded plan ordinals and revisions are under test. */
import { describe, expect, it } from "vitest";

import {
  createSettingsRevision,
  createSidecarRevision,
  parseRelocationId,
  parseSha256Digest,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import {
  encodeRecoveryRecordV1,
  type PrefixRelocationMemberV1,
  type PrefixRelocationRecordV1,
} from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import { sha256Bytes } from "../../../src/domain/codecs/sha256";
import { idPayload, openStore, prefixRelocation } from "./support";

// eslint-disable-next-line max-lines-per-function -- The cohesive durable-plan lifecycle suite shares one bounded IndexedDB authority.
describe("IndexedDB durable prefix relocation plans", () => {
  it("persists canonical members across restart and removes them with completion", async () => {
    const { store, factory } = await openStore("prefix-plan-restart");
    const record = planRecord();
    const members = planMembers();
    await expect(store.beginRelocation(record)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      store.preparePrefixRelocationPlan({
        expectedPrefixRecord: record,
        members,
      }),
    ).resolves.toEqual({ ok: true, value: planSummary(record) });
    await expect(
      store.loadPrefixRelocationMember({
        ordinal: 1,
        relocationId: record.relocationId,
      }),
    ).resolves.toEqual({ ok: true, value: members[1] });
    await store.dispose();

    const reopened = await openStore("prefix-plan-restart", {}, factory);
    const loaded = await reopened.store.loadPrefixRelocationMember({
      ordinal: 0,
      relocationId: record.relocationId,
    });
    expect(loaded).toEqual({ ok: true, value: members[0] });
    if (!loaded.ok) throw new Error("Expected a durable plan member.");
    expect(Object.isFrozen(loaded.value)).toBe(true);
    expect(Object.isFrozen(loaded.value.priorNoteIdentity)).toBe(true);
    await expect(
      reopened.store.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [record] });

    const processing = { ...record, cursor: 2, step: "processing" as const };
    const terminal = { ...processing, step: "complete" as const };
    await reopened.store.advanceRelocation({
      expected: record,
      replacement: processing,
    });
    await reopened.store.advanceRelocation({
      expected: processing,
      replacement: terminal,
    });
    await expect(
      reopened.store.completeSaga({
        expectedTerminalRecordSha256: await digestRecord(terminal),
        id: terminal.relocationId,
        kind: "relocation",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      reopened.store.loadPrefixRelocationMember({
        ordinal: 0,
        relocationId: record.relocationId,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      reopened.store.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      reopened.store.loadRetainedPrefixRelocationRules({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [terminal] });
    await reopened.store.dispose();
  });

  it("uses exact bytes and the current prefix record as one preparation CAS", async () => {
    const { store } = await openStore("prefix-plan-cas");
    const record = planRecord();
    const members = planMembers();
    await store.beginRelocation(record);
    const request = { expectedPrefixRecord: record, members };
    await expect(
      store.preparePrefixRelocationPlan(request),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      store.preparePrefixRelocationPlan(request),
    ).resolves.toMatchObject({ ok: true });
    const conflicting = [
      {
        ...requiredMember(members, 0),
        expectedSceneRevision: createSceneRevision(2),
      },
      requiredMember(members, 1),
    ];
    await expect(
      store.preparePrefixRelocationPlan({
        expectedPrefixRecord: record,
        members: conflicting,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    const processing = { ...record, cursor: 1, step: "processing" as const };
    await store.advanceRelocation({
      expected: record,
      replacement: processing,
    });
    await expect(store.preparePrefixRelocationPlan(request)).resolves.toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
    await store.dispose();
  });

  it("rejects quota overflow atomically without leaving a partial plan", async () => {
    const { store } = await openStore("prefix-plan-quota", {
      limits: { globalRecords: 2 },
    });
    const record = planRecord();
    await store.beginRelocation(record);
    await expect(
      store.preparePrefixRelocationPlan({
        expectedPrefixRecord: record,
        members: planMembers(),
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await expect(
      store.loadPrefixRelocationMember({
        ordinal: 0,
        relocationId: record.relocationId,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });

  it("fails closed for non-canonical prefix derivation and sidecar collisions", async () => {
    const { store } = await openStore("prefix-plan-validation");
    const record = planRecord();
    await store.beginRelocation(record);
    const members = planMembers();
    await expect(
      store.preparePrefixRelocationPlan({
        expectedPrefixRecord: record,
        members: [
          requiredMember(members, 0),
          {
            ...requiredMember(members, 1),
            destinationSidecarPath: requiredMember(members, 0)
              .destinationSidecarPath,
          },
        ],
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.preparePrefixRelocationPlan({
        expectedPrefixRecord: record,
        members: [
          requiredMember(members, 0),
          {
            ...requiredMember(members, 1),
            replacementNoteIdentity: {
              ...requiredMember(members, 1).replacementNoteIdentity,
              vaultRelativeMarkdownPath: "wrong/b.md",
            },
          },
        ],
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });

  it("rejects accessor-backed plan inputs without invoking them", async () => {
    const { store } = await openStore("prefix-plan-accessors");
    const record = planRecord();
    await store.beginRelocation(record);
    let invoked = false;
    const member = Object.defineProperty({}, "ordinal", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 0;
      },
    }) as PrefixRelocationMemberV1;
    await expect(
      store.preparePrefixRelocationPlan({
        expectedPrefixRecord: record,
        members: [member, requiredMember(planMembers(), 1)],
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    const request = Object.defineProperty({}, "members", {
      enumerable: true,
      get: () => {
        invoked = true;
        return planMembers();
      },
    }) as Parameters<typeof store.preparePrefixRelocationPlan>[0];
    await expect(store.preparePrefixRelocationPlan(request)).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    expect(invoked).toBe(false);
    await store.dispose();
  });

  it("bounds the indexed active-prefix restart query", async () => {
    const { store } = await openStore("prefix-plan-active-limit");
    const first = planRecord();
    const second = {
      ...prefixRelocation(),
      generation: 2,
      relocationId: parseRelocationId(`rel_${idPayload(3)}`),
    };
    await store.beginRelocation(first);
    await store.beginRelocation(second);
    await expect(
      store.loadActivePrefixRelocations({ limit: 1 }),
    ).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await expect(
      store.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toMatchObject({
      ok: true,
      value: [{ generation: 1 }, { generation: 2 }],
    });
    await store.dispose();
  });
});

function planRecord(): PrefixRelocationRecordV1 {
  return { ...prefixRelocation(), admittedRecordCount: 2 };
}

function planMembers(): readonly PrefixRelocationMemberV1[] {
  return Object.freeze([member(0, "a"), member(1, "b")]);
}

function member(ordinal: number, name: string): PrefixRelocationMemberV1 {
  const prior = note(`notes/${name}.md`);
  const replacement = note(`archive/${name}.md`);
  return Object.freeze({
    destinationSidecarPath: `archive/${name}.inkbook.json`,
    expectedSceneRevision: createSceneRevision(1),
    ordinal,
    priorNoteIdentity: prior,
    replacementNoteIdentity: replacement,
    sidecarBase: Object.freeze({
      markdownPath: prior.vaultRelativeMarkdownPath,
      rawTextSha256: parseSha256Digest("a".repeat(64)),
      revision: createSidecarRevision(1),
      vaultRelativePath: `notes/${name}.inkbook.json`,
    }),
    sourceSidecarPath: `notes/${name}.inkbook.json`,
  });
}

function note(path: string): NoteIdentityV1 {
  return Object.freeze({
    vaultIdHint: "vault-fixture",
    vaultRelativeMarkdownPath: path,
  });
}

function planSummary(record: PrefixRelocationRecordV1): Readonly<{
  admittedRecordCount: number;
  expectedSettingsRevision: PrefixRelocationRecordV1["expectedSettingsRevision"];
  generation: number;
  relocationId: PrefixRelocationRecordV1["relocationId"];
}> {
  return {
    admittedRecordCount: record.admittedRecordCount,
    expectedSettingsRevision: createSettingsRevision(1),
    generation: record.generation,
    relocationId: record.relocationId,
  };
}

async function digestRecord(
  record: PrefixRelocationRecordV1,
): Promise<ReturnType<typeof parseSha256Digest>> {
  const encoded = encodeRecoveryRecordV1(record);
  if (!encoded.ok) throw new Error("Expected valid terminal record.");
  return parseSha256Digest(await sha256Bytes(encoded.value));
}

function requiredMember(
  members: readonly PrefixRelocationMemberV1[],
  index: number,
): PrefixRelocationMemberV1 {
  const member = members[index];
  if (member === undefined) throw new Error("Expected fixture plan member.");
  return member;
}
