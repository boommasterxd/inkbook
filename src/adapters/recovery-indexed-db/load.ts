import type {
  CommandResultV1,
  Sha256Digest,
  SourceGeneration,
} from "../../application/note-session";
import {
  isNormalizedVaultPath,
  isValidNoteIdentity,
  sameSidecarBase,
  type RecoveryAttemptV1,
  type RecoveryLoadRequestV1,
  type RecoveryPersistenceRecordV1,
  type RecoverySnapshotV1,
  type RelocationRecordV1,
  type RemovalRecordV1,
  type SidecarBaseIdentityV1,
} from "../../application/recovery";
import {
  validateSourceCheckpointChain,
  type SourceCheckpointOperationV1,
} from "../../application/source-coordination";
import { readNoteAccounting } from "./accounting";
import { requestResult, transactionDone } from "./idb-promises";
import { decodeStoredRecord } from "./record-storage";
import {
  ACCOUNTING_STORE,
  NOTE_KEY_INDEX,
  PREFIX_SCOPE_INDEX,
  RECORDS_STORE,
  type StoredRecoveryRecord,
} from "./schema";
import type { IndexedDbRecoveryLimits } from "./types";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export async function loadNote(
  database: IDBDatabase,
  limits: IndexedDbRecoveryLimits,
  request: RecoveryLoadRequestV1,
): Promise<CommandResultV1<RecoverySnapshotV1>> {
  if (!validLoadRequest(request)) return { ok: false, code: "invalid-command" };
  try {
    const raw = await loadIndexedRecords(database, limits, request);
    if (!raw.ok) return raw;
    const decoded = await decodeRecords(raw.value.records);
    if (!decoded.ok) return decoded;
    if (
      raw.value.noteAccounting.records !== raw.value.noteRecords.length ||
      raw.value.noteAccounting.bytes !==
        raw.value.noteRecords.reduce((total, item) => total + item.byteSize, 0)
    ) {
      return { ok: false, code: "recovery-unavailable" };
    }
    const snapshot = classifyRecords(decoded.value);
    const selected = selectRecoveryEvidence(snapshot, request);
    if (selected === null) {
      return { ok: false, code: "sidecar-conflict" };
    }
    return { ok: true, value: selected };
  } catch {
    return { ok: false, code: "recovery-unavailable" };
  }
}

async function loadIndexedRecords(
  database: IDBDatabase,
  limits: IndexedDbRecoveryLimits,
  request: RecoveryLoadRequestV1,
): Promise<
  CommandResultV1<{
    records: readonly StoredRecoveryRecord[];
    noteRecords: readonly StoredRecoveryRecord[];
    noteAccounting: Awaited<ReturnType<typeof readNoteAccounting>>;
  }>
> {
  const noteKey = request.noteIdentity.vaultRelativeMarkdownPath;
  const transaction = database.transaction(
    [RECORDS_STORE, ACCOUNTING_STORE],
    "readonly",
  );
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORDS_STORE);
  const noteRecords = await requestResult(
    store
      .index(NOTE_KEY_INDEX)
      .getAll(noteKey, limits.noteRecords + 1) as IDBRequest<
      StoredRecoveryRecord[]
    >,
  );
  if (noteRecords.length > limits.noteRecords) {
    transaction.abort();
    await done.catch(() => undefined);
    return { ok: false, code: "recovery-limit" };
  }
  const prefixRecords = await loadPrefixRecords(store, noteKey, limits);
  const noteAccounting = await readNoteAccounting(transaction, noteKey);
  await done;
  const records = deduplicate([...noteRecords, ...prefixRecords]);
  return { ok: true, value: { noteAccounting, noteRecords, records } };
}

async function loadPrefixRecords(
  store: IDBObjectStore,
  noteKey: string,
  limits: IndexedDbRecoveryLimits,
): Promise<StoredRecoveryRecord[]> {
  const index = store.index(PREFIX_SCOPE_INDEX);
  const records: StoredRecoveryRecord[] = [];
  for (const scope of prefixScopesForPath(noteKey)) {
    const matching = await requestResult(
      index.getAll(scope, limits.globalRecords + 1) as IDBRequest<
        StoredRecoveryRecord[]
      >,
    );
    if (matching.length > limits.globalRecords) {
      throw new DOMException(
        "Recovery prefix index exceeds its limit.",
        "DataError",
      );
    }
    records.push(...matching);
  }
  return records;
}

async function decodeRecords(
  values: readonly StoredRecoveryRecord[],
): Promise<CommandResultV1<readonly RecoveryPersistenceRecordV1[]>> {
  const records: RecoveryPersistenceRecordV1[] = [];
  for (const value of values) {
    const decoded = await decodeStoredRecord(value, value.key);
    if (!decoded.ok) return decoded;
    records.push(decoded.value.record);
  }
  return { ok: true, value: records };
}

function classifyRecords(
  records: readonly RecoveryPersistenceRecordV1[],
): RecoverySnapshotV1 {
  const attempts: RecoveryAttemptV1[] = [];
  const checkpoints: SourceCheckpointOperationV1[] = [];
  const relocations: RelocationRecordV1[] = [];
  const removals: RemovalRecordV1[] = [];
  for (const record of records) {
    if ("attemptId" in record) attempts.push(record);
    else if ("checkpointId" in record) checkpoints.push(record);
    else if (record.kind === "annotation-removal") removals.push(record);
    else relocations.push(record);
  }
  attempts.sort(compareSessionOrder);
  checkpoints.sort(compareSessionOrder);
  return Object.freeze({ attempts, checkpoints, relocations, removals });
}

