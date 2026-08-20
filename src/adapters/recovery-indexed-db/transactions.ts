import type { CommandResultV1 } from "../../application/note-session";
import { transactionDone } from "./idb-promises";
import { ACCOUNTING_STORE, PREFIX_PLAN_STORE, RECORDS_STORE } from "./schema";
import type {
  IndexedDbRecoveryFaultInjector,
  RecoveryMutationKind,
} from "./types";

export interface MutationContext {
  readonly database: IDBDatabase;
  readonly faultInjector: IndexedDbRecoveryFaultInjector | undefined;
}

export async function runMutation<T>(
  context: MutationContext,
  operation: RecoveryMutationKind,
  work: (transaction: IDBTransaction) => Promise<CommandResultV1<T>>,
): Promise<CommandResultV1<T>> {
  let done: Promise<void> | undefined;
  try {
    const transaction = context.database.transaction(
      [RECORDS_STORE, ACCOUNTING_STORE, PREFIX_PLAN_STORE],
      "readwrite",
    );
    done = transactionDone(transaction);
    const result = await work(transaction);
    if (!result.ok) {
      transaction.abort();
      await done.catch(() => undefined);
      return result;
    }
    injectFault(context.faultInjector, operation, transaction);
    await done;
    return result;
  } catch (error) {
    await done?.catch(() => undefined);
    return {
      ok: false,
      code: isNamedError(error, "QuotaExceededError")
        ? "recovery-limit"
        : "recovery-unavailable",
    };
  }
}

function injectFault(
  injector: IndexedDbRecoveryFaultInjector | undefined,
  operation: RecoveryMutationKind,
  transaction: IDBTransaction,
): void {
  try {
    injector?.beforeCommit(operation, transaction);
  } catch (error) {
    transaction.abort();
    throw error;
  }
}

function isNamedError(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}
