import type { CommandResultV1 } from "../../application/note-session";
import {
  isValidNoteIdentity,
  type RecoveryPersistenceRecordV1,
  type RecoveryRekeyV1,
  type RelocationRecordV1,
  type SidecarBaseIdentityV1,
} from "../../application/recovery";
import {
  readAccounting,
  readNoteAccounting,
  writeAccounting,
} from "./accounting";
import { requestResult, transactionDone } from "./idb-promises";
import { conflict, limited, success } from "./record-admission";
import {
  createStoredRecord,
  decodeStoredRecord,
  decodeStoredRecordInTransaction,
  storedPayloadEqual,
} from "./record-storage";
import {
  NOTE_KEY_INDEX,
  RECORDS_STORE,
  type StoredRecoveryRecord,
} from "./schema";
import { runMutation } from "./transactions";
import type { RecoveryAccounting } from "./types";
import type { WriteContext } from "./write-operations";

interface RekeyedRecord {
  readonly prior: StoredRecoveryRecord;
  readonly replacement: StoredRecoveryRecord;
}

interface PreparedRekey {
  readonly records: readonly RekeyedRecord[];
  readonly saga: StoredRecoveryRecord;
}

export async function rekeyNote(
  context: WriteContext,
  request: RecoveryRekeyV1,
): Promise<CommandResultV1<void>> {
  if (
    !isValidNoteIdentity(request.prior) ||
    !isValidNoteIdentity(request.replacement) ||
    request.prior.vaultIdHint !== request.replacement.vaultIdHint ||
    request.prior.vaultRelativeMarkdownPath ===
      request.replacement.vaultRelativeMarkdownPath
  ) {
    return { ok: false, code: "invalid-command" };
  }
  const prepared = await prepareRekey(context, request);
  if (!prepared.ok) return prepared;
  return runMutation(context, "rekey-note", (transaction) =>
    applyRekey(transaction, context, request, prepared.value),
  );
}

async function prepareRekey(
  context: WriteContext,
  request: RecoveryRekeyV1,
): Promise<CommandResultV1<PreparedRekey>> {
  try {
    const transaction = context.database.transaction(RECORDS_STORE, "readonly");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(RECORDS_STORE);
    const values = await requestResult(
      store
        .index(NOTE_KEY_INDEX)
        .getAll(
          request.prior.vaultRelativeMarkdownPath,
          context.limits.noteRecords + 1,
        ) as IDBRequest<StoredRecoveryRecord[]>,
    );
    const saga = await requestResult(
      store.get(`relocation:${request.relocationId}`) as IDBRequest<unknown>,
    );
    await done;
    if (values.length > context.limits.noteRecords || saga === undefined) {
      return values.length > context.limits.noteRecords
        ? limited()
        : conflict();
    }
    const decodedSaga = await decodeStoredRecord(saga);
    if (
      !decodedSaga.ok ||
      !("relocationId" in decodedSaga.value.record) ||
      !sagaAuthorizesRekey(decodedSaga.value.record, request)
    ) {
      return conflict();
    }
    const result: RekeyedRecord[] = [];
    for (const value of values) {
      const decoded = await decodeStoredRecord(value, value.key);
      if (!decoded.ok) return decoded;
      const replacementRecord = rekeyRecord(
        decoded.value.record,
        request,
        decodedSaga.value.record,
      );
      const replacement = await createStoredRecord(replacementRecord);
      if (!replacement.ok) return replacement;
      result.push({
        prior: decoded.value.stored,
        replacement: replacement.value,
      });
    }
    return {
      ok: true,
      value: {
        records: result,
        saga: decodedSaga.value.stored,
      },
    };
  } catch {
    return { ok: false, code: "recovery-unavailable" };
  }
}

async function applyRekey(
  transaction: IDBTransaction,
  context: WriteContext,
  request: RecoveryRekeyV1,
  prepared: PreparedRekey,
): Promise<CommandResultV1<void>> {
  const store = transaction.objectStore(RECORDS_STORE);
  const records = prepared.records;
  const currentSagaValue = await requestResult(
    store.get(prepared.saga.key) as IDBRequest<unknown>,
  );
  const currentSaga = decodeStoredRecordInTransaction(
    currentSagaValue,
    prepared.saga.key,
  );
  if (
    !currentSaga.ok ||
    !storedPayloadEqual(currentSaga.value.stored, prepared.saga)
  ) {
    return conflict();
  }
  const destinationCount = await requestResult(
    store
      .index(NOTE_KEY_INDEX)
      .count(request.replacement.vaultRelativeMarkdownPath),
  );
  if (destinationCount !== 0) return conflict();
  const currentValues = await requestResult(
    store
      .index(NOTE_KEY_INDEX)
      .getAll(
        request.prior.vaultRelativeMarkdownPath,
        context.limits.noteRecords + 1,
      ) as IDBRequest<unknown[]>,
  );
  if (currentValues.length > context.limits.noteRecords) return limited();
  if (!sameRekeySnapshot(currentValues, records)) return conflict();
  const priorAccounting = await readAccounting(
    transaction,
    request.prior.vaultRelativeMarkdownPath,
  );
  const destinationAccounting = await readNoteAccounting(
    transaction,
    request.replacement.vaultRelativeMarkdownPath,
  );
  if (
    destinationAccounting.bytes !== 0 ||
    destinationAccounting.records !== 0
  ) {
    return conflict();
  }
  const replacementBytes = records.reduce(
    (total, item) => total + item.replacement.byteSize,
    0,
  );
  const globalBytes =
    priorAccounting.global.bytes -
    priorAccounting.note.bytes +
    replacementBytes;
  if (
    globalBytes > context.limits.globalBytes ||
    replacementBytes > context.limits.noteBytes
  ) {
    return limited();
  }
  for (const item of records) store.put(item.replacement);
  writeRekeyAccounting(
    transaction,
    request,
    priorAccounting.global,
    priorAccounting.note,
    replacementBytes,
  );
  return success();
}

