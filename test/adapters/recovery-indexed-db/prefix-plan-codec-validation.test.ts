/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact malformed ordinals and byte limits are boundary evidence. */
import { describe, expect, it } from "vitest";

import {
  createSidecarRevision,
  createSettingsRevision,
  parseRelocationId,
  parseSha256Digest,
  type NoteIdentityV1,
  type RelocationId,
} from "../../../src/application/note-session";
import {
  RECOVERY_STORE_LIMITS_V1,
  type PrefixRelocationMemberV1,
  type PrefixRelocationRecordV1,
  type SidecarBaseIdentityV1,
} from "../../../src/application/recovery";
import { encodeCanonicalJson } from "../../../src/domain/codecs/canonical-json";
import { createSceneRevision } from "../../../src/domain/model";
import { admitPrefixRelocationPlan } from "../../../src/adapters/recovery-indexed-db/prefix-plan";
import {
  admitPrefixMember,
  decodePrefixMember,
  exactStoredPrefixPlan,
  parseStoredPrefixMember,
  storedPrefixMemberMatches,
  validCanonicalPrefixPlan,
  validStoredPrefixOrdinals,
} from "../../../src/adapters/recovery-indexed-db/prefix-plan-codec";
import type { StoredPrefixRelocationMember } from "../../../src/adapters/recovery-indexed-db/schema";
import { fileRelocation, idPayload, openStore } from "./support";

const UTF8 = new TextEncoder();

