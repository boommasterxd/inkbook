import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { SessionIdentity } from "../../../editor/session/session-port";
import type { DocumentRuntimePort } from "../../../persistence/worker/runtime/public";
import type { LoadedVaultDocument } from "./vault-document-loader";
import { reloadExternalDocument, restoreWorkerBaseline } from "./vault-document-recovery";
import {
  runVaultRecoveryOperation,
  type VaultRecoveryExecutorAccess,
} from "./vault-recovery-executor";

/** A read-only reload may replace its executor while the old model remains authoritative. */
export function reloadVaultSessionDocument(options: {
  readonly access: VaultRecoveryExecutorAccess;
  readonly adopt: (loaded: LoadedVaultDocument, executor: DocumentRuntimePort) => void;
  readonly identity: SessionIdentity;
  readonly load: (
    executor: DocumentRuntimePort,
    workerEpoch: number,
  ) => Promise<LoadedVaultDocument | undefined>;
  readonly releaseAutosave: () => void;
  readonly snapshot: () => InkSnapshotV1 | undefined;
  readonly stopped: () => boolean;
  readonly restoreStopped: () => boolean;
}): Promise<boolean> {
  return reloadExternalDocument({
    adopt: (loaded) => options.adopt(loaded, options.access.current()!.executor),
    load: () =>
      runVaultRecoveryOperation({
        access: options.access,
        run: options.load,
        stopped: options.stopped,
      }),
    releaseAutosave: options.releaseAutosave,
    restore: async () => {
      const snapshot = options.snapshot();
      const current = options.access.current();
      if (snapshot === undefined || current === undefined || options.restoreStopped()) return;
      await restoreWorkerBaseline({
        ...current,
        identity: options.identity,
        recoveryExecutor: options.access,
        revision: snapshot.revision,
        snapshot,
        stopped: options.restoreStopped,
      });
    },
    stopped: options.stopped,
  });
}