function selectRecoveryEvidence(
  snapshot: RecoverySnapshotV1,
  request: RecoveryLoadRequestV1,
): RecoverySnapshotV1 | null {
  if (
    [...snapshot.attempts, ...snapshot.checkpoints].some(
      (record) => !sameSidecarBase(record.base, request.base),
    )
  ) {
    return null;
  }
  return request.kind === "existing-sidecar"
    ? selectExistingEvidence(snapshot, request)
    : selectAbsentEvidence(snapshot, request);
}

function selectExistingEvidence(
  snapshot: RecoverySnapshotV1,
  request: Extract<RecoveryLoadRequestV1, { kind: "existing-sidecar" }>,
): RecoverySnapshotV1 | null {
  if (request.base.revision === null || request.base.rawTextSha256 === null) {
    return null;
  }
  return selectCheckpointPrefix(
    snapshot,
    request.base,
    request.validatedSidecarSourceGeneration,
    request.validatedSidecarSourceDigest,
    request.currentMarkdownDigest,
    request.currentMarkdownUtf16Length,
  );
}

function selectAbsentEvidence(
  snapshot: RecoverySnapshotV1,
  request: Extract<RecoveryLoadRequestV1, { kind: "absent-first-sidecar" }>,
): RecoverySnapshotV1 | null {
  if (
    request.base.revision !== null ||
    request.base.rawTextSha256 !== null ||
    request.base.vaultRelativePath !== request.expectedVaultRelativePath
  ) {
    return null;
  }
  if (snapshot.checkpoints.length === 0) {
    return snapshot.attempts.every(
      (attempt) =>
        attempt.expectedSourceDigest === request.currentMarkdownDigest,
    )
      ? snapshot
      : null;
  }
  const first = snapshot.checkpoints[0];
  if (first === undefined) return null;
  return selectCheckpointPrefix(
    snapshot,
    request.base,
    first.priorGeneration,
    first.priorDigest,
    request.currentMarkdownDigest,
    request.currentMarkdownUtf16Length,
  );
}

function selectCheckpointPrefix(
  snapshot: RecoverySnapshotV1,
  base: SidecarBaseIdentityV1,
  initialGeneration: SourceGeneration,
  initialDigest: Sha256Digest,
  currentDigest: Sha256Digest,
  currentLength: number,
): RecoverySnapshotV1 | null {
  const rootLength = snapshot.checkpoints[0]?.priorUtf16Length ?? currentLength;
  const validated = validateSourceCheckpointChain(
    {
      base,
      digest: initialDigest,
      generation: initialGeneration,
      utf16Length: rootLength,
    },
    snapshot.checkpoints,
  );
  if (!validated.ok) return null;
  const nodes = checkpointNodes(
    initialGeneration,
    initialDigest,
    rootLength,
    validated.value,
  );
  const matches = nodes.flatMap((node, index) =>
    node.digest === currentDigest && node.length === currentLength
      ? [index]
      : [],
  );
  if (matches.length !== 1) return null;
  const selectedCount = matches[0];
  if (selectedCount === undefined) return null;
  const selectedNodes = new Set(
    nodes
      .slice(0, selectedCount + 1)
      .map((node) => sourceNodeKey(node.generation, node.digest)),
  );
  if (
    snapshot.attempts.some(
      (attempt) =>
        !selectedNodes.has(
          sourceNodeKey(
            attempt.expectedSourceGeneration,
            attempt.expectedSourceDigest,
          ),
        ),
    )
  ) {
    return null;
  }
  return Object.freeze({
    ...snapshot,
    checkpoints: Object.freeze(snapshot.checkpoints.slice(0, selectedCount)),
  });
}

function checkpointNodes(
  initialGeneration: number,
  initialDigest: string,
  initialLength: number,
  checkpoints: readonly SourceCheckpointOperationV1[],
): readonly { generation: number; digest: string; length: number }[] {
  return [
    {
      digest: initialDigest,
      generation: initialGeneration,
      length: initialLength,
    },
    ...checkpoints.map((checkpoint) => ({
      digest: checkpoint.replacementDigest,
      generation: checkpoint.replacementGeneration,
      length: checkpoint.replacementUtf16Length,
    })),
  ];
}

function sourceNodeKey(generation: number, digest: string): string {
  return `${String(generation)}:${digest}`;
}

function validLoadRequest(request: RecoveryLoadRequestV1): boolean {
  const common =
    isValidNoteIdentity(request.noteIdentity) &&
    isNormalizedVaultPath(request.base.vaultRelativePath) &&
    request.base.markdownPath ===
      request.noteIdentity.vaultRelativeMarkdownPath &&
    DIGEST_PATTERN.test(request.currentMarkdownDigest) &&
    Number.isSafeInteger(request.currentMarkdownUtf16Length) &&
    request.currentMarkdownUtf16Length >= 0;
  if (!common) return false;
  if (request.kind === "existing-sidecar") {
    return (
      request.base.revision !== null &&
      request.base.rawTextSha256 !== null &&
      DIGEST_PATTERN.test(request.base.rawTextSha256) &&
      DIGEST_PATTERN.test(request.validatedSidecarSourceDigest)
    );
  }
  return (
    request.base.revision === null &&
    request.base.rawTextSha256 === null &&
    isNormalizedVaultPath(request.expectedVaultRelativePath)
  );
}

function prefixScopesForPath(path: string): readonly string[] {
  const segments = path.split("/");
  const scopes = ["storage-root", "folder:"];
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
    scopes.push(`folder:${prefix}`);
  }
  return scopes;
}

function deduplicate(
  records: readonly StoredRecoveryRecord[],
): readonly StoredRecoveryRecord[] {
  return [...new Map(records.map((record) => [record.key, record])).values()];
}

function compareSessionOrder(
  left: { readonly sessionOrder: number },
  right: { readonly sessionOrder: number },
): number {
  return left.sessionOrder - right.sessionOrder;
}
