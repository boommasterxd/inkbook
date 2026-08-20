import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
} from "../../application/note-session";
import {
  isTerminalRemoval,
  isValidNoteIdentity,
  sameSidecarBase,
  type ActiveRemovalRecoveryV1,
  type FinalizeRemovalRecoveryV1,
  type LoadActiveRemovalV1,
  type RemovalRecordV1,
} from "../../application/recovery";
import { requestResult, transactionDone } from "./idb-promises";
import {
  deleteExactNoteRecoveryRecords,
  prepareRecoveryDiscard,
  type ExpectedNoteRecoveryRecordV1,
  type PreparedRecoveryDiscardV1,
} from "./discard";
import {
  admitQueueRequest,
  admitRecoveryRecord,
  type AdmittedQueueRequest,
} from "./queue-admission";
import { decodeStoredRecord } from "./record-storage";
import { NOTE_KEY_INDEX, RECORDS_STORE } from "./schema";
import { runMutation } from "./transactions";
import type { WriteContext } from "./write-operations";

export type PreparedRemovalFinalizationV1 = PreparedRecoveryDiscardV1;

export function prepareRemovalFinalization(
  request: FinalizeRemovalRecoveryV1,
  context: WriteContext,
): CommandResultV1<PreparedRemovalFinalizationV1> {
  try {
    const input = readFinalizationRequest(request);
    if (!input.ok) return input;
    const admittedRemoval = admitRecoveryRecord(input.value.expectedRemoval);
    if (!admittedRemoval.ok) return admittedRemoval;
    const removal = admittedRemoval.value.record;
    if (!isTerminalRemoval(removal)) {
      return failure("invalid-command");
    }
    const discard = prepareRecoveryDiscard(
      {
        expectedAttempts: input.value.expectedAttempts,
        expectedBase: removal.sidecarBase,
        expectedCheckpoints: input.value.expectedCheckpoints,
        noteIdentity: removal.noteIdentity,
      },
      context,
    );
    if (!discard.ok) return discard;
    if (discard.value.expected.size + 1 > context.limits.noteRecords) {
      return failure("recovery-limit");
    }
    const retainedBytes =
      discard.value.retainedBytes + admittedRemoval.value.bytes.byteLength;
    if (retainedBytes > context.limits.noteBytes) {
      return failure("recovery-limit");
    }
    const key = `removal:${removal.removalId}`;
    const expected = new Map<string, ExpectedNoteRecoveryRecordV1>(
      discard.value.expected,
    );
    expected.set(
      key,
      Object.freeze({ encoded: admittedRemoval.value.bytes, key }),
    );
    return commandSuccess(
      Object.freeze({
        ...discard.value,
        expected,
        retainedBytes,
      }),
    );
  } catch {
    return failure("invalid-command");
  }
}

export function finalizeRemovalRecovery(
  context: WriteContext,
  prepared: PreparedRemovalFinalizationV1,
): Promise<CommandResultV1<void>> {
  return runMutation(
    context,
    "finalize-removal-recovery",
    async (transaction) =>
      deleteExactNoteRecoveryRecords(transaction, context, prepared),
  );
}

export function admitActiveRemovalLoad(
  request: LoadActiveRemovalV1,
): CommandResultV1<AdmittedQueueRequest<LoadActiveRemovalV1>> {
  try {
    if (!exactObject(request, ["noteIdentity"])) {
      return failure("invalid-command");
    }
    const admitted = admitQueueRequest(
      Object.freeze({
        noteIdentity: dataProperty<LoadActiveRemovalV1["noteIdentity"]>(
          request,
          "noteIdentity",
        ),
      }),
    );
    if (!admitted.ok) return admitted;
    if (!isValidNoteIdentity(admitted.value.value.noteIdentity)) {
      return failure("invalid-command");
    }
    return admitted;
  } catch {
    return failure("invalid-command");
  }
}

export async function loadActiveRemoval(
  context: WriteContext,
  request: LoadActiveRemovalV1,
): Promise<CommandResultV1<ActiveRemovalRecoveryV1 | null>> {
  try {
    const transaction = context.database.transaction(RECORDS_STORE, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult(
      transaction
        .objectStore(RECORDS_STORE)
        .index(NOTE_KEY_INDEX)
        .getAll(
          request.noteIdentity.vaultRelativeMarkdownPath,
          context.limits.noteRecords + 1,
        ) as IDBRequest<unknown[]>,
    );
    await done;
    if (values.length > context.limits.noteRecords) {
      return failure("recovery-limit");
    }
    const decoded = await Promise.all(
      values.map((value) => decodeStoredRecord(value)),
    );
    if (decoded.some((entry) => !entry.ok)) {
      return failure("recovery-unavailable");
    }
    const attempts: ActiveRemovalRecoveryV1["attempts"][number][] = [];
    const checkpoints: ActiveRemovalRecoveryV1["checkpoints"][number][] = [];
    const removals: RemovalRecordV1[] = [];
    for (const entry of decoded) {
      if (!entry.ok) continue;
      const record = entry.value.record;
      if ("attemptId" in record) attempts.push(record);
      else if ("checkpointId" in record) checkpoints.push(record);
      else if (record.kind === "annotation-removal") removals.push(record);
      else return failure("recovery-unavailable");
    }
    if (removals.length === 0) return commandSuccess(null);
    const removal = removals[0];
    if (
      removal === undefined ||
      removals.length !== 1 ||
      !validBundleIdentity(removal, request) ||
      [...attempts, ...checkpoints].some(
        (record) => !sameSidecarBase(record.base, removal.sidecarBase),
      )
    ) {
      return failure("recovery-unavailable");
    }
    attempts.sort(compareSessionOrder);
    checkpoints.sort(compareSessionOrder);
    return commandSuccess(
      Object.freeze({
        attempts: Object.freeze(attempts),
        checkpoints: Object.freeze(checkpoints),
        removal,
      }),
    );
  } catch {
    return failure("recovery-unavailable");
  }
}

function validBundleIdentity(
  removal: RemovalRecordV1,
  request: LoadActiveRemovalV1,
): boolean {
  return (
    removal.noteIdentity.vaultIdHint === request.noteIdentity.vaultIdHint &&
    removal.noteIdentity.vaultRelativeMarkdownPath ===
      request.noteIdentity.vaultRelativeMarkdownPath &&
    removal.sidecarBase.markdownPath ===
      request.noteIdentity.vaultRelativeMarkdownPath
  );
}

function compareSessionOrder(
  left: { readonly sessionOrder: number },
  right: { readonly sessionOrder: number },
): number {
  return left.sessionOrder - right.sessionOrder;
}

function readFinalizationRequest(
  value: unknown,
): CommandResultV1<FinalizeRemovalRecoveryV1> {
  if (
    !exactObject(value, [
      "expectedAttempts",
      "expectedCheckpoints",
      "expectedRemoval",
    ])
  ) {
    return failure("invalid-command");
  }
  return commandSuccess(
    Object.freeze({
      expectedAttempts: dataProperty(value, "expectedAttempts"),
      expectedCheckpoints: dataProperty(value, "expectedCheckpoints"),
      expectedRemoval: dataProperty(value, "expectedRemoval"),
    }) as FinalizeRemovalRecoveryV1,
  );
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => keys.includes(key))
  );
}

function dataProperty<T>(value: object, key: string): T {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor?.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError("Expected an enumerable data property.");
  }
  return descriptor.value as T;
}

function failure<T>(
  code: Exclude<CommandResultV1<never>, { readonly ok: true }>["code"],
): CommandResultV1<T> {
  return commandFailure(code);
}
