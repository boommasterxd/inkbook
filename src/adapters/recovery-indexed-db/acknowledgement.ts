import type { CommandResultV1 } from "../../application/note-session";
import {
  sameSidecarBase,
  validateSidecarAcknowledgement,
  type RecoveryAttemptV1,
  type RecoveryPersistenceRecordV1,
  type SidecarRecoveryAcknowledgementV1,
} from "../../application/recovery";
import type { SourceCheckpointOperationV1 } from "../../application/source-coordination";
import {
  applyAccountingDelta,
  readAccounting,
  writeAccounting,
} from "./accounting";
import { requestResult, transactionDone } from "./idb-promises";
import { conflict, exceedsLimits, limited, success } from "./record-admission";
import {
  createStoredRecord,
  decodeStoredRecord,
  recoverySuccessorKey,
  storedPayloadEqual,
} from "./record-storage";
import {
  RECORDS_STORE,
  SUCCESSOR_KEY_INDEX,
  type StoredRecoveryRecord,
} from "./schema";
import { runMutation } from "./transactions";
import type { WriteContext } from "./write-operations";

interface SuccessorRecord {
  readonly stored: StoredRecoveryRecord;
  readonly record: RecoveryAttemptV1 | SourceCheckpointOperationV1;
}

interface PreparedAcknowledgement {
  readonly priorKey: string;
  readonly replacementKey: string;
  readonly snapshot: readonly SuccessorRecord[];
  readonly covered: ReadonlySet<string>;
  readonly retained: readonly {
    prior: StoredRecoveryRecord;
    replacement: StoredRecoveryRecord;
  }[];
}

export async function acknowledgeSidecar(
  context: WriteContext,
  request: SidecarRecoveryAcknowledgementV1,
): Promise<CommandResultV1<void>> {
  const validated = validateSidecarAcknowledgement(request);
  if (!validated.ok) return validated;
  if (
    request.noteIdentity.vaultRelativeMarkdownPath !==
    request.expectedPriorBase.markdownPath
  ) {
    return conflict();
  }
  const prepared = await prepareAcknowledgement(context, request);
  if (!prepared.ok) return prepared;
  return runMutation(context, "acknowledge-sidecar", async (transaction) =>
    applyAcknowledgement(transaction, context, prepared.value),
  );
}

async function prepareAcknowledgement(
  context: WriteContext,
  request: SidecarRecoveryAcknowledgementV1,
): Promise<CommandResultV1<PreparedAcknowledgement>> {
  const noteKey = request.noteIdentity.vaultRelativeMarkdownPath;
  const priorKey = recoverySuccessorKey(noteKey, request.expectedPriorBase);
  const replacementKey = recoverySuccessorKey(
    noteKey,
    request.acknowledgedReplacementBase,
  );
  const loaded = await loadSuccessors(context, priorKey);
  if (!loaded.ok) return loaded;
  const covered = coveredKeys(request);
  if (!validCoverage(loaded.value, covered, request)) return conflict();
  const retained: PreparedAcknowledgement["retained"][number][] = [];
  for (const item of loaded.value) {
    if (covered.has(item.stored.key)) continue;
    const rebased = await createStoredRecord({
      ...item.record,
      base: request.acknowledgedReplacementBase,
    });
    if (!rebased.ok) return rebased;
    retained.push({ prior: item.stored, replacement: rebased.value });
  }
  return {
    ok: true,
    value: {
      covered,
      priorKey,
      replacementKey,
      retained,
      snapshot: loaded.value,
    },
  };
}

async function applyAcknowledgement(
  transaction: IDBTransaction,
  context: WriteContext,
  prepared: PreparedAcknowledgement,
): Promise<CommandResultV1<void>> {
  const records = transaction.objectStore(RECORDS_STORE);
  const current = await loadStoredSuccessors(
    records,
    prepared.priorKey,
    context.limits.directSuccessors,
  );
  if (!sameSuccessorSnapshot(current, prepared.snapshot)) return conflict();
  const destination = await loadStoredSuccessors(
    records,
    prepared.replacementKey,
    context.limits.directSuccessors,
  );
  if (destination.length > 0) return conflict();
  const accounting = await readAccounting(
    transaction,
    prepared.snapshot[0]?.stored.noteKey ?? null,
  );
  const byteDelta = acknowledgementByteDelta(prepared);
  const adjusted = applyAccountingDelta(
    accounting,
    byteDelta,
    -prepared.covered.size,
  );
  if (adjusted === null || exceedsLimits(adjusted, context.limits)) {
    return limited();
  }
  for (const key of prepared.covered) records.delete(key);
  for (const item of prepared.retained) records.put(item.replacement);
  const noteKey = prepared.snapshot[0]?.stored.noteKey ?? null;
  writeAccounting(transaction, noteKey, adjusted);
  return success();
}