describe("prefix plan member codec validation", () => {
  it("rejects oversized, malformed, non-canonical, and structurally inconsistent members", () => {
    expect(
      decodePrefixMember(
        new Uint8Array(RECOVERY_STORE_LIMITS_V1.maxNoteBytes + 1),
      ),
    ).toEqual({ ok: false, code: "recovery-limit" });
    expect(decodePrefixMember(UTF8.encode("{"))).toEqual({
      ok: false,
      code: "invalid-command",
    });
    const valid = member(0, "a");
    const canonical = encodeCanonicalJson(valid);
    expect(
      decodePrefixMember(
        UTF8.encode(` ${new TextDecoder().decode(canonical)}`),
      ),
    ).toEqual({ ok: false, code: "invalid-command" });
    for (const candidate of [
      { ...valid, unexpected: true },
      {
        ...valid,
        priorNoteIdentity: {
          vaultIdHint: "",
          vaultRelativeMarkdownPath: "notes/a.md",
        },
      },
      { ...valid, expectedSceneRevision: 0 },
      {
        ...valid,
        destinationSidecarPath: "notes/a.inkbook.json",
        expectedSceneRevision: 0,
        sidecarBase: base("notes/a.md", "notes/a.inkbook.json"),
        sourceSidecarPath: "notes/a.inkbook.json",
      },
    ]) {
      expect(decodePrefixMember(encodeCanonicalJson(candidate))).toEqual({
        ok: false,
        code: "invalid-command",
      });
    }
    expect(
      admitPrefixMember(
        Object.defineProperty({}, "ordinal", {
          enumerable: true,
          get: () => 0,
        }) as PrefixRelocationMemberV1,
      ),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("accepts sidecar-free and complete sidecar members as immutable canonical values", () => {
    const sidecarFree = member(0, "a");
    const decodedFree = decodePrefixMember(encodeCanonicalJson(sidecarFree));
    expect(decodedFree).toEqual({ ok: true, value: sidecarFree });
    const withSidecar = memberWithSidecar(0, "a");
    const admitted = admitPrefixMember(withSidecar);
    expect(admitted).toMatchObject({
      ok: true,
      value: { member: withSidecar },
    });
    if (!admitted.ok) throw new Error("Expected admitted member.");
    expect(Object.isFrozen(admitted.value.member)).toBe(true);
    expect(Object.isFrozen(admitted.value.member.sidecarBase)).toBe(true);
  });
});

describe("prefix plan stored metadata validation", () => {
  it("rejects every malformed stored metadata family and unequal exact plans", () => {
    const valid = stored(member(0, "a"));
    for (const candidate of [
      null,
      { ...valid, extra: true },
      { ...valid, encoded: [] },
      { ...valid, key: 1 },
      { ...valid, relocationId: 1 },
      { ...valid, ordinal: -1 },
      { ...valid, noteKey: 1 },
      { ...valid, byteSize: valid.byteSize + 1 },
      { ...valid, sha256: 1 },
    ]) {
      expect(parseStoredPrefixMember(candidate)).toBeNull();
    }
    expect(exactStoredPrefixPlan([], [valid])).toBe(false);
    expect(exactStoredPrefixPlan([{ ...valid, sha256: "b" }], [valid])).toBe(
      false,
    );
    expect(exactStoredPrefixPlan([valid], [valid])).toBe(true);
  });

  it("checks stored ordinals and member identity metadata independently", () => {
    const record = prefixRecord(2);
    const first = stored(member(0, "a"));
    const second = stored(member(1, "b"));
    expect(validStoredPrefixOrdinals([first, second], record)).toBe(true);
    expect(
      validStoredPrefixOrdinals(
        [{ ...first, relocationId: relocationId(9) }],
        record,
      ),
    ).toBe(false);
    expect(validStoredPrefixOrdinals([{ ...first, ordinal: 2 }], record)).toBe(
      false,
    );
    expect(validStoredPrefixOrdinals([first, first], record)).toBe(false);
    const decoded = member(0, "a");
    expect(storedPrefixMemberMatches(first, record.relocationId, decoded)).toBe(
      true,
    );
    for (const candidate of [
      { ...first, key: "different" },
      { ...first, relocationId: relocationId(9) },
      { ...first, ordinal: 1 },
      { ...first, noteKey: "other.md" },
      { ...first, byteSize: first.byteSize + 1 },
    ]) {
      expect(
        storedPrefixMemberMatches(candidate, record.relocationId, decoded),
      ).toBe(false);
    }
  });
});

describe("canonical prefix plan derivation", () => {
  it("rejects ordinal, ordering, identity, prefix, and sidecar collisions", () => {
    const record = prefixRecord(2);
    const first = memberWithSidecar(0, "a");
    const second = memberWithSidecar(1, "b");
    expect(validCanonicalPrefixPlan([first, second], record)).toBe(true);
    for (const members of [
      [{ ...first, ordinal: 1 }, second],
      [second, first],
      [first, { ...second, priorNoteIdentity: first.priorNoteIdentity }],
      [
        first,
        { ...second, replacementNoteIdentity: first.replacementNoteIdentity },
      ],
      [first, { ...second, replacementNoteIdentity: note("wrong/b.md") }],
      [first, { ...second, sourceSidecarPath: first.sourceSidecarPath }],
      [
        first,
        { ...second, destinationSidecarPath: first.destinationSidecarPath },
      ],
    ]) {
      expect(validCanonicalPrefixPlan(members, record)).toBe(false);
    }
  });

  it("validates storage-root note stability and exact sidecar prefix replacement", () => {
    const record = prefixRecord(1, {
      kind: "storage-root",
      priorPrefix: "old-root",
      replacementPrefix: "new-root",
    });
    const sameNote = memberWithSidecar(0, "a", {
      destinationSidecarPath: "new-root/a.inkbook.json",
      priorNoteIdentity: note("notes/a.md"),
      replacementNoteIdentity: note("notes/a.md"),
      sidecarBase: base("notes/a.md", "old-root/a.inkbook.json"),
      sourceSidecarPath: "old-root/a.inkbook.json",
    });
    expect(validCanonicalPrefixPlan([sameNote], record)).toBe(true);
    expect(
      validCanonicalPrefixPlan(
        [{ ...sameNote, replacementNoteIdentity: note("notes/b.md") }],
        record,
      ),
    ).toBe(false);
    expect(
      validCanonicalPrefixPlan(
        [{ ...sameNote, destinationSidecarPath: "other/a.inkbook.json" }],
        record,
      ),
    ).toBe(false);
    expect(
      validCanonicalPrefixPlan(
        [
          {
            ...member(0, "a"),
            priorNoteIdentity: note("notes/a.md"),
            replacementNoteIdentity: note("notes/a.md"),
          },
        ],
        record,
      ),
    ).toBe(true);
  });
});

describe("canonical prefix plan edge cases", () => {
  it("rejects cross-vault identity and covers canonical tie ordering", () => {
    const record = prefixRecord(2);
    const free = member(0, "a");
    const withSidecar = memberWithSidecar(1, "a");
    expect(
      validCanonicalPrefixPlan(
        [
          {
            ...free,
            replacementNoteIdentity: {
              ...free.replacementNoteIdentity,
              vaultIdHint: "other-vault",
            },
          },
        ],
        prefixRecord(1),
      ),
    ).toBe(false);
    expect(validCanonicalPrefixPlan([free, withSidecar], record)).toBe(false);
    expect(
      validCanonicalPrefixPlan(
        [
          { ...withSidecar, ordinal: 0 },
          { ...free, ordinal: 1 },
        ],
        record,
      ),
    ).toBe(false);
    expect(
      validCanonicalPrefixPlan([member(0, "a"), member(1, "aa")], record),
    ).toBe(true);
  });

  it("accepts exact prefix segment replacement and rejects negative ordinals", () => {
    const record = prefixRecord(1);
    expect(
      validCanonicalPrefixPlan(
        [
          member(0, "root", {
            priorNoteIdentity: note("notes"),
            replacementNoteIdentity: note("archive"),
          }),
        ],
        record,
      ),
    ).toBe(true);
    expect(
      decodePrefixMember(
        encodeCanonicalJson({ ...member(0, "a"), ordinal: -1 }),
      ),
    ).toEqual({ ok: false, code: "invalid-command" });
  });
});

describe("prefix relocation plan admission", () => {
  it("rejects malformed descriptors and bounded member arrays", () => {
    const expectedPrefixRecord = prefixRecord(0);
    const invalidRequests: unknown[] = [
      null,
      [],
      {},
      { expectedPrefixRecord, members: null },
      { expectedPrefixRecord, members: Array(2) },
      { expectedPrefixRecord, members: Object.assign([], { extra: true }) },
      Object.defineProperty({ members: [] }, "expectedPrefixRecord", {
        enumerable: true,
        get: () => expectedPrefixRecord,
      }),
    ];
    for (const request of invalidRequests) {
      expect(
        admitPrefixRelocationPlan(
          request as {
            expectedPrefixRecord: PrefixRelocationRecordV1;
            members: readonly PrefixRelocationMemberV1[];
          },
        ),
      ).toEqual({ ok: false, code: "invalid-command" });
    }
    expect(
      admitPrefixRelocationPlan({
        expectedPrefixRecord,
        members: Array.from({ length: 4097 }, () => member(0, "a")),
      }),
    ).toEqual({ ok: false, code: "recovery-limit" });
  });

  it("rejects invalid records, count conflicts, and invalid members", () => {
    expect(
      admitPrefixRelocationPlan({
        expectedPrefixRecord:
          fileRelocation() as unknown as PrefixRelocationRecordV1,
        members: [],
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
    expect(
      admitPrefixRelocationPlan({
        expectedPrefixRecord: prefixRecord(1),
        members: [],
      }),
    ).toEqual({ ok: false, code: "sidecar-conflict" });
    expect(
      admitPrefixRelocationPlan({
        expectedPrefixRecord: prefixRecord(1),
        members: [
          Object.defineProperty({}, "ordinal", {
            enumerable: true,
            get: () => 0,
          }) as PrefixRelocationMemberV1,
        ],
      }),
    ).toEqual({ ok: false, code: "invalid-command" });
  });

  it("rejects invalid member lookup bounds", async () => {
    const { store } = await openStore("prefix-plan-invalid-member-load");
    for (const request of [
      { relocationId: "invalid", ordinal: 0 },
      { relocationId: relocationId(1), ordinal: -1 },
      { relocationId: relocationId(1), ordinal: 4096 },
      { relocationId: relocationId(1), ordinal: 1.5 },
    ]) {
      await expect(
        store.loadPrefixRelocationMember(
          request as Parameters<typeof store.loadPrefixRelocationMember>[0],
        ),
      ).resolves.toEqual({ ok: false, code: "invalid-command" });
    }
    await store.dispose();
  });
});

function member(
  ordinal: number,
  name: string,
  overrides: Partial<PrefixRelocationMemberV1> = {},
): PrefixRelocationMemberV1 {
  return {
    destinationSidecarPath: null,
    expectedSceneRevision: null,
    ordinal,
    priorNoteIdentity: note(`notes/${name}.md`),
    replacementNoteIdentity: note(`archive/${name}.md`),
    sidecarBase: null,
    sourceSidecarPath: null,
    ...overrides,
  };
}

function memberWithSidecar(
  ordinal: number,
  name: string,
  overrides: Partial<PrefixRelocationMemberV1> = {},
): PrefixRelocationMemberV1 {
  return member(ordinal, name, {
    destinationSidecarPath: `archive/${name}.inkbook.json`,
    expectedSceneRevision: createSceneRevision(1),
    sidecarBase: base(`notes/${name}.md`, `notes/${name}.inkbook.json`),
    sourceSidecarPath: `notes/${name}.inkbook.json`,
    ...overrides,
  });
}

function note(path: string): NoteIdentityV1 {
  return { vaultIdHint: "vault", vaultRelativeMarkdownPath: path };
}

function base(
  markdownPath: string,
  vaultRelativePath: string,
): SidecarBaseIdentityV1 {
  return {
    markdownPath,
    rawTextSha256: parseSha256Digest("a".repeat(64)),
    revision: createSidecarRevision(1),
    vaultRelativePath,
  };
}

function prefixRecord(
  admittedRecordCount: number,
  overrides: Partial<PrefixRelocationRecordV1> = {},
): PrefixRelocationRecordV1 {
  return {
    admittedRecordCount,
    cursor: 0,
    expectedSettingsRevision: createSettingsRevision(1),
    generation: 1,
    kind: "folder-prefix",
    priorPrefix: "notes",
    relocationId: relocationId(1),
    replacementPrefix: "archive",
    step: "prepared",
    ...overrides,
  };
}

function stored(
  memberValue: PrefixRelocationMemberV1,
): StoredPrefixRelocationMember {
  const encoded = encodeCanonicalJson(memberValue);
  return {
    byteSize: encoded.byteLength,
    encoded,
    key: `${relocationId(1)}:${String(memberValue.ordinal)}`,
    noteKey: memberValue.priorNoteIdentity.vaultRelativeMarkdownPath,
    ordinal: memberValue.ordinal,
    relocationId: relocationId(1),
    sha256: "a".repeat(64),
  };
}

function relocationId(value: number): RelocationId {
  return parseRelocationId(`rel_${idPayload(value)}`);
}
