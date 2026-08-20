import {
  commandFailure,
  commandSuccess,
  parseRelocationId,
  type CommandResultV1,
} from "../../application/note-session";
import {
  validateRelocationRecord,
  type LoadPrefixRelocationMemberV1,
  type LoadActivePrefixRelocationsV1,
  type PrefixRelocationMemberV1,
  type PrefixRelocationPlanV1,
  type PrefixRelocationRecordV1,
  type PreparePrefixRelocationPlanV1,
} from "../../application/recovery";
import { sha256Bytes } from "../../domain/codecs/sha256";
import {
  applyAccountingDelta,
  readAccounting,
  readNoteAccounting,
  writeAccounting,
} from "./accounting";
import { requestResult, transactionDone } from "./idb-promises";
import {
  admitPrefixMember,
  decodePrefixMember,
  exactStoredPrefixPlan,
  parseStoredPrefixMember,
  prefixMemberKey,
  storedPrefixMemberMatches,
  validCanonicalPrefixPlan,
  validStoredPrefixOrdinals,
} from "./prefix-plan-codec";
import { admitQueueRequest, admitRecoveryRecord } from "./queue-admission";
import { exceedsLimits } from "./record-admission";
import {
  createStoredRecord,
  decodeStoredRecord,
  decodeStoredRecordInTransaction,
  storedPayloadEqual,
} from "./record-storage";
import {
  PREFIX_PLAN_STORE,
  ACTIVE_PREFIX_INDEX,
  ACTIVE_PREFIX_VALUE,
  RECORDS_STORE,
  RELOCATION_ID_INDEX,
  type StoredPrefixRelocationMember,
  type StoredRecoveryRecord,
} from "./schema";
import { runMutation } from "./transactions";
import {
  comparePrefixRelocationRules,
  validPrefixRelocationRuleSet,
} from "./retained-prefix-rules";
import type { WriteContext } from "./write-operations";

const MAX_MEMBERS = 4096;
const MAX_ACTIVE_PREFIX_RELOCATIONS = 128;
const PLAN_REQUEST_PROPERTY_COUNT = 2;
const ACCOUNT_INCREMENT = 1;
const ACCOUNT_DECREMENT = -1;

interface AdmittedPrefixPlan {
  readonly expectedPrefixRecord: PrefixRelocationRecordV1;
  readonly expectedPrefixBytes: Uint8Array;
  readonly members: readonly Readonly<{
    member: PrefixRelocationMemberV1;
    encoded: Uint8Array;
  }>[];
  readonly retainedBytes: number;
}

export function admitPrefixRelocationPlan(
  request: PreparePrefixRelocationPlanV1,
): CommandResultV1<AdmittedPrefixPlan> {
  const input = readPlanRequest(request);
  if (!input.ok) return input;
  const admittedExpected = admitRecoveryRecord(
    input.value.expectedPrefixRecord,
  );
  if (!admittedExpected.ok) return admittedExpected;
  const expected = validateRelocationRecord(admittedExpected.value.record);
  if (!expected.ok || !isPrefixRecord(expected.value)) return invalid();
  if (input.value.members.length !== expected.value.admittedRecordCount) {
    return conflict();
  }
  const members: Readonly<{
    member: PrefixRelocationMemberV1;
    encoded: Uint8Array;
  }>[] = [];
  for (const value of input.value.members) {
    const queued = admitQueueRequest(value);
    if (!queued.ok) return queued;
    const admitted = admitPrefixMember(
      queued.value.value as PrefixRelocationMemberV1,
    );
    if (!admitted.ok) return admitted;
    members.push(admitted.value);
  }
  if (
    !validCanonicalPrefixPlan(
      members.map(({ member }) => member),
      expected.value,
    )
  ) {
    return conflict();
  }
  const expectedBytes = admittedExpected.value.bytes;
  const retainedBytes = members.reduce(
    (total, member) => total + member.encoded.byteLength,
    expectedBytes.byteLength,
  );
  return commandSuccess(
    Object.freeze({
      expectedPrefixBytes: expectedBytes,
      expectedPrefixRecord: expected.value,
      members: Object.freeze(members),
      retainedBytes,
    }),
  );
}

function readPlanRequest(value: unknown): CommandResultV1<
  Readonly<{
    expectedPrefixRecord: PrefixRelocationRecordV1;
    members: readonly unknown[];
  }>
> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalid();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== PLAN_REQUEST_PROPERTY_COUNT ||
      !keys.includes("expectedPrefixRecord") ||
      !keys.includes("members")
    ) {
      return invalid();
    }
    const expected = dataProperty(value, "expectedPrefixRecord");
    const members = dataProperty(value, "members");
    const materializedMembers = readMemberArray(members);
    if (!materializedMembers.ok) return materializedMembers;
    return commandSuccess(
      Object.freeze({
        expectedPrefixRecord: expected as PrefixRelocationRecordV1,
        members: materializedMembers.value,
      }),
    );
  } catch {
    return invalid();
  }
}

