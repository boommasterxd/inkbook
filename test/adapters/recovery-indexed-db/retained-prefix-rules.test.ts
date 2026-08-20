/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact retained-rule limits and generations are under test. */
import { describe, expect, it } from "vitest";

import {
  createSettingsRevision,
  parseRelocationId,
  parseSha256Digest,
} from "../../../src/application/note-session";
import {
  encodeRecoveryRecordV1,
  type PrefixRelocationRecordV1,
  type RecoveryStore,
} from "../../../src/application/recovery";
import { resolveRelocatedPath } from "../../../src/application/persistence";
import { sha256Bytes } from "../../../src/domain/codecs/sha256";
import { admitPrefixRelocationBatch } from "../../../src/adapters/recovery-indexed-db/retained-prefix-rules";
import {
  corruptStoredRecord,
  existingLoad,
  fileRelocation,
  idPayload,
  openStore,
  replaceStoredEncoded,
} from "./support";

describe("IndexedDB retained prefix relocation rules", () => {
  it("retains completed rules across restart while excluding them from active and note loads", async () => {
    const name = "retained-prefix-restart";
    const { store, factory } = await openStore(name);
    const rule = await completeRule(store, prefixRule(1));
    await store.dispose();

    const { store: reopened } = await openStore(name, {}, factory);
    const loaded = await reopened.loadRetainedPrefixRelocationRules({
      limit: 128,
    });
    expect(loaded).toEqual({ ok: true, value: [rule] });
    if (!loaded.ok) throw new Error("Expected a retained prefix rule.");
    expect(Object.isFrozen(loaded.value)).toBe(true);
    expect(Object.isFrozen(loaded.value[0])).toBe(true);
    await expect(
      reopened.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(reopened.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { relocations: [] },
    });
    await reopened.dispose();
  });

  it("removes only an exact completed rule through the maintenance CAS and preserves generation high-water", async () => {
    const { store } = await openStore("retained-prefix-maintenance");
    const first = await completeRule(store, prefixRule(1));
    const second = await completeRule(store, prefixRule(2));
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "expectedRule", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return first;
      },
    });
    await expect(
      store.removeRetainedPrefixRelocationRuleForMaintenance(
        accessor as { expectedRule: PrefixRelocationRecordV1 },
      ),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    expect(getterCalls).toBe(0);
    await expect(
      store.removeRetainedPrefixRelocationRuleForMaintenance({
        expectedRule: { ...first, replacementPrefix: "different" },
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.removeRetainedPrefixRelocationRuleForMaintenance({
        expectedRule: first,
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.removeRetainedPrefixRelocationRuleForMaintenance({
        expectedRule: first,
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.loadRetainedPrefixRelocationRules({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [second] });
    await expect(store.beginRelocation(prefixRule(2, 90))).resolves.toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
    await expect(store.beginRelocation(prefixRule(3, 91))).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await store.dispose();
  });

  it("fails closed for corrupt retained records and descriptor-backed requests", async () => {
    const name = "retained-prefix-corrupt";
    const { store, factory } = await openStore(name);
    const rule = await completeRule(store, prefixRule(1));
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "limit", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 128;
      },
    });
    await expect(
      store.loadRetainedPrefixRelocationRules(accessor as { limit: number }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    expect(getterCalls).toBe(0);
    await store.dispose();
    await corruptStoredRecord(factory, name, `relocation:${rule.relocationId}`);
    const { store: reopened } = await openStore(name, {}, factory);
    await expect(
      reopened.loadRetainedPrefixRelocationRules({ limit: 128 }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await reopened.dispose();
  });
});

describe("IndexedDB retained prefix relocation limits", () => {
  it("retains primary accounting while atomically releasing plan-member quota", async () => {
    const { store } = await openStore("retained-prefix-quota", {
      limits: { globalRecords: 1 },
    });
    const first = await completeRule(store, prefixRule(1));
    await expect(store.beginRelocation(prefixRule(2))).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await store.removeRetainedPrefixRelocationRuleForMaintenance({
      expectedRule: first,
    });
    await expect(store.beginRelocation(prefixRule(2))).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await store.dispose();
  });

  it("returns rules in increasing generation order and rejects the 129th retained rule", async () => {
    const { store } = await openStore("retained-prefix-limit");
    for (let generation = 1; generation <= 128; generation += 1) {
      await completeRule(store, prefixRule(generation, 129 - generation));
    }
    await expect(
      store.loadRetainedPrefixRelocationRules({ limit: 127 }),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    const loaded = await store.loadRetainedPrefixRelocationRules({
      limit: 128,
    });
    expect(loaded.ok && loaded.value.map((rule) => rule.generation)).toEqual(
      Array.from({ length: 128 }, (_, index) => index + 1),
    );
    await expect(store.beginRelocation(prefixRule(129))).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await store.dispose();
  });
});

describe("IndexedDB atomic prefix relocation batches", () => {
  it("commits equal-generation rules once and preserves longest-prefix precedence after restart", async () => {
    const name = "retained-prefix-batch-restart";
    const { store, factory } = await openStore(name);
    const parent = prefixRule(1, 1, {
      priorPrefix: "notes",
      replacementPrefix: "archive",
    });
    const child = prefixRule(1, 2, {
      priorPrefix: "notes/team",
      replacementPrefix: "teams",
    });
    const request = { records: [parent, child] };
    await expect(store.beginPrefixRelocationBatch(request)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      store.beginPrefixRelocationBatch({ records: [child, parent] }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.beginRelocation(prefixRule(1, 3))).resolves.toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
    const terminalParent = await completeStartedRule(store, parent);
    const terminalChild = await completeStartedRule(store, child);
    await store.dispose();

    const { store: reopened } = await openStore(name, {}, factory);
    const loaded = await reopened.loadRetainedPrefixRelocationRules({
      limit: 128,
    });
    expect(loaded).toEqual({
      ok: true,
      value: [terminalChild, terminalParent],
    });
    if (!loaded.ok) throw new Error("Expected retained batch rules.");
    expect(
      resolveRelocatedPath("notes/team/a.md", "teams/a.md", loaded.value),
    ).toMatchObject({
      ok: true,
      value: { relocationIds: [child.relocationId] },
    });
    await reopened.dispose();
  });

  it("rejects partial batch retries and keeps retained completion idempotent", async () => {
    const { store } = await openStore("retained-prefix-partial-retry");
    const first = prefixRule(1, 1);
    const second = prefixRule(1, 2, { priorPrefix: "other" });
    await expect(store.beginRelocation(first)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      store.beginPrefixRelocationBatch({ records: [first, second] }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [first] });

    const terminal = await completeStartedRule(store, first);
    const encoded = encodeRecoveryRecordV1(terminal);
    if (!encoded.ok) throw new Error("Expected an encodable terminal rule.");
    await expect(
      store.completeSaga({
        expectedTerminalRecordSha256: parseSha256Digest(
          await sha256Bytes(encoded.value),
        ),
        id: terminal.relocationId,
        kind: "relocation",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.loadRetainedPrefixRelocationRules({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [terminal] });
    await store.dispose();
  });
});

describe("IndexedDB active prefix relocation validation", () => {
  it("fails active restart closed for an ambiguous equal-generation record set", async () => {
    const name = "retained-prefix-active-ambiguous";
    const { store, factory } = await openStore(name);
    const first = prefixRule(1, 1, {
      priorPrefix: "alpha",
      replacementPrefix: "first",
    });
    const second = prefixRule(1, 2, {
      priorPrefix: "bravo",
      replacementPrefix: "other",
    });
    await expect(
      store.beginPrefixRelocationBatch({ records: [first, second] }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();

    const ambiguous = encodeRecoveryRecordV1({
      ...second,
      priorPrefix: first.priorPrefix,
    });
    if (!ambiguous.ok) throw new Error("Expected an encodable corrupt rule.");
    await replaceStoredEncoded(
      factory,
      name,
      `relocation:${second.relocationId}`,
      ambiguous.value,
    );
    const { store: reopened } = await openStore(name, {}, factory);
    await expect(
      reopened.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await reopened.dispose();
  });
});

describe("IndexedDB atomic prefix relocation batch validation", () => {
  it("rejects accessor-backed, self-mapping, and ambiguous batches before mutation", async () => {
    const { store } = await openStore("retained-prefix-batch-invalid");
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "records", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return [prefixRule(1)];
      },
    });
    await expect(
      store.beginPrefixRelocationBatch(accessor as { records: never[] }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    expect(getterCalls).toBe(0);
    await expect(
      store.beginPrefixRelocationBatch({
        records: [
          prefixRule(1, 1, { priorPrefix: "notes", replacementPrefix: "a" }),
          prefixRule(1, 2, { priorPrefix: "notes", replacementPrefix: "b" }),
        ],
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.beginPrefixRelocationBatch({
        records: [
          prefixRule(1, 3, {
            priorPrefix: "notes",
            replacementPrefix: "notes",
          }),
        ],
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await expect(
      store.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [] });
    await store.dispose();
  });
});

describe("IndexedDB atomic prefix relocation batch failures", () => {
  it("aborts the complete batch on quota or transaction failure", async () => {
    const records = [
      prefixRule(1, 1),
      prefixRule(1, 2, { priorPrefix: "notes-other" }),
    ];
    const { store: quota } = await openStore("retained-prefix-batch-quota", {
      limits: { globalRecords: 1 },
    });
    await expect(
      quota.beginPrefixRelocationBatch({ records }),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await expect(
      quota.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [] });
    await quota.dispose();

    const { store: aborted } = await openStore("retained-prefix-batch-abort", {
      faultInjector: {
        beforeCommit: (operation, transaction) => {
          if (operation === "begin-prefix-relocation-batch")
            transaction.abort();
        },
      },
    });
    await expect(
      aborted.beginPrefixRelocationBatch({ records }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await expect(
      aborted.loadActivePrefixRelocations({ limit: 128 }),
    ).resolves.toEqual({ ok: true, value: [] });
    await aborted.dispose();
  });
});

describe("prefix relocation batch admission", () => {
  it("rejects malformed, empty, sparse, and oversized record collections", () => {
    const invalidRequests: unknown[] = [
      null,
      {},
      { records: null },
      { records: [] },
      { records: Array(2) },
      Object.defineProperty({}, "records", {
        enumerable: true,
        get: () => [prefixRule(1)],
      }),
    ];
    for (const request of invalidRequests) {
      expect(
        admitPrefixRelocationBatch(
          request as { records: readonly PrefixRelocationRecordV1[] },
        ),
      ).toEqual({ ok: false, code: "invalid-command" });
    }
    expect(
      admitPrefixRelocationBatch({
        records: Array.from({ length: 129 }, (_, index) =>
          prefixRule(1, index + 1),
        ),
      }),
    ).toEqual({ ok: false, code: "recovery-limit" });
  });

  it("rejects invalid records and inconsistent batch identities", () => {
    const prepared = prefixRule(1);
    for (const records of [
      [null],
      [fileRelocation()],
      [{ ...prepared, step: "complete" }],
    ]) {
      expect(
        admitPrefixRelocationBatch({
          records: records as readonly PrefixRelocationRecordV1[],
        }),
      ).toEqual({ ok: false, code: "invalid-command" });
    }
    for (const records of [
      [prepared, prefixRule(2, 2)],
      [
        prepared,
        prefixRule(1, 2, {
          expectedSettingsRevision: createSettingsRevision(2),
        }),
      ],
      [prepared, { ...prefixRule(1, 2), relocationId: prepared.relocationId }],
    ]) {
      expect(admitPrefixRelocationBatch({ records })).toEqual({
        ok: false,
        code: "sidecar-conflict",
      });
    }
  });

  it("rejects invalid retained-load limits without opening a transaction", async () => {
    const { store } = await openStore("retained-prefix-invalid-limits");
    for (const limit of [0, 129, Number.NaN, 1.5]) {
      await expect(
        store.loadRetainedPrefixRelocationRules({ limit }),
      ).resolves.toEqual({ ok: false, code: "invalid-command" });
    }
    await store.dispose();
  });
});

function prefixRule(
  generation: number,
  identity = generation,
  overrides: Partial<PrefixRelocationRecordV1> = {},
): PrefixRelocationRecordV1 {
  return {
    admittedRecordCount: 0,
    cursor: 0,
    expectedSettingsRevision: createSettingsRevision(1),
    generation,
    kind: "folder-prefix",
    priorPrefix: `notes-${String(generation)}`,
    relocationId: parseRelocationId(`rel_${idPayload(identity)}`),
    replacementPrefix: `archive-${String(generation)}`,
    step: "prepared",
    ...overrides,
  };
}

async function completeRule(
  store: RecoveryStore,
  prepared: PrefixRelocationRecordV1,
): Promise<PrefixRelocationRecordV1> {
  expect(await store.beginRelocation(prepared)).toEqual({
    ok: true,
    value: undefined,
  });
  return completeStartedRule(store, prepared);
}

async function completeStartedRule(
  store: RecoveryStore,
  prepared: PrefixRelocationRecordV1,
): Promise<PrefixRelocationRecordV1> {
  const terminal = { ...prepared, step: "complete" as const };
  expect(
    await store.advanceRelocation({
      expected: prepared,
      replacement: terminal,
    }),
  ).toEqual({ ok: true, value: undefined });
  const encoded = encodeRecoveryRecordV1(terminal);
  if (!encoded.ok) throw new Error("Expected an encodable terminal rule.");
  const completed = await store.completeSaga({
    expectedTerminalRecordSha256: parseSha256Digest(
      await sha256Bytes(encoded.value),
    ),
    id: terminal.relocationId,
    kind: "relocation",
  });
  expect(completed).toEqual({ ok: true, value: undefined });
  return terminal;
}