function writeRekeyAccounting(
  transaction: IDBTransaction,
  request: RecoveryRekeyV1,
  global: RecoveryAccounting,
  prior: RecoveryAccounting,
  replacementBytes: number,
): void {
  const replacementGlobal = {
    ...global,
    bytes: global.bytes - prior.bytes + replacementBytes,
  };
  writeAccounting(transaction, request.prior.vaultRelativeMarkdownPath, {
    global: replacementGlobal,
    note: { bytes: 0, records: 0, sessionOrderHighWater: 0 },
  });
  writeAccounting(transaction, request.replacement.vaultRelativeMarkdownPath, {
    global: replacementGlobal,
    note: {
      bytes: replacementBytes,
      records: prior.records,
      sessionOrderHighWater: prior.sessionOrderHighWater,
    },
  });
}

function rekeyRecord(
  record: RecoveryPersistenceRecordV1,
  request: RecoveryRekeyV1,
  saga: RelocationRecordV1,
): RecoveryPersistenceRecordV1 {
  if ("base" in record) {
    return {
      ...record,
      base: rekeyBase(record.base, request, saga),
    };
  }
  if ("noteIdentity" in record) {
    return {
      ...record,
      noteIdentity: request.replacement,
      sidecarBase: rekeyBase(record.sidecarBase, request, saga),
    };
  }
  return record;
}

function rekeyBase(
  base: SidecarBaseIdentityV1,
  request: RecoveryRekeyV1,
  saga: RelocationRecordV1,
): SidecarBaseIdentityV1 {
  return {
    ...base,
    markdownPath: request.replacement.vaultRelativeMarkdownPath,
    vaultRelativePath: replacementSidecarPath(base.vaultRelativePath, saga),
  };
}

function replacementSidecarPath(
  path: string,
  saga: RelocationRecordV1,
): string {
  if (saga.kind === "markdown-file" || saga.kind === "sidecar-location") {
    return saga.destinationSidecarPath;
  }
  if (saga.kind !== "folder-prefix") return path;
  return (
    replaceCompletePrefix(path, saga.priorPrefix, saga.replacementPrefix) ??
    path
  );
}

function sameRekeySnapshot(
  currentValues: readonly unknown[],
  expectedRecords: readonly RekeyedRecord[],
): boolean {
  if (currentValues.length !== expectedRecords.length) return false;
  const expected = new Map(
    expectedRecords.map((item) => [item.prior.key, item.prior]),
  );
  return currentValues.every((value) => {
    const current = decodeStoredRecordInTransaction(value);
    if (!current.ok) return false;
    const prior = expected.get(current.value.stored.key);
    return (
      prior !== undefined && storedPayloadEqual(current.value.stored, prior)
    );
  });
}

function sagaAuthorizesRekey(
  record: Extract<RecoveryPersistenceRecordV1, { relocationId: unknown }>,
  request: RecoveryRekeyV1,
): boolean {
  if (record.kind === "markdown-file") {
    return (
      record.noteIdentity.vaultRelativeMarkdownPath ===
        request.prior.vaultRelativeMarkdownPath &&
      record.destinationMarkdownPath ===
        request.replacement.vaultRelativeMarkdownPath
    );
  }
  if (record.kind !== "folder-prefix") return false;
  const replaced = replaceCompletePrefix(
    request.prior.vaultRelativeMarkdownPath,
    record.priorPrefix,
    record.replacementPrefix,
  );
  return replaced === request.replacement.vaultRelativeMarkdownPath;
}

function replaceCompletePrefix(
  path: string,
  priorPrefix: string,
  replacementPrefix: string,
): string | null {
  if (priorPrefix === "") return `${replacementPrefix}/${path}`;
  if (path === priorPrefix) return replacementPrefix;
  const prefix = `${priorPrefix}/`;
  return path.startsWith(prefix)
    ? `${replacementPrefix}/${path.slice(prefix.length)}`
    : null;
}