async function loadSuccessors(
  context: WriteContext,
  successorKey: string,
): Promise<CommandResultV1<readonly SuccessorRecord[]>> {
  try {
    const transaction = context.database.transaction(RECORDS_STORE, "readonly");
    const done = transactionDone(transaction);
    const values = await loadStoredSuccessors(
      transaction.objectStore(RECORDS_STORE),
      successorKey,
      context.limits.directSuccessors,
    );
    await done;
    if (values.length > context.limits.directSuccessors) return limited();
    const records: SuccessorRecord[] = [];
    for (const value of values) {
      const decoded = await decodeStoredRecord(value, value.key);
      if (!decoded.ok || !isSuccessor(decoded.value.record)) {
        return { ok: false, code: "recovery-unavailable" };
      }
      records.push({
        stored: decoded.value.stored,
        record: decoded.value.record,
      });
    }
    return { ok: true, value: records };
  } catch {
    return { ok: false, code: "recovery-unavailable" };
  }
}

async function loadStoredSuccessors(
  store: IDBObjectStore,
  successorKey: string,
  limit: number,
): Promise<StoredRecoveryRecord[]> {
  return await requestResult(
    store
      .index(SUCCESSOR_KEY_INDEX)
      .getAll(successorKey, limit + 1) as IDBRequest<StoredRecoveryRecord[]>,
  );
}

function validCoverage(
  records: readonly SuccessorRecord[],
  covered: ReadonlySet<string>,
  request: SidecarRecoveryAcknowledgementV1,
): boolean {
  if (
    covered.size !==
    request.coveredAttemptIds.length + request.coveredCheckpointIds.length
  ) {
    return false;
  }
  const available = new Set(records.map((item) => item.stored.key));
  if ([...covered].some((key) => !available.has(key))) return false;
  let greatestCoveredOrder = 0;
  for (const item of records) {
    const isCovered = covered.has(item.stored.key);
    if (isCovered)
      greatestCoveredOrder = Math.max(
        greatestCoveredOrder,
        item.stored.sessionOrder,
      );
    if (!coverageMatchesEvidence(item.record, isCovered, request)) return false;
    if (!sameSidecarBase(item.record.base, request.expectedPriorBase))
      return false;
  }
  return records.every(
    (item) =>
      covered.has(item.stored.key) ||
      item.stored.sessionOrder > greatestCoveredOrder,
  );
}

function coverageMatchesEvidence(
  record: SuccessorRecord["record"],
  covered: boolean,
  request: SidecarRecoveryAcknowledgementV1,
): boolean {
  if ("attemptId" in record) {
    return covered
      ? record.expectedSceneRevision < request.sceneRevision
      : record.expectedSceneRevision >= request.sceneRevision;
  }
  if (covered) return record.replacementGeneration <= request.sourceGeneration;
  return record.priorGeneration >= request.sourceGeneration;
}

function coveredKeys(
  request: SidecarRecoveryAcknowledgementV1,
): ReadonlySet<string> {
  return new Set([
    ...request.coveredAttemptIds.map((id) => `attempt:${id}`),
    ...request.coveredCheckpointIds.map((id) => `checkpoint:${id}`),
  ]);
}

function sameSuccessorSnapshot(
  current: readonly StoredRecoveryRecord[],
  snapshot: readonly SuccessorRecord[],
): boolean {
  if (current.length !== snapshot.length) return false;
  const expected = new Map(
    snapshot.map((item) => [item.stored.key, item.stored]),
  );
  return current.every((item) => {
    const prior = expected.get(item.key);
    return prior !== undefined && storedPayloadEqual(item, prior);
  });
}

function acknowledgementByteDelta(prepared: PreparedAcknowledgement): number {
  let delta = 0;
  for (const item of prepared.snapshot) {
    if (prepared.covered.has(item.stored.key)) delta -= item.stored.byteSize;
  }
  for (const item of prepared.retained) {
    delta += item.replacement.byteSize - item.prior.byteSize;
  }
  return delta;
}

function isSuccessor(
  record: RecoveryPersistenceRecordV1,
): record is RecoveryAttemptV1 | SourceCheckpointOperationV1 {
  return "attemptId" in record || "checkpointId" in record;
}
