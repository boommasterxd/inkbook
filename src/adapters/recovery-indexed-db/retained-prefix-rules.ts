import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
} from "../../application/note-session";
import {
  RECOVERY_STORE_LIMITS_V1,
  validateRelocationStart,
  validateRelocationRecord,
  type BeginPrefixRelocationBatchV1,
  type LoadRetainedPrefixRelocationRulesV1,
  type PrefixRelocationRecordV1,
  type RemoveRetainedPrefixRelocationRuleForMaintenanceV1,
} from "../../application/recovery";
import {
  applyAccountingDelta,
  readAccounting,
  writeAccounting,
} from "./accounting";
import { requestResult, transactionDone } from "./idb-promises";
import {
  admitQueueRequest,
  admitRecoveryRecord,
  type AdmittedQueueRequest,
} from "./queue-admission";
import { conflict, insertRecord, limited } from "./record-admission";
import {
  createStoredRecord,
  decodeStoredRecord,
  decodeStoredRecordInTransaction,
  retainCompletedPrefixRecord,
  storedPayloadEqual,
} from "./record-storage";
import {
  ACTIVE_PREFIX_INDEX,
  ACTIVE_PREFIX_VALUE,
  PREFIX_PLAN_STORE,
  RECORDS_STORE,
  RELOCATION_ID_INDEX,
  RETAINED_PREFIX_VALUE,
  type StoredRecoveryRecord,
} from "./schema";
import { runMutation } from "./transactions";
import type { IndexedDbRecoveryLimits } from "./types";
import type { WriteContext } from "./write-operations";

const MAX_RETAINED_RULES = 128;
const DELETE_ONE_RECORD = -1;

interface AdmittedRemoval {
  readonly expectedRule: PrefixRelocationRecordV1;
  readonly encoded: Uint8Array;
  readonly byteSize: number;
}

export interface AdmittedPrefixRelocationBatch {
  readonly entries: readonly Readonly<{
    readonly bytes: Uint8Array;
    readonly record: PrefixRelocationRecordV1;
  }>[];
  readonly generation: number;
  readonly retainedBytes: number;
}

export function admitPrefixRelocationBatch(
  request: BeginPrefixRelocationBatchV1,
): CommandResultV1<AdmittedPrefixRelocationBatch> {
  const values = readBatchRecords(request);
  if (!values.ok) return values;
  const entries: {
    bytes: Uint8Array;
    record: PrefixRelocationRecordV1;
  }[] = [];
  let retainedBytes = 0;
  for (const value of values.value) {
    let admitted: ReturnType<typeof admitRecoveryRecord>;
    try {
      admitted = admitRecoveryRecord(value as PrefixRelocationRecordV1);
    } catch {
      return invalid();
    }
    if (!admitted.ok) return admitted;
    if (!hasPrefixRelocationKind(admitted.value.record)) return invalid();
    const validated = validateRelocationStart(admitted.value.record);
    if (!validated.ok || !hasPrefixRelocationKind(validated.value)) {
      return invalid();
    }
    retainedBytes += admitted.value.bytes.byteLength;
    if (retainedBytes > RECOVERY_STORE_LIMITS_V1.maxGlobalBytes) {
      return limited();
    }
    entries.push({ bytes: admitted.value.bytes, record: validated.value });
  }
  entries.sort((left, right) =>
    comparePrefixRelocationRules(left.record, right.record),
  );
  if (!validNewBatch(entries.map(({ record }) => record))) return conflict();
  return commandSuccess(
    Object.freeze({
      entries: Object.freeze(entries),
      generation: entries[0]?.record.generation ?? 0,
      retainedBytes,
    }),
  );
}