function readMemberArray(value: unknown): CommandResultV1<readonly unknown[]> {
  if (!Array.isArray(value)) return invalid();
  const lengthValue = dataProperty(value, "length", false);
  if (
    typeof lengthValue !== "number" ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0
  ) {
    return invalid();
  }
  if (lengthValue > MAX_MEMBERS) return limited();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== lengthValue + 1) return invalid();
  const members: unknown[] = [];
  for (let index = 0; index < lengthValue; index += 1) {
    members.push(dataProperty(value, String(index)));
  }
  return commandSuccess(Object.freeze(members));
}

function dataProperty(
  value: object,
  key: PropertyKey,
  enumerable = true,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== enumerable
  ) {
    throw new TypeError("Expected a plain enumerable data property.");
  }
  return descriptor.value;
}

export async function preparePrefixRelocationPlan(
  context: WriteContext,
  admitted: AdmittedPrefixPlan,
): Promise<CommandResultV1<PrefixRelocationPlanV1>> {
  const expected = await createStoredRecord(
    admitted.expectedPrefixRecord,
    admitted.expectedPrefixBytes,
  );
  if (!expected.ok) return expected;
  const members = await Promise.all(
    admitted.members.map(({ member, encoded }) =>
      createStoredMember(
        admitted.expectedPrefixRecord.relocationId,
        member,
        encoded,
      ),
    ),
  );
  return runMutation(context, "prepare-prefix-relocation-plan", async (tx) => {
    if (!(await exactCurrentPrefix(tx, expected.value))) return conflict();
    const store = tx.objectStore(PREFIX_PLAN_STORE);
    const existing = await requestResult(
      store
        .index(RELOCATION_ID_INDEX)
        .getAll(
          admitted.expectedPrefixRecord.relocationId,
          MAX_MEMBERS + 1,
        ) as IDBRequest<unknown[]>,
    );
    if (existing.length > 0) {
      return exactStoredPrefixPlan(existing, members)
        ? commandSuccess(planSummary(admitted.expectedPrefixRecord))
        : conflict();
    }
    const accounted = await updateMemberAccounting(tx, members, {
      kind: "insert",
      limits: context.limits,
    });
    if (!accounted.ok) return accounted;
    for (const member of members) store.put(member);
    return commandSuccess(planSummary(admitted.expectedPrefixRecord));
  });
}

export async function loadPrefixRelocationMember(
  database: IDBDatabase,
  request: LoadPrefixRelocationMemberV1,
): Promise<CommandResultV1<PrefixRelocationMemberV1>> {
  if (!validLoadRequest(request)) return invalid();
  const transaction = database.transaction(
    [RECORDS_STORE, PREFIX_PLAN_STORE],
    "readonly",
  );
  const done = transactionDone(transaction);
  try {
    const [storedValue, prefixValue] = await Promise.all([
      requestResult(
        transaction
          .objectStore(PREFIX_PLAN_STORE)
          .get(
            prefixMemberKey(request.relocationId, request.ordinal),
          ) as IDBRequest<unknown>,
      ),
      requestResult(
        transaction
          .objectStore(RECORDS_STORE)
          .get(`relocation:${request.relocationId}`) as IDBRequest<unknown>,
      ),
    ]);
    await done;
    return await materializeLoadedMember(request, storedValue, prefixValue);
  } catch {
    await done.catch(() => undefined);
    return commandFailure("recovery-unavailable");
  }
}

export async function loadActivePrefixRelocations(
  database: IDBDatabase,
  request: LoadActivePrefixRelocationsV1,
): Promise<CommandResultV1<readonly PrefixRelocationRecordV1[]>> {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_ACTIVE_PREFIX_RELOCATIONS
  ) {
    return invalid();
  }
  try {
    const transaction = database.transaction(RECORDS_STORE, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult(
      transaction
        .objectStore(RECORDS_STORE)
        .index(ACTIVE_PREFIX_INDEX)
        .getAll(ACTIVE_PREFIX_VALUE, request.limit + 1) as IDBRequest<
        unknown[]
      >,
    );
    await done;
    if (values.length > request.limit) return limited();
    const records = await Promise.all(
      values.map((value) => decodeStoredRecord(value)),
    );
    if (records.some((record) => !record.ok)) {
      return commandFailure("recovery-unavailable");
    }
    const prefixes = records.flatMap((result) =>
      result.ok && isPrefixRecord(result.value.record)
        ? [result.value.record]
        : [],
    );
    if (prefixes.length !== records.length) {
      return commandFailure("recovery-unavailable");
    }
    prefixes.sort(comparePrefixRelocationRules);
    if (!validPrefixRelocationRuleSet(prefixes)) {
      return commandFailure("recovery-unavailable");
    }
    return commandSuccess(Object.freeze(prefixes));
  } catch {
    return commandFailure("recovery-unavailable");
  }
}

