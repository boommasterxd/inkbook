import type { DocumentRuntimePort } from "../../persistence/worker/runtime/public";

export interface VaultRecoveryExecutorAccess {
  readonly current: () =>
    { readonly executor: DocumentRuntimePort; readonly workerEpoch: number } | undefined;
  readonly recover: () => Promise<boolean>;
}

class RecoveryExecutorFailure extends Error {}

/** Retries executor rejection only; operation failures and host I/O remain untouched. */
export async function runVaultRecoveryOperation<Value>(options: {
  readonly access: VaultRecoveryExecutorAccess;
  readonly stopped: () => boolean;
  readonly run: (executor: DocumentRuntimePort, workerEpoch: number) => Promise<Value>;
}): Promise<Value | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = options.access.current();
    if (options.stopped() || current === undefined) return undefined;
    const executor: DocumentRuntimePort = {
      execute: async (request, observer) => {
        try {
          return await current.executor.execute(request, observer);
        } catch {
          throw new RecoveryExecutorFailure();
        }
      },
      terminate: () => current.executor.terminate(),
    };
    try {
      const result = await options.run(executor, current.workerEpoch);
      const latest = options.access.current();
      return !options.stopped() &&
        latest?.executor === current.executor &&
        latest.workerEpoch === current.workerEpoch
        ? result
        : undefined;
    } catch (error) {
      if (!(error instanceof RecoveryExecutorFailure)) throw error;
      if (options.stopped() || attempt === 2 || !(await options.access.recover())) return undefined;
    }
  }
  return undefined;
}