export async function beginPrefixRelocationBatch(
  context: WriteContext,
  admitted: AdmittedPrefixRelocationBatch,
): Promise<CommandResultV1<void>> {
  const stored = await Promise.all(
    admitted.entries.map(({ bytes, record }) =>
      createStoredRecord(record, bytes),
    ),
  );
  if (stored.some((entry) => !entry.ok)) return unavailable();
  const values = stored.flatMap((entry) => (entry.ok ? [entry.value] : []));
  if (values.length !== admitted.entries.length) return unavailable();
  return runMutation(context, "begin-prefix-relocation-batch", (transaction) =>
    insertPrefixRelocationBatch(
      transaction,
      values,
      admitted.entries.map(({ record }) => record),
      context.limits,
    ),
  );
}

export function admitRetainedRuleLoad(
  request: LoadRetainedPrefixRelocationRulesV1,
): CommandResultV1<AdmittedQueueRequest<LoadRetainedPrefixRelocationRulesV1>> {
  if (!validLimitRequest(request)) return invalid();
  const descriptor = Reflect.getOwnPropertyDescriptor(request, "limit");
  if (descriptor === undefined || !("value" in descriptor)) return invalid();
  return admitQueueRequest(Object.freeze({ limit: descriptor.value }));
}

export async function insertPrefixRelocationRecord(
  transaction: IDBTransaction,
  stored: StoredRecoveryRecord,
  record: PrefixRelocationRecordV1,
  limits: IndexedDbRecoveryLimits,
): Promise<CommandResultV1<void>> {
  return insertPrefixRelocationBatch(transaction, [stored], [record], limits);
}

async function insertPrefixRelocationBatch(
  transaction: IDBTransaction,
  stored: readonly StoredRecoveryRecord[],
  batch: readonly PrefixRelocationRecordV1[],
  limits: IndexedDbRecoveryLimits,
): Promise<CommandResultV1<void>> {
  const records = transaction.objectStore(RECORDS_STORE);
  const existing = await Promise.all(
    stored.map((entry) =>
      requestResult(records.get(entry.key) as IDBRequest<unknown>),
    ),
  );
  if (existing.some((value) => value !== undefined)) {
    return existing.every(
      (value, index) =>
        value !== undefined && exactStored(value, stored[index]),
    )
      ? commandSuccess(undefined)
      : conflict();
  }
  const [activeCount, retainedCount] = await Promise.all([
    requestResult(
      records.index(ACTIVE_PREFIX_INDEX).count(ACTIVE_PREFIX_VALUE),
    ),
    requestResult(
      records.index(ACTIVE_PREFIX_INDEX).count(RETAINED_PREFIX_VALUE),
    ),
  ]);
  if (activeCount + retainedCount + stored.length > MAX_RETAINED_RULES) {
    return limited();
  }
  const accounting = await readAccounting(transaction, null);
  const generation = batch[0]?.generation;
  if (generation !== accounting.global.prefixGenerationHighWater + 1) {
    return conflict();
  }
  for (const entry of stored) {
    const inserted = await insertRecord(transaction, entry, limits);
    if (!inserted.ok) return inserted;
  }
  const updated = await readAccounting(transaction, null);
  writeAccounting(transaction, null, {
    global: {
      ...updated.global,
      prefixGenerationHighWater: generation,
    },
    note: updated.note,
  });
  return commandSuccess(undefined);
}

export async function retainCompletedPrefixRule(
  transaction: IDBTransaction,
  stored: StoredRecoveryRecord,
  record: PrefixRelocationRecordV1,
): Promise<CommandResultV1<void>> {
  if (stored.activePrefixRelocation === RETAINED_PREFIX_VALUE) {
    return commandSuccess(undefined);
  }
  const count = await requestResult(
    transaction
      .objectStore(RECORDS_STORE)
      .index(ACTIVE_PREFIX_INDEX)
      .count(RETAINED_PREFIX_VALUE),
  );
  if (count >= MAX_RETAINED_RULES) return limited();
  const retained = retainCompletedPrefixRecord(stored, record);
  if (!retained.ok) return retained;
  transaction.objectStore(RECORDS_STORE).put(retained.value);
  return commandSuccess(undefined);
}