export async function deletePrefixRelocationPlan(
  transaction: IDBTransaction,
  record: PrefixRelocationRecordV1,
): Promise<CommandResultV1<void>> {
  const store = transaction.objectStore(PREFIX_PLAN_STORE);
  const values = await requestResult(
    store
      .index(RELOCATION_ID_INDEX)
      .getAll(record.relocationId, MAX_MEMBERS + 1) as IDBRequest<unknown[]>,
  );
  if (values.length !== record.admittedRecordCount) return conflict();
  const members = values.map(parseStoredPrefixMember);
  if (members.some((member) => member === null)) {
    return commandFailure("recovery-unavailable");
  }
  const stored = members.filter(
    (member): member is StoredPrefixRelocationMember => member !== null,
  );
  if (!validStoredPrefixOrdinals(stored, record)) return conflict();
  const deleted = await updateMemberAccounting(transaction, stored, {
    kind: "delete",
  });
  if (!deleted.ok) return deleted;
  for (const member of stored) store.delete(member.key);
  return commandSuccess(undefined);
}

async function exactCurrentPrefix(
  transaction: IDBTransaction,
  expected: StoredRecoveryRecord,
): Promise<boolean> {
  const value = await requestResult(
    transaction
      .objectStore(RECORDS_STORE)
      .get(expected.key) as IDBRequest<unknown>,
  );
  const current = decodeStoredRecordInTransaction(value, expected.key);
  return current.ok && storedPayloadEqual(current.value.stored, expected);
}

async function materializeLoadedMember(
  request: LoadPrefixRelocationMemberV1,
  storedValue: unknown,
  prefixValue: unknown,
): Promise<CommandResultV1<PrefixRelocationMemberV1>> {
  const stored = parseStoredPrefixMember(storedValue);
  const prefix = decodeStoredRecordInTransaction(
    prefixValue,
    `relocation:${request.relocationId}`,
  );
  if (
    stored === null ||
    !prefix.ok ||
    !isPrefixRecord(prefix.value.record) ||
    request.ordinal >= prefix.value.record.admittedRecordCount ||
    stored.sha256 !== (await sha256Bytes(stored.encoded))
  ) {
    return conflict();
  }
  const member = decodePrefixMember(stored.encoded);
  return member.ok &&
    storedPrefixMemberMatches(stored, request.relocationId, member.value)
    ? member
    : commandFailure("recovery-unavailable");
}

async function createStoredMember(
  relocationId: string,
  member: PrefixRelocationMemberV1,
  encoded: Uint8Array,
): Promise<StoredPrefixRelocationMember> {
  return {
    byteSize: encoded.byteLength,
    encoded,
    key: prefixMemberKey(relocationId, member.ordinal),
    noteKey: member.priorNoteIdentity.vaultRelativeMarkdownPath,
    ordinal: member.ordinal,
    relocationId,
    sha256: await sha256Bytes(encoded),
  };
}

async function updateMemberAccounting(
  transaction: IDBTransaction,
  members: readonly StoredPrefixRelocationMember[],
  operation:
    | Readonly<{ kind: "insert"; limits: WriteContext["limits"] }>
    | Readonly<{ kind: "delete" }>,
): Promise<CommandResultV1<void>> {
  let global = (await readAccounting(transaction, null)).global;
  for (const [noteKey, group] of groupByNote(members)) {
    const note = await readNoteAccounting(transaction, noteKey);
    const bytes = group.reduce((total, member) => total + member.byteSize, 0);
    const multiplier =
      operation.kind === "insert" ? ACCOUNT_INCREMENT : ACCOUNT_DECREMENT;
    const next = applyAccountingDelta(
      { global, note },
      multiplier * bytes,
      multiplier * group.length,
    );
    if (next === null) {
      return operation.kind === "insert"
        ? limited()
        : commandFailure("recovery-unavailable");
    }
    if (operation.kind === "insert" && exceedsLimits(next, operation.limits)) {
      return limited();
    }
    global = next.global;
    writeAccounting(transaction, noteKey, next);
  }
  return commandSuccess(undefined);
}

function groupByNote(
  members: readonly StoredPrefixRelocationMember[],
): ReadonlyMap<string, readonly StoredPrefixRelocationMember[]> {
  const groups = new Map<string, StoredPrefixRelocationMember[]>();
  for (const member of members) {
    const group = groups.get(member.noteKey) ?? [];
    group.push(member);
    groups.set(member.noteKey, group);
  }
  return groups;
}

function planSummary(record: PrefixRelocationRecordV1): PrefixRelocationPlanV1 {
  return Object.freeze({
    admittedRecordCount: record.admittedRecordCount,
    expectedSettingsRevision: record.expectedSettingsRevision,
    generation: record.generation,
    relocationId: record.relocationId,
  });
}

function isPrefixRecord(value: unknown): value is PrefixRelocationRecordV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value.kind === "folder-prefix" || value.kind === "storage-root")
  );
}

function validLoadRequest(request: LoadPrefixRelocationMemberV1): boolean {
  try {
    parseRelocationId(request.relocationId);
    return (
      Number.isSafeInteger(request.ordinal) &&
      request.ordinal >= 0 &&
      request.ordinal < MAX_MEMBERS
    );
  } catch {
    return false;
  }
}

function invalid(): CommandResultV1<never> {
  return commandFailure("invalid-command");
}

function conflict(): CommandResultV1<never> {
  return commandFailure("sidecar-conflict");
}

function limited(): CommandResultV1<never> {
  return commandFailure("recovery-limit");
}