export async function loadRetainedPrefixRelocationRules(
  database: IDBDatabase,
  request: LoadRetainedPrefixRelocationRulesV1,
): Promise<CommandResultV1<readonly PrefixRelocationRecordV1[]>> {
  if (!validLimitRequest(request)) return invalid();
  try {
    const transaction = database.transaction(RECORDS_STORE, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult(
      transaction
        .objectStore(RECORDS_STORE)
        .index(ACTIVE_PREFIX_INDEX)
        .getAll(RETAINED_PREFIX_VALUE, request.limit + 1) as IDBRequest<
        unknown[]
      >,
    );
    await done;
    if (values.length > request.limit) return limited();
    const decoded = await Promise.all(
      values.map((value) => decodeStoredRecord(value)),
    );
    if (decoded.some((entry) => !entry.ok)) return unavailable();
    const rules = decoded.flatMap((entry) =>
      entry.ok && isCompletedPrefix(entry.value.record)
        ? [entry.value.record]
        : [],
    );
    if (rules.length !== decoded.length) return unavailable();
    rules.sort(comparePrefixRelocationRules);
    if (!validPrefixRelocationRuleSet(rules)) return unavailable();
    return commandSuccess(Object.freeze(rules));
  } catch {
    return unavailable();
  }
}

export function admitRetainedRuleRemoval(
  request: RemoveRetainedPrefixRelocationRuleForMaintenanceV1,
): CommandResultV1<AdmittedRemoval> {
  try {
    if (!exactDataPropertyRequest(request, "expectedRule")) return invalid();
    const descriptor = Reflect.getOwnPropertyDescriptor(
      request,
      "expectedRule",
    );
    if (descriptor === undefined || !("value" in descriptor)) return invalid();
    const admitted = admitRecoveryRecord(descriptor.value);
    if (!admitted.ok) return admitted;
    const validated = validateRelocationRecord(admitted.value.record);
    if (!validated.ok || !isCompletedPrefix(validated.value)) return invalid();
    return commandSuccess({
      byteSize: admitted.value.bytes.byteLength,
      encoded: admitted.value.bytes,
      expectedRule: validated.value,
    });
  } catch {
    return invalid();
  }
}

export async function removeRetainedPrefixRelocationRuleForMaintenance(
  context: WriteContext,
  admitted: AdmittedRemoval,
): Promise<CommandResultV1<void>> {
  const active = await createStoredRecord(
    admitted.expectedRule,
    admitted.encoded,
  );
  if (!active.ok) return active;
  const expected = retainCompletedPrefixRecord(
    active.value,
    admitted.expectedRule,
  );
  if (!expected.ok) return expected;
  return runMutation(
    context,
    "remove-retained-prefix-relocation-rule",
    async (transaction) => {
      const records = transaction.objectStore(RECORDS_STORE);
      const value = await requestResult(
        records.get(expected.value.key) as IDBRequest<unknown>,
      );
      const current = decodeStoredRecordInTransaction(
        value,
        expected.value.key,
      );
      if (
        !current.ok ||
        current.value.stored.activePrefixRelocation !== RETAINED_PREFIX_VALUE ||
        !storedPayloadEqual(current.value.stored, expected.value)
      ) {
        return conflict();
      }
      const memberCount = await requestResult(
        transaction
          .objectStore(PREFIX_PLAN_STORE)
          .index(RELOCATION_ID_INDEX)
          .count(admitted.expectedRule.relocationId),
      );
      if (memberCount !== 0) return unavailable();
      const accounting = await readAccounting(transaction, null);
      const replacement = applyAccountingDelta(
        accounting,
        -current.value.stored.byteSize,
        DELETE_ONE_RECORD,
        undefined,
        false,
      );
      if (replacement === null) return unavailable();
      records.delete(current.value.stored.key);
      writeAccounting(transaction, null, replacement);
      return commandSuccess(undefined);
    },
  );
}

function validLimitRequest(
  value: unknown,
): value is { readonly limit: number } {
  if (!exactDataPropertyRequest(value, "limit")) return false;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, "limit");
  return (
    typeof descriptor?.value === "number" &&
    Number.isSafeInteger(descriptor.value) &&
    descriptor.value >= 1 &&
    descriptor.value <= MAX_RETAINED_RULES
  );
}

function readBatchRecords(
  request: BeginPrefixRelocationBatchV1,
): CommandResultV1<readonly unknown[]> {
  try {
    if (!exactDataPropertyRequest(request, "records")) return invalid();
    const descriptor = Reflect.getOwnPropertyDescriptor(request, "records");
    if (descriptor === undefined || !("value" in descriptor)) return invalid();
    const records = descriptor.value;
    if (!Array.isArray(records)) return invalid();
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(
      records,
      "length",
    );
    const length = lengthDescriptor?.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length)) {
      return invalid();
    }
    if (length > MAX_RETAINED_RULES) return limited();
    if (length < 1 || Reflect.ownKeys(records).length !== length + 1) {
      return invalid();
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = Reflect.getOwnPropertyDescriptor(records, String(index));
      if (item?.enumerable !== true || !("value" in item)) {
        return invalid();
      }
      const itemValue: unknown = item.value;
      values.push(itemValue);
    }
    return commandSuccess(Object.freeze(values));
  } catch {
    return invalid();
  }
}

function validNewBatch(records: readonly PrefixRelocationRecordV1[]): boolean {
  const first = records[0];
  if (first === undefined) return false;
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const record of records) {
    if (
      record.generation !== first.generation ||
      record.expectedSettingsRevision !== first.expectedSettingsRevision ||
      ids.has(record.relocationId) ||
      prefixes.has(record.priorPrefix)
    ) {
      return false;
    }
    ids.add(record.relocationId);
    prefixes.add(record.priorPrefix);
  }
  return true;
}

export function validPrefixRelocationRuleSet(
  records: readonly PrefixRelocationRecordV1[],
): boolean {
  const ids = new Set<string>();
  const generationPrefixes = new Set<string>();
  for (const record of records) {
    const key = `${String(record.generation)}\0${record.priorPrefix}`;
    if (ids.has(record.relocationId) || generationPrefixes.has(key)) {
      return false;
    }
    ids.add(record.relocationId);
    generationPrefixes.add(key);
  }
  return true;
}

export function comparePrefixRelocationRules(
  left: PrefixRelocationRecordV1,
  right: PrefixRelocationRecordV1,
): number {
  return (
    left.generation - right.generation ||
    right.priorPrefix.length - left.priorPrefix.length ||
    left.relocationId.localeCompare(right.relocationId)
  );
}

export function hasPrefixRelocationKind(
  value: unknown,
): value is PrefixRelocationRecordV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, "kind");
    return (
      descriptor?.enumerable === true &&
      "value" in descriptor &&
      (descriptor.value === "folder-prefix" ||
        descriptor.value === "storage-root")
    );
  } catch {
    return false;
  }
}

function exactStored(
  value: unknown,
  expected: StoredRecoveryRecord | undefined,
): boolean {
  if (expected === undefined) return false;
  const current = decodeStoredRecordInTransaction(value, expected.key);
  return current.ok && storedPayloadEqual(current.value.stored, expected);
}

function exactDataPropertyRequest(
  value: unknown,
  key: string,
): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (keys.length !== 1 || keys[0] !== key || descriptor?.enumerable !== true) {
    return false;
  }
  return "value" in descriptor;
}

function isCompletedPrefix(value: unknown): value is PrefixRelocationRecordV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value.kind === "folder-prefix" || value.kind === "storage-root") &&
    "step" in value &&
    value.step === "complete"
  );
}

function invalid<T>(): CommandResultV1<T> {
  return commandFailure("invalid-command");
}

function unavailable<T>(): CommandResultV1<T> {
  return commandFailure("recovery-unavailable");
}
